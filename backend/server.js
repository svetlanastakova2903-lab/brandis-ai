import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";

import * as db from "./db.js";
import * as billing from "./billing.js";
import * as yookassa from "./yookassa.js";
import * as telegram from "./telegram.js";
import * as history from "./history.js";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors()); // при необходимости ограничь origin своим доменом на Tilda
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const DATA_MODE = process.env.DATA_MODE || "test"; // "test" | "real"
const PREFILTER_THRESHOLD = 200;
const MAX_CANDIDATES_TO_MODEL = 40;

// Модель и уровень усилий вынесены в переменные окружения: так можно откатиться или попробовать
// другой уровень прямо из панели Render, без правки кода и передеплоя из гита.
const CHAT_MODEL = process.env.CHAT_MODEL || "claude-sonnet-5";
const CHAT_EFFORT = process.env.CHAT_EFFORT || "medium";
const CHAT_MAX_TOKENS = Number(process.env.CHAT_MAX_TOKENS) || 2000;

// В карточках, которые уходят в модель, есть поля, которые она никогда не использует в ответе:
// ссылка на фото (это ~100 символов случайного адреса на карточку) и profile_url, который почти
// всегда дублирует contact. Плюс пустые поля. Всё это — чистый вес промпта на каждом сообщении.
function slimForModel(items) {
    return items.map((it) => {
          const out = {};
          for (const key of Object.keys(it)) {
                  const value = it[key];
                  if (key === "photo") continue;
                  if (key === "profile_url" && value === it.contact) continue;
                  if (value === null || value === undefined || value === "") continue;
                  if (Array.isArray(value) && value.length === 0) continue;
                  out[key] = value;
          }
          return out;
    });
}
// Публичный адрес этого сервиса — нужен для return_url платежей ЮKassa.
// На Render это https://brandis-ai.onrender.com (или свой домен, если подключишь).
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "http://localhost:" + PORT;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ---------- Загрузка баз ----------
function loadJson(fileNameReal, fileNameTest) {
    const file =
          DATA_MODE === "real"
        ? path.join(__dirname, "data", fileNameReal)
            : path.join(__dirname, "data", fileNameTest);
    if (!fs.existsSync(file)) {
          console.warn(`Файл базы не найден: ${file}, использую пустой список`);
          return [];
    }
    return JSON.parse(fs.readFileSync(file, "utf-8"));
}

let BLOGGERS = loadJson("bloggers.json", "bloggers.test.json");
let BRANDS = loadJson("brands.json", "brands.test.json");
console.log(`Загружено (${DATA_MODE}): блогеров ${BLOGGERS.length}, брендов ${BRANDS.length}`);

// JSON в репозитории — это только стартовый снимок: на Render диск эфемерный, поэтому
// раньше каталог обновлялся файлами и устаревал между коммитами. Теперь сервер сам
// подтягивает живой каталог с brandisapp.ru при старте и раз в несколько часов.
// Подменяем базу только если ответ выглядит здоровым — иначе продолжаем на снимке.
const CATALOG_REFRESH_MINUTES = Number(process.env.CATALOG_REFRESH_MINUTES || 360);

async function refreshCatalogInMemory(reason) {
    try {
        const { fetchCatalog } = await import("./refreshCatalog.js");
        const { bloggers, brands } = await fetchCatalog();
        const sane =
            bloggers.length > 0 &&
            brands.length > 0 &&
            bloggers.length >= BLOGGERS.length * 0.8 &&
            brands.length >= BRANDS.length * 0.8;
        if (!sane) {
            console.warn(
                `[catalog] ${reason}: ответ выглядит подозрительно (блогеров ${bloggers.length}, брендов ${brands.length} ` +
                `против ${BLOGGERS.length}/${BRANDS.length}) — оставляю прежнюю базу`
            );
            return;
        }
        BLOGGERS = bloggers;
        BRANDS = brands;
        console.log(`[catalog] ${reason}: обновлено — блогеров ${BLOGGERS.length}, брендов ${BRANDS.length}`);
    } catch (err) {
        console.warn(`[catalog] ${reason}: не удалось обновить (${err.message}) — работаю на прежней базе`);
    }
}

if (DATA_MODE === "real") {
    refreshCatalogInMemory("старт");
    setInterval(() => refreshCatalogInMemory("по расписанию"), CATALOG_REFRESH_MINUTES * 60 * 1000).unref();
}

// ---------- Логирование диалогов (старый плоский лог, для обратной совместимости с /api/chat v1) ----------
const LOG_FILE = path.join(__dirname, "logs.jsonl");
function logInteraction(entry) {
    fs.appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", () => {});
}

// ---------- Предфильтрация базы ----------
function extractLastUserText(messages) {
    const last = [...messages].reverse().find((m) => m.role === "user");
    return last?.content || "";
}

// Русский язык склоняет города по падежам ("Москва" -> "в Москве", "из Москвы"),
// поэтому точное сравнение подстроки почти всегда промахивалось. Сравниваем по "основе"
// слова (без последних 1-2 букв), это покрывает подавляющее большинство падежных форм.
function cityStem(cityLower) {
    return cityLower.length > 4 ? cityLower.slice(0, -2) : cityLower;
}

function detectCity(entities, text) {
    // Поле city может содержать несколько городов через ";" (например "Рязань;Москва") —
  // раньше это никогда не матчилось, разбиваем на отдельные города.
  const cities = [
        ...new Set(entities.flatMap((b) => (b.city || "").split(";").map((s) => s.trim()).filter(Boolean))),
      ];
    return cities.find((c) => {
          const cl = c.toLowerCase();
          return text.includes(cl) || text.includes(cityStem(cl));
    });
}

function cityMatches(cityField, matchedCity) {
    return (cityField || "")
      .split(";")
      .map((s) => s.trim())
      .includes(matchedCity);
}

function detectNiches(entities, text) {
    const niches = [...new Set(entities.flatMap((b) => b.niche || []))];
    return niches.filter((n) => {
          const words = n.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
          return words.some((w) => text.includes(w));
    });
}

function detectFollowerBounds(text) {
    let maxFollowers = null;
    let minFollowers = null;
    const maxMatch = text.match(/до\s*(\d+)\s*(k|к|тыс)?/);
    if (maxMatch) {
          let n = parseInt(maxMatch[1], 10);
          if (maxMatch[2]) n *= 1000;
          maxFollowers = n;
    }
    const minMatch = text.match(/от\s*(\d+)\s*(k|к|тыс)?/);
    if (minMatch) {
          let n = parseInt(minMatch[1], 10);
          if (minMatch[2]) n *= 1000;
          minFollowers = n;
    }
    return { minFollowers, maxFollowers };
}

function prefilterEntities(all, messages, { isBlogger }) {
    if (all.length <= PREFILTER_THRESHOLD) return all;

  const text = messages
      .map((m) => m.content)
      .join(" ")
      .toLowerCase();

  const matchedCity = detectCity(all, text);
    const matchedNiches = detectNiches(all, text);
    const { minFollowers, maxFollowers } = detectFollowerBounds(text);

  let candidates = all;
    if (matchedCity) candidates = candidates.filter((b) => cityMatches(b.city, matchedCity));
    if (matchedNiches.length) {
          const filtered = candidates.filter((b) => (b.niche || []).some((n) => matchedNiches.includes(n)));
          if (filtered.length) candidates = filtered;
    }
    if (isBlogger) {
          if (maxFollowers) candidates = candidates.filter((b) => !b.followers || b.followers <= maxFollowers);
          if (minFollowers) candidates = candidates.filter((b) => !b.followers || b.followers >= minFollowers);
    }

  if (candidates.length === 0) candidates = matchedCity ? all.filter((b) => b.city === matchedCity) : all;
    if (candidates.length === 0) candidates = all;

  return candidates.slice(0, MAX_CANDIDATES_TO_MODEL);
}

// ---------- System prompt (общая часть для v1 и v2) ----------
function buildBaseSystemPrompt(bloggerCandidates, brandCandidates) {
    return `Ты — AI-помощник маркетплейса инфлюенсер-маркетинга Brandis (Россия, фокус: Москва, Санкт-Петербург, Рязань и другие города РФ).

    Твоя задача — сводить друг с другом три типа пользователей:
    1. БРЕНД/БИЗНЕС ищет блогера для рекламы (за деньги или бартер) — используй таблицу БЛОГЕРЫ.
    2. БЛОГЕР ищет бренд/бизнес для сотрудничества, в том числе бартер (товар/услуга взамен рекламы) — используй таблицу БРЕНДЫ.
    3. БЛОГЕР ищет другого блогера для кросс-промо / совместной коллаборации / обмена аудиторией — используй таблицу БЛОГЕРЫ, но:
       - исключи из результатов самого пользователя, если он назвал свой ник/аккаунт;
          - предпочитай близкие или смежные ниши и, по возможности, тот же город;
             - мы не знаем, кто именно открыт к кросс-промо: такого поля в базе нет. Предлагай подходящих по нише и честно говори, что договариваться нужно напрямую.

             ШАГ 0 — ОПРЕДЕЛИ НАМЕРЕНИЕ:
             Сначала пойми по сообщению пользователя, кто он: бренд/бизнес ищет рекламу у блогеров, или блогер ищет бренд/бартер, или блогер ищет кросс-промо с другим блогером.
             Если это не очевидно из сообщения — задай ОДИН короткий уточняющий вопрос по типу "Ты бренд ищешь блогера, или блогер ищешь бренд/коллаб?" и не делай рекомендаций, пока не поймёшь намерение.

             ОБЩАЯ СТАТИСТИКА БАЗЫ (это ТОЧНЫЕ цифры по всей базе, используй их для любых вопросов вида "сколько всего" —
             базы ниже в этом промпте — только отобранное подмножество под текущий запрос, а не вся база, поэтому цифры
             "сколько всего" никогда не считай по количеству карточек ниже, только по этим цифрам):
             Всего блогеров в базе: ${BLOGGERS.length}. Всего брендов в базе: ${BRANDS.length}.

             ПРАВИЛА:
             1. Отвечай ТОЛЬКО на основе данных из таблиц ниже (JSON) и статистики выше. Никогда не придумывай блогеров, бренды, цифры или контакт, которых нет в данных.
             2. Если запрос слишком общий (не хватает города, ниши, подписчиков или намерения) — задай ОДИН уточняющий вопрос, не больше.
             3. Если среди присланных тебе кандидатов подходящих вариантов нет, НО по общей статистике база большая и могла отфильтроваться — не утверждай категорично "таких вообще нет". Скажи, что среди отобранных вариантов не нашлось подходящих, и предложи уточнить критерии (город/ниша) или попробовать ещё раз.
             4. Рекомендуй 2-5 самых подходящих вариантов, коротко объясняя, почему каждый подходит.
                     5. Пиши порусски, коротко, дружелюбно, как локальный эксперт, а не корпоративный бот. Без markdown-таблиц и заголовков, без излишнего форматирования — обычным текстом, можно с эмодзи изредка. НИКОГДА не используй звёздочки для жирного текста (две звёздочки подряд с двух сторон от текста) — фронтенд не превращает их в жирный шрифт, они показываются как есть, буквально со звёздочками, и это выглядит некрасиво. Пиши обычным текстом, без звёздочек.
             6. Если у блогера/бренда не указана цена, бюджет или engagement — не выдумывай их, просто не упоминай эти поля.
                     6.1. Условия сотрудничества мы НЕ знаем ни по одной карточке: в базе нет полей "работает за деньги", "готов на бартер", "открыт к кросс-промо". Никогда не утверждай и не предполагай, на каких условиях кто-то работает. Если человек спрашивает про бартер, оплату или условия — отвечай честно и ободряюще, примерно так: точных условий не знаю, это выясняется в личном сообщении, но договориться можно почти с кем угодно — многие открыты и к бартеру, и к деньгам, всё решается в переписке. И сразу предлагай помощь: "Хотите, составлю сообщение, которое можно им отправить?" Если человек соглашается — напиши готовый текст первого сообщения от его имени: коротко, по-человечески, с конкретным предложением, без канцелярита и без выдуманных цифр.
                     6.2. Если у карточки не указан город — значит человек просто не заполнил это поле. Не выдумывай город и не приписывай человеку Москву по умолчанию; если пользователь спрашивал про конкретный город, честно скажи, что у этой карточки город не указан.
                     7. Всегда указывай контакт, если он есть в данных, чтобы пользователь мог написать напрямую. Оформляй его ТОЛЬКО как markdown-ссылку вида [текст](ссылка) — фронтенд превращает такие ссылки в кликабельные. В качестве текста ссылки используй имя блогера/бренда или его ник (например @nickname, если он виден в самой ссылке-контакте) — НИКОГДА не используй в качестве текста ссылки голый URL целиком (не пиши [https://instagram.com/nickname](https://instagram.com/nickname) — пиши [nickname](https://instagram.com/nickname) или [@nickname](https://instagram.com/nickname)). Никогда не оборачивай ссылку в звёздочки. Если контакта нет в данных — не выдумывай и не подставляй ссылку.

             ОТОБРАННЫЕ КАНДИДАТЫ ПОД ТЕКУЩИЙ ЗАПРОС (подмножество базы, НЕ вся база — см. общую статистику выше):

             БАЗА БЛОГГЕРОВ (JSON, для сценариев 1 и 3):
             ${JSON.stringify(slimForModel(bloggerCandidates), null, 0)}

             БАЗА БРЕНДОВ (JSON, для сценария 2):
             ${JSON.stringify(slimForModel(brandCandidates), null, 0)}`;
}

// v2 добавляет: краткое саммари предыдущей истории (если есть) + обязательный вызов инструмента
// deliver_recommendations при выдаче итоговой подборки — это единственный надёжный сигнал
// "поиск завершён" для биллинга (считаем по нему, а не по количеству сообщений).
// Пишем реальный расход токенов в логи: без этого себестоимость подбора приходится оценивать
// на глаз, а по логам её видно точно.
function logUsage(tag, response, extra = {}) {
    const u = response?.usage || {};
    console.log(
          `[usage] ${tag} model=${CHAT_MODEL} effort=${CHAT_EFFORT} in=${u.input_tokens} out=${u.output_tokens}` +
          (extra.systemChars ? ` sysChars=${extra.systemChars}` : "") +
          (extra.turnsSinceSearch !== undefined ? ` turn=${extra.turnsSinceSearch}` : "")
    );
}

function buildSystemPromptV2(bloggerCandidates, brandCandidates, summary, turnsSinceSearch = 0) {
    const base = buildBaseSystemPrompt(bloggerCandidates, brandCandidates);
    const summaryBlock = summary
      ? `\n\nКОНТЕКСТ ПРЕДЫДУЩЕГО ДИАЛОГА С ЭТИМ ПОЛЬЗОВАТЕЛЕМ (сжатое саммари более ранней переписки, самые новые сообщения ниже идут дословно):\n${summary}`
          : "";
    const toolRule = `\n\n9. ОБЯЗАТЕЛЬНО: когда даёшь пользователю ИТОГОВУЮ подборку (2-5 вариантов, правило 4) — В ТОМ ЖЕ ОТВЕТЕ вызови инструмент deliver_recommendations с указанием intent и count, ПОМИМО обычного текстового ответа. Если вместо подборки задаёшь уточняющий вопрос или говоришь, что вариантов нет — НЕ вызывай инструмент.`;
    // Пользователь про потолок не знает — он живёт только здесь, в промпте. Смысл: не дать
    // диалогу бесконечно ходить по уточнениям, потому что каждое сообщение — отдельный вызов модели.
    let pressure = "";
    if (turnsSinceSearch >= billing.TURNS_MUST_DELIVER) {
      pressure = `\n\n10. ВАЖНО: в этом запросе уже было много уточнений. Больше НЕ задавай уточняющих вопросов. Прямо в этом ответе дай лучшую подборку из имеющихся кандидатов (2-5 вариантов) и вызови deliver_recommendations. Если для идеального совпадения данных не хватает — всё равно покажи самые близкие варианты и честно скажи, чем они отличаются от запроса.`;
    } else if (turnsSinceSearch >= billing.TURNS_SOFT_NUDGE) {
      pressure = `\n\n10. Учти: уточнений в этом запросе уже было достаточно. Постарайся в этом ответе именно дать подборку, а не задать очередной вопрос. Если чего-то не хватает — сделай разумное предположение вслух и покажи варианты.`;
    }
    return base + summaryBlock + toolRule + pressure;
}

const DELIVER_RECOMMENDATIONS_TOOL = {
    name: "deliver_recommendations",
    description:
          "Вызови КАЖДЫЙ РАЗ, когда даёшь пользователю итоговую подборку блогеров/брендов (не уточняющий вопрос и не сообщение об отсутствии вариантов).",
    input_schema: {
          type: "object",
          properties: {
                  intent: {
                            type: "string",
                            enum: ["brand_to_blogger", "blogger_to_brand", "blogger_to_blogger"],
                            description: "Какой из трёх сценариев сработал в этой подборке",
                  },
                  count: { type: "integer", description: "Сколько вариантов рекомендовано в этом ответе" },
          },
          required: ["intent", "count"],
    },
};

// =========================================================================================
// v1 — СТАРЫЙ эндпоинт, без биллинга и авторизации. Оставлен как есть для обратной совместимости
// со встроенным виджетом frontend/widget.html, который пока ещё может быть встроен на Tilda.
// Как только сайт полностью перейдёт на новую страницу чата (frontend/chat.html) — можно удалить
// и этот эндпоинт, и старый виджет.
// =========================================================================================
app.post("/api/chat", async (req, res) => {
    try {
          const { messages } = req.body;
          if (!Array.isArray(messages) || messages.length === 0) {
                  return res.status(400).json({ error: "messages[] обязателен" });
          }

      const bloggerCandidates = prefilterEntities(BLOGGERS, messages, { isBlogger: true });
          const brandCandidates = prefilterEntities(BRANDS, messages, { isBlogger: false });
          const system = buildBaseSystemPrompt(bloggerCandidates, brandCandidates);

      const claudeMessages = messages
            .filter((m) => m.role === "user" || m.role === "assistant")
            .map((m) => ({ role: m.role, content: m.content }));

      // Инструмент передаём и здесь: биллинга в v1 нет, но по полю searchCompleted в ответе
      // можно проверить на живой модели, что она вызывает deliver_recommendations — не тратя
      // при этом подбор реального пользователя.
      const response = await anthropic.messages.create({
              model: CHAT_MODEL,
              max_tokens: CHAT_MAX_TOKENS,
              output_config: { effort: CHAT_EFFORT },
              system,
              messages: claudeMessages,
              tools: [DELIVER_RECOMMENDATIONS_TOOL],
      });
      logUsage("v1", response);
      const v1ToolUse = response.content.find((b) => b.type === "tool_use" && b.name === "deliver_recommendations");

      const replyText = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");

      logInteraction({
              userMessage: extractLastUserText(messages),
              bloggerCandidatesCount: bloggerCandidates.length,
              brandCandidatesCount: brandCandidates.length,
              reply: replyText,
      });

      res.json({ reply: replyText, searchCompleted: !!v1ToolUse, intent: v1ToolUse?.input?.intent });
    } catch (err) {
          console.error("Ошибка /api/chat:", err);
          res.status(500).json({ error: "Что-то пошло не так. Попробуй ещё раз чуть позже." });
    }
});

app.get("/api/health", (req, res) => {
    res.json({
          ok: true,
          dataMode: DATA_MODE,
          bloggersCount: BLOGGERS.length,
          brandsCount: BRANDS.length,
          dbConfigured: !!db.pool,
    });
});

app.get("/api/logs", (req, res) => {
    // Простая аналитика: последние N запросов. В проде стоит защитить паролем.
          if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
    const last = lines.slice(-200).map((l) => JSON.parse(l));
    res.json(last);
});

// =========================================================================================
// v2 — НОВЫЙ флоу: привязка через Telegram, лимиты, оплата (ЮKassa), персистентная история.
// Используется новой страницей frontend/chat.html.
// =========================================================================================

function billingSnapshot(user) {
    return {
          subscriptionStatus: user.subscription_status,
          searchesUsedThisPeriod: user.searches_used_this_period,
          subscriptionIncludedSearches: billing.SUBSCRIPTION_INCLUDED_SEARCHES,
          addonSearchesRemaining: user.addon_searches_remaining,
          freeSearchUsed: user.free_search_used,
          subscriptionPeriodEnd: user.subscription_period_end,
    };
}

// Достаёт access_token из заголовка Authorization: Bearer <token>, либо из тела/query (проще для
// фронтенда без сложных http-клиентов), находит по нему пользователя и кладёт в req.user/req.telegramId.
// telegram_id САМ ПО СЕБЕ нигде ниже как удостоверение личности не принимается — только этот токен,
// иначе любой, кто узнал чужой telegram_id, мог бы читать чужую историю переписки и статус подписки.
async function requireAuth(req, res, next) {
    try {
          const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
          const token = bearer || req.body?.access_token || req.query?.access_token;
          if (!token) return res.status(401).json({ error: "Требуется авторизация (access_token)." });
          const user = await db.getUserByAccessToken(token);
          if (!user) return res.status(401).json({ error: "Недействительный токен, войдите заново." });
          req.user = user;
          req.telegramId = user.telegram_id;
          next();
    } catch (err) {
          console.error("Ошибка requireAuth:", err);
          res.status(500).json({ error: "Ошибка авторизации." });
    }
}

// ---------- Авторизация через Telegram ----------
app.post("/api/auth/start", async (req, res) => {
    try {
          const sessionCode = req.body?.session_code || crypto.randomUUID();
          await db.createPendingLink(sessionCode);
          const botUsername = await telegram.getBotUsername();
          res.json({ session_code: sessionCode, bot_username: botUsername });
    } catch (err) {
          console.error("Ошибка /api/auth/start:", err);
          res.status(500).json({ error: "Не удалось начать авторизацию." });
    }
});

app.get("/api/auth/status", async (req, res) => {
    try {
          const sessionCode = req.query.session_code;
          if (!sessionCode) return res.status(400).json({ error: "session_code обязателен" });
          const link = await db.getPendingLink(sessionCode);
          if (!link) return res.status(404).json({ error: "Ссылка не найдена или устарела" });
          if (link.linked_at) {
                  const user = await db.getUser(link.telegram_id);
                  return res.json({ linked: true, access_token: user?.access_token || null });
          }
          res.json({ linked: false });
    } catch (err) {
          console.error("Ошибка /api/auth/status:", err);
          res.status(500).json({ error: "Не удалось проверить статус авторизации." });
    }
});

// Вебхук от Telegram — получает /start <session_code> и привязывает telegram_id к сессии.
app.post("/api/telegram/webhook", async (req, res) => {
    try {
          await telegram.handleUpdate(req.body, {
                  onStartLink: async ({ sessionCode, telegramId, username, firstName }) => {
                            const link = await db.getPendingLink(sessionCode);
                            if (!link) return { linked: false };
                            let user = await db.getOrCreateUser(telegramId, { username, firstName });
                            if (!user.access_token) {
                                        user = await db.updateUser(telegramId, { access_token: crypto.randomUUID() + crypto.randomUUID() });
                            }
                            const updated = await db.completePendingLink(sessionCode, telegramId);
                            return { linked: !!updated };
                  },
          });
    } catch (err) {
          console.error("Ошибка обработки Telegram webhook:", err);
    }
    // Telegram ожидает быстрый 200 в любом случае, иначе будет повторять доставку.
           res.sendStatus(200);
});

// ---------- Бутстрап страницы чата: история + текущий статус биллинга ----------
app.get("/api/chat/bootstrap", requireAuth, async (req, res) => {
    try {
          const telegramId = req.telegramId;
          const messages = await db.getAllMessages(telegramId);
          res.json({
                  history: messages.map((m) => ({ role: m.role, content: m.content })),
                  billing: billingSnapshot(req.user),
          });
    } catch (err) {
          console.error("Ошибка /api/chat/bootstrap:", err);
          res.status(500).json({ error: "Не удалось загрузить историю." });
    }
});

// ---------- Основной чат v2: с лимитами и биллингом ----------
app.post("/api/v2/chat", requireAuth, async (req, res) => {
    try {
          const telegramId = req.telegramId;
          const message = (req.body?.message || "").toString().trim();
          if (!message) return res.status(400).json({ error: "message обязателен" });

      // Оппортунистическое продление подписок, чей период закончился — см. billing.sweepDueRenewals.
      await billing.sweepDueRenewals();

      let user = await db.getUser(telegramId); // перечитываем — sweepDueRenewals могла обновить состояние

      const access = billing.checkAccess(user);
          if (!access.allowed) {
                  return res.status(402).json({
                            error: "limit_reached",
                            reason: access.reason,
                            message: access.message,
                            cta: access.cta,
                            billing: billingSnapshot(user),
                  });
          }

      const { summary, recentMessages } = await history.getContextForUser(telegramId);
          const messagesForPrefilter = [...recentMessages, { role: "user", content: message }];

      const bloggerCandidates = prefilterEntities(BLOGGERS, messagesForPrefilter, { isBlogger: true });
          const brandCandidates = prefilterEntities(BRANDS, messagesForPrefilter, { isBlogger: false });
      const turnsSinceSearch = user.turns_since_search || 0;
          const system = buildSystemPromptV2(bloggerCandidates, brandCandidates, summary, turnsSinceSearch);

      const claudeMessages = [...recentMessages, { role: "user", content: message }];

      const response = await anthropic.messages.create({
              model: CHAT_MODEL,
              max_tokens: CHAT_MAX_TOKENS,
              output_config: { effort: CHAT_EFFORT },
              system,
              messages: claudeMessages,
              tools: [DELIVER_RECOMMENDATIONS_TOOL],
      });
      logUsage("v2", response, { systemChars: system.length, turnsSinceSearch });

      const replyText = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");

      const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "deliver_recommendations");
          const searchCompleted = !!toolUse;

      // Тихий предохранитель: если модель и после прямого указания не выдала подборку, всё равно
      // закрываем запрос — иначе один разговорчивый пользователь может стоить сколько угодно.
      const forcedClose = !searchCompleted && turnsSinceSearch + 1 >= billing.TURNS_HARD_CAP;

      if (searchCompleted || forcedClose) {
              await billing.recordSearchCompleted(telegramId, {
                        billedAs: access.billedAs,
                        intent: toolUse?.input?.intent,
                        model: CHAT_MODEL,
                        inputTokens: response.usage?.input_tokens,
                        outputTokens: response.usage?.output_tokens,
              });
              user = await db.getUser(telegramId); // обновлённые счётчики для ответа
      } else {
              await db.query(
                        `UPDATE users SET turns_since_search = turns_since_search + 1, updated_at = now() WHERE telegram_id = $1`,
                        [telegramId]
              );
      }

      res.json({
              reply: replyText || "Извини, не получилось сформулировать ответ. Попробуй переформулировать запрос.",
              searchCompleted,
              billing: billingSnapshot(user),
      });

      // Сохранение истории и (при необходимости) пересжатие саммари — после ответа, не блокируя пользователя.
      history.appendExchangeAndMaybeSummarize(telegramId, message, replyText || "").catch((err) => {
              console.error(`Не удалось сохранить историю для telegram_id=${telegramId}:`, err);
      });
    } catch (err) {
          console.error("Ошибка /api/v2/chat:", err);
          res.status(500).json({ error: "Что-то пошло не так. Попробуй ещё раз чуть позже." });
    }
});

// ---------- Оплата: ЮKassa ----------
app.post("/api/billing/subscribe", requireAuth, async (req, res) => {
    try {
          const returnUrl = (process.env.SITE_BASE_URL || PUBLIC_BASE_URL) + "/ai?payment=return";
          const confirmationUrl = await billing.startSubscription(req.telegramId, returnUrl);
          res.json({ confirmation_url: confirmationUrl });
    } catch (err) {
          console.error("Ошибка /api/billing/subscribe:", err);
          res.status(500).json({ error: "Не удалось создать платёж подписки." });
    }
});

// ---------- Избранное ----------
// Своя замена корзине Tilda Store: она была привязана к тильдовской регистрации, а вход у нас
// через Telegram. Здесь карточка каталога сохраняется за конкретным telegram_id.
const FAV_LIMIT = 500;

app.get("/api/favorites", requireAuth, async (req, res) => {
    try {
          res.json({ favorites: await db.listFavorites(req.telegramId) });
    } catch (err) {
          console.error("Ошибка GET /api/favorites:", err);
          res.status(500).json({ error: "Не удалось получить избранное." });
    }
});

app.post("/api/favorites", requireAuth, async (req, res) => {
    try {
          const productUid = String(req.body?.uid || "").trim();
          const title = String(req.body?.title || "").trim();
          if (!productUid || !title) return res.status(400).json({ error: "uid и title обязательны" });

      const current = await db.listFavorites(req.telegramId);
          if (current.length >= FAV_LIMIT && !current.some((f) => f.product_uid === productUid)) {
                  return res.status(400).json({ error: `В избранном уже ${FAV_LIMIT} карточек — больше не помещается.` });
          }

      const favorite = await db.addFavorite(req.telegramId, {
              productUid,
              title: title.slice(0, 300),
              url: String(req.body?.url || "").slice(0, 500),
              photo: String(req.body?.photo || "").slice(0, 500),
              category: String(req.body?.category || "").slice(0, 100),
      });
          res.json({ favorite });
    } catch (err) {
          console.error("Ошибка POST /api/favorites:", err);
          res.status(500).json({ error: "Не удалось добавить в избранное." });
    }
});

app.delete("/api/favorites/:uid", requireAuth, async (req, res) => {
    try {
          const removed = await db.removeFavorite(req.telegramId, String(req.params.uid || ""));
          res.json({ removed });
    } catch (err) {
          console.error("Ошибка DELETE /api/favorites:", err);
          res.status(500).json({ error: "Не удалось убрать из избранного." });
    }
});

// Каталог пакетов — чтобы цена жила только в бэкенде, а фронтенд её просто показывал.
app.get("/api/billing/packs", (req, res) => {
    res.json({ packs: billing.PACKS });
});

// Куда вернуть человека после оплаты. Путь берём из белого списка, а не из тела запроса,
// чтобы не превратить это в открытый редирект.
const RETURN_PATHS = { ai: "/ai?payment=return", me: "/me?payment=return" };

app.post("/api/billing/pack", requireAuth, async (req, res) => {
    try {
          const path = RETURN_PATHS[req.body?.from] || RETURN_PATHS.ai;
          const returnUrl = (process.env.SITE_BASE_URL || PUBLIC_BASE_URL) + path;
          const confirmationUrl = await billing.startPackPurchase(req.telegramId, req.body?.pack, returnUrl);
          res.json({ confirmation_url: confirmationUrl });
    } catch (err) {
          console.error("Ошибка /api/billing/pack:", err);
          res.status(400).json({ error: err.message || "Не удалось создать платёж за пакет." });
    }
});

// Старый путь — оставлен для уже открытых вкладок со старым фронтендом.
app.post("/api/billing/addon", requireAuth, async (req, res) => {
    try {
          const returnUrl = (process.env.SITE_BASE_URL || PUBLIC_BASE_URL) + "/ai?payment=return";
          const confirmationUrl = await billing.startAddonPurchase(req.telegramId, returnUrl);
          res.json({ confirmation_url: confirmationUrl });
    } catch (err) {
          console.error("Ошибка /api/billing/addon:", err);
          res.status(400).json({ error: err.message || "Не удалось создать платёж за пакет." });
    }
});

app.get("/api/billing/status", requireAuth, async (req, res) => {
    try {
          res.json({ billing: billingSnapshot(req.user) });
    } catch (err) {
          console.error("Ошибка /api/billing/status:", err);
          res.status(500).json({ error: "Не удалось получить статус." });
    }
});

// Вебхук ЮKassa. Всегда отвечаем 200 при штатной обработке (успешной ИЛИ неуспешной оплате) —
// ЮKassa не разбирает тело/заголовки ответа, ей важен только статус-код. При ЛЮБОЙ ошибке нашей
// обработки отвечаем 5xx — тогда ЮKassa повторит доставку в течение 24 часов, и мы не потеряем платёж.
app.post("/api/billing/webhook", async (req, res) => {
    try {
          const forwardedFor = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress;
          if (!yookassa.isYookassaIp(forwardedFor)) {
                  console.warn("Вебхук ЮKassa с неожиданного IP (обрабатываю всё равно, полагаясь на проверку статуса ниже):", forwardedFor);
          }

      const objId = req.body?.object?.id;
          if (!objId) return res.sendStatus(200); // не похоже на платёжное уведомление — игнорируем

      // Не доверяем телу вебхука напрямую — авторитетно перепроверяем статус в самой ЮKassa.
      const payment = await yookassa.getPayment(objId);

      const existing = await db.getPaymentByYookassaId(payment.id);
          if (existing && existing.status === payment.status) {
                  return res.sendStatus(200); // уже обработан этот статус — идемпотентность на повторную доставку
          }

      await db.updatePaymentStatus(payment.id, payment.status, payment);

      if (payment.status === "succeeded") {
              await billing.applySucceededPayment(payment);
      } else if (payment.status === "canceled") {
              await billing.applyFailedPayment(payment);
      }

      res.sendStatus(200);
    } catch (err) {
          console.error("Ошибка обработки вебхука ЮKassa:", err);
          res.sendStatus(500); // просим ЮKassa повторить доставку позже
    }
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

async function start() {
    try {
          await db.initSchema();
    } catch (err) {
          console.error("Не удалось инициализировать схему БД (проверь DATABASE_URL):", err);
    }

  if (process.env.TELEGRAM_BOT_TOKEN) {
        try {
                // Идемпотентно — safe вызывать при каждом старте (а на бесплатном Render это бывает часто).
          await telegram.setWebhook(`${PUBLIC_BASE_URL}/api/telegram/webhook`);
                console.log("Telegram webhook зарегистрирован на", `${PUBLIC_BASE_URL}/api/telegram/webhook`);
        } catch (err) {
                console.error("Не удалось зарегистрировать Telegram webhook:", err);
        }
  }

  app.listen(PORT, () => {
        console.log(`Brandis AI backend запущен на порту ${PORT}`);
  });
}

start();
