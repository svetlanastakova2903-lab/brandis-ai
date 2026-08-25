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
          - показывай только блогеров, у кого looking_for включает "cross_promo_with_blogger";
             - предпочитай близкие или смежные ниши.

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
                     7. Всегда указывай контакт, если он есть в данных, чтобы пользователь мог написать напрямую. Оформляй его ТОЛЬКО как markdown-ссылку вида [текст](ссылка) — фронтенд превращает такие ссылки в кликабельные. В качестве текста ссылки используй имя блогера/бренда или его ник (например @nickname, если он виден в самой ссылке-контакте) — НИКОГДА не используй в качестве текста ссылки голый URL целиком (не пиши [https://instagram.com/nickname](https://instagram.com/nickname) — пиши [nickname](https://instagram.com/nickname) или [@nickname](https://instagram.com/nickname)). Никогда не оборачивай ссылку в звёздочки. Если контакта нет в данных — не выдумывай и не подставляй ссылку.

             ОТОБРАННЫЕ КАНДИДАТЫ ПОД ТЕКУЩИЙ ЗАПРОС (подмножество базы, НЕ вся база — см. общую статистику выше):

             БАЗА БЛОГГЕРОВ (JSON, для сценариев 1 и 3):
             ${JSON.stringify(bloggerCandidates, null, 0)}

             БАЗА БРЕНДОВ (JSON, для сценария 2):
             ${JSON.stringify(brandCandidates, null, 0)}`;
}

// v2 добавляет: краткое саммари предыдущей истории (если есть) + обязательный вызов инструмента
// deliver_recommendations при выдаче итоговой подборки — это единственный надёжный сигнал
// "поиск завершён" для биллинга (считаем по нему, а не по количеству сообщений).
function buildSystemPromptV2(bloggerCandidates, brandCandidates, summary) {
    const base = buildBaseSystemPrompt(bloggerCandidates, brandCandidates);
    const summaryBlock = summary
      ? `\n\nКОНТЕКСТ ПРЕДЫДУЩЕГО ДИАЛОГА С ЭТИМ ПОЛЬЗОВАТЕЛЕМ (сжатое саммари более ранней переписки, самые новые сообщения ниже идут дословно):\n${summary}`
          : "";
    const toolRule = `\n\n9. ОБЯЗАТЕЛЬНО: когда даёшь пользователю ИТОГОВУЮ подборку (2-5 вариантов, правило 4) — В ТОМ ЖЕ ОТВЕТЕ вызови инструмент deliver_recommendations с указанием intent и count, ПОМИМО обычного текстового ответа. Если вместо подборки задаёшь уточняющий вопрос или говоришь, что вариантов нет — НЕ вызывай инструмент.`;
    return base + summaryBlock + toolRule;
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

      const response = await anthropic.messages.create({
              model: "claude-sonnet-4-6",
              max_tokens: 800,
              system,
              messages: claudeMessages,
      });

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

      res.json({ reply: replyText });
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
          const system = buildSystemPromptV2(bloggerCandidates, brandCandidates, summary);

      const claudeMessages = [...recentMessages, { role: "user", content: message }];

      const response = await anthropic.messages.create({
              model: "claude-sonnet-4-6",
              max_tokens: 800,
              system,
              messages: claudeMessages,
              tools: [DELIVER_RECOMMENDATIONS_TOOL],
      });

      const replyText = response.content
            .filter((b) => b.type === "text")
            .map((b) => b.text)
            .join("\n");

      const toolUse = response.content.find((b) => b.type === "tool_use" && b.name === "deliver_recommendations");
          const searchCompleted = !!toolUse;

      if (searchCompleted) {
              await billing.recordSearchCompleted(telegramId, {
                        billedAs: access.billedAs,
                        intent: toolUse.input?.intent,
                        model: "claude-sonnet-4-6",
                        inputTokens: response.usage?.input_tokens,
                        outputTokens: response.usage?.output_tokens,
              });
              user = await db.getUser(telegramId); // обновлённые счётчики для ответа
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
          const returnUrl = `${PUBLIC_BASE_URL}/chat.html?payment=return`;
          const confirmationUrl = await billing.startSubscription(req.telegramId, returnUrl);
          res.json({ confirmation_url: confirmationUrl });
    } catch (err) {
          console.error("Ошибка /api/billing/subscribe:", err);
          res.status(500).json({ error: "Не удалось создать платёж подписки." });
    }
});

app.post("/api/billing/addon", requireAuth, async (req, res) => {
    try {
          const returnUrl = `${PUBLIC_BASE_URL}/chat.html?payment=return`;
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
