import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import Anthropic from "@anthropic-ai/sdk";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors()); // при необходимости ограничь origin своим доменом на Tilda
app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const DATA_MODE = process.env.DATA_MODE || "test"; // "test" | "real"
const PREFILTER_THRESHOLD = 200;
const MAX_CANDIDATES_TO_MODEL = 40;

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

// ---------- Логирование диалогов ----------
const LOG_FILE = path.join(__dirname, "logs.jsonl");
function logInteraction(entry) {
  fs.appendFile(LOG_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n", () => {});
}

// ---------- Предфильтрация базы ----------
function extractLastUserText(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  return last?.content || "";
}

function detectCity(entities, text) {
  const cities = [...new Set(entities.map((b) => b.city).filter(Boolean))];
  return cities.find((c) => text.includes(c.toLowerCase()));
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
  if (matchedCity) candidates = candidates.filter((b) => b.city === matchedCity);
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

// ---------- System prompt ----------
function buildSystemPrompt(bloggerCandidates, brandCandidates) {
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

ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе данных из таблиц ниже (JSON). Никогда не придумывай блогеров, бренды, цифры или контакт, которых нет в данных.
2. Если запрос слишком общий (не хватает города, ниши, подписчиков или намерения) — задай ОДИН уточняющий вопрос, не больше.
3. Если подходящих вариантов нет — честно скажи об этом и предложи смягчить критерии (другой город/ниша).
4. Рекомендуй 2-5 самых подходящих вариантов, коротко объясняя, почему каждый подходит.
5. Пиши порусски, коротко, дружелюбно, как локальный эксперт, а не корпоративный бот. Без markdown-таблиц, без излишнего форматирования — обычным текстом, можно с эмодзи изредка.
6. Если у блогера/бренда не указана цена, бюджет или engagement — не выдумывай их, просто не упоминай эти поля.
7. Всегда указывай контакт, если он есть в данных, чтобы пользователь мог написать напрямую.
8. ВАЖНМ: в каждой рекомендации явно указывай формат сотрудничества — "💰 деньги", "🔄 бартер" или "🤝 кросс-промо" — чтобы не было путаницы, что предлагается.

БАЗА БЛОГГЕРОВ (JSON, для сценариев 1 и 3):
${JSON.stringify(bloggerCandidates, null, 0)}

БАЗА БРЕНДОВ (JSON, для сценария 2):
${JSON.stringify(brandCandidates, null, 0)}`;
}

// ---------- API ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] обязателен" });
    }

    const bloggerCandidates = prefilterEntities(BLOGGERS, messages, { isBlogger: true });
    const brandCandidates = prefilterEntities(BRANDS, messages, { isBlogger: false });
    const system = buildSystemPrompt(bloggerCandidates, brandCandidates);

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
  res.json({ ok: true, dataMode: DATA_MODE, bloggersCount: BLOGGERS.length, brandsCount: BRANDS.length });
});

app.get("/api/logs", (req, res) => {
  // Простая аналитика: последние N запросов. В проде стоит защитить паролем.
  if (!fs.existsSync(LOG_FILE)) return res.json([]);
  const lines = fs.readFileSync(LOG_FILE, "utf-8").trim().split("\n").filter(Boolean);
  const last = lines.slice(-200).map((l) => JSON.parse(l));
  res.json(last);
});

app.use(express.static(path.join(__dirname, "..", "frontend")));

app.listen(PORT, () => {
  console.log(`Brandis AI backend запущен на порту ${PORT}`);
});
