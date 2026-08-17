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

// ---------- Загрузка базы блогеров ----------
function loadBloggers() {
  const file =
    DATA_MODE === "real"
      ? path.join(__dirname, "data", "bloggers.json")
      : path.join(__dirname, "data", "bloggers.test.json");
  if (!fs.existsSync(file)) {
    console.warn(`Файл базы не найден: ${file}, использую пустой список`);
    return [];
  }
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

let BLOGGERS = loadBloggers();
console.log(`Загружено блогеров (${DATA_MODE}): ${BLOGGERS.length}`);

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

function prefilterBloggers(allBloggers, messages) {
  if (allBloggers.length <= PREFILTER_THRESHOLD) return allBloggers;

  const text = messages
    .map((m) => m.content)
    .join(" ")
    .toLowerCase();

  const cities = [...new Set(allBloggers.map((b) => b.city).filter(Boolean))];
  const matchedCity = cities.find((c) => text.includes(c.toLowerCase()));

  const niches = [...new Set(allBloggers.flatMap((b) => b.niche || []))];
  const matchedNiches = niches.filter((n) => {
    const words = n.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
    return words.some((w) => text.includes(w));
  });

  const maxFollowersMatch = text.match(/до\s*(\d+)\s*(k|к|тыс)?/);
  let maxFollowers = null;
  if (maxFollowersMatch) {
    let n = parseInt(maxFollowersMatch[1], 10);
    if (maxFollowersMatch[2]) n *= 1000;
    maxFollowers = n;
  }
  const minFollowersMatch = text.match(/от\s*(\d+)\s*(k|к|тыс)?/);
  let minFollowers = null;
  if (minFollowersMatch) {
    let n = parseInt(minFollowersMatch[1], 10);
    if (minFollowersMatch[2]) n *= 1000;
    minFollowers = n;
  }

  let candidates = allBloggers;
  if (matchedCity) candidates = candidates.filter((b) => b.city === matchedCity);
  if (matchedNiches.length) {
    const filtered = candidates.filter((b) => (b.niche || []).some((n) => matchedNiches.includes(n)));
    if (filtered.length) candidates = filtered;
  }
  if (maxFollowers) candidates = candidates.filter((b) => !b.followers || b.followers <= maxFollowers);
  if (minFollowers) candidates = candidates.filter((b) => !b.followers || b.followers >= minFollowers);

  // Если предфильтр слишком сузил или ничего не дал — откатываемся к городу или ко всей базе (усечённой)
  if (candidates.length === 0) candidates = matchedCity ? allBloggers.filter((b) => b.city === matchedCity) : allBloggers;
  if (candidates.length === 0) candidates = allBloggers;

  return candidates.slice(0, MAX_CANDIDATES_TO_MODEL);
}

// ---------- System prompt ----------
function buildSystemPrompt(candidates) {
  return `Ты — AI-помощник по подбору блогеров для маркетплейса инфлюенсер-маркетинга Brandis (Россия, фокус: Москва, Санкт-Петербург, Рязань и другие города РФ).

ПРАВИЛА:
1. Отвечай ТОЛЬКО на основе блогеров из списка ниже (JSON). Никогда не придумывай блогеров, цифры или контакты, которых нет в списке.
2. Если запрос слишком общий (не хватает города, ниши или бюджета/подписчиков) — задай ОДИН уточняющий вопрос, не больше.
3. Если подходящих блогеров нет — честно скажи об этом и предложи смягчить критерии (другой город/ниша/бюджет).
4. Рекомендуй 2-5 самых подходящих блогеров, коротко объясняя, почему каждый подходит.
5. Пиши по-русски, коротко, дружелюбно, как локальный эксперт, а не корпоративный бот. Без markdown-таблиц, без излишнего форматирования — обычным текстом, можно с эмодзи изредка.
6. Если у блогера не указана цена или engagement — не выдумывай их, просто не упоминай эти поля.
7. Всегда указывай контакт/ссылку блогера, если она есть в данных, чтобы пользователь мог написать напрямую.

БАЗА БЛОГЕРОВ (JSON, только эти данные являются источником правды):
${JSON.stringify(candidates, null, 0)}`;
}

// ---------- API ----------
app.post("/api/chat", async (req, res) => {
  try {
    const { messages } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "messages[] обязателен" });
    }

    const candidates = prefilterBloggers(BLOGGERS, messages);
    const system = buildSystemPrompt(candidates);

    const claudeMessages = messages
      .filter((m) => m.role === "user" || m.role === "assistant")
      .map((m) => ({ role: m.role, content: m.content }));

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 700,
      system,
      messages: claudeMessages,
    });

    const replyText = response.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    logInteraction({
      userMessage: extractLastUserText(messages),
      candidatesCount: candidates.length,
      reply: replyText,
    });

    res.json({ reply: replyText });
  } catch (err) {
    console.error("Ошибка /api/chat:", err);
    res.status(500).json({ error: "Что-то пошло не так. Попробуй ещё раз чуть позже." });
  }
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, dataMode: DATA_MODE, bloggersCount: BLOGGERS.length });
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
