import Anthropic from "@anthropic-ai/sdk";
import * as db from "./db.js";

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Модель для сжатия истории — дешевле основной модели диалога, используется не на каждое сообщение.
const SUMMARY_MODEL = process.env.SUMMARY_MODEL || "claude-haiku-4-5";

const KEEP_RECENT_MESSAGES = 8; // последние N сообщений всегда идут в контекст дословно
const RESUMMARIZE_EVERY_N_MESSAGES = 10; // пересжимать, если накопилось столько новых "старых" сообщений
const RESUMMARIZE_TOKEN_THRESHOLD = 3000; // ...или если их оценочный объём превысил это число токенов

// Грубая оценка числа токенов по длине текста (без реального токенайзера — этого достаточно
// для порога "пора пересжать", не для биллинга).
function estimateTokens(text) {
  return Math.ceil((text || "").length / 3);
}

/**
 * Возвращает {summary, recentMessages} — то, что нужно подставить в system-промпт и в messages[]
 * для запроса к основной модели. recentMessages — последние KEEP_RECENT_MESSAGES сообщений дословно.
 */
export async function getContextForUser(telegramId) {
  const user = await db.getUser(telegramId);
  const recentMessages = await db.getRecentMessages(telegramId, KEEP_RECENT_MESSAGES);
  return {
    summary: user?.conversation_summary || "",
    recentMessages: recentMessages.map((m) => ({ role: m.role, content: m.content })),
  };
}

/**
 * Сохраняет пару сообщений (user + assistant) и, если накопилось достаточно "старой" истории,
 * в фоне пересжимает summary через Haiku. Не блокирует основной ответ пользователю —
 * вызывающий код должен звать это ПОСЛЕ отправки ответа (fire-and-forget с логированием ошибок).
 */
export async function appendExchangeAndMaybeSummarize(telegramId, userText, assistantText) {
  const seqUser = await db.getNextSeq(telegramId);
  await db.insertMessage(telegramId, seqUser, "user", userText);
  const seqAssistant = seqUser + 1;
  await db.insertMessage(telegramId, seqAssistant, "assistant", assistantText);

  await maybeResummarize(telegramId, seqAssistant);
}

async function maybeResummarize(telegramId, latestSeq) {
  const user = await db.getUser(telegramId);
  if (!user) return;

  const summarizeUpTo = latestSeq - KEEP_RECENT_MESSAGES;
  if (summarizeUpTo <= user.summary_covers_up_to_seq) return; // нечего сжимать ещё

  const pending = await db.getPendingMessagesForSummary(
    telegramId,
    user.summary_covers_up_to_seq,
    summarizeUpTo
  );
  if (pending.length === 0) return;

  const pendingTokens = pending.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const shouldResummarize =
    pending.length >= RESUMMARIZE_EVERY_N_MESSAGES || pendingTokens >= RESUMMARIZE_TOKEN_THRESHOLD;

  if (!shouldResummarize) return;

  try {
    const newSummary = await summarizeWithHaiku(user.conversation_summary, pending);
    await db.updateUser(telegramId, {
      conversation_summary: newSummary.text,
      summary_covers_up_to_seq: summarizeUpTo,
    });
    await db.insertSummaryEvent(telegramId, {
      model: SUMMARY_MODEL,
      inputTokens: newSummary.inputTokens,
      outputTokens: newSummary.outputTokens,
    });
  } catch (err) {
    console.error(`Не удалось пересжать историю для telegram_id=${telegramId}:`, err);
    // Не бросаем ошибку дальше — это фоновая оптимизация, отсутствие сжатия в этот раз не критично,
    // просто в следующий раз в контекст пойдёт чуть больше "старых" сообщений дословно.
  }
}

async function summarizeWithHaiku(previousSummary, pendingMessages) {
  const transcript = pendingMessages
    .map((m) => `${m.role === "user" ? "Пользователь" : "Бот"}: ${m.content}`)
    .join("\n");

  const system = `Ты сжимаешь историю переписки пользователя с AI-подбором Brandis (маркетплейс блогеров и брендов) в краткое саммари — оно будет использовано как контекст для следующих ответов вместо полной истории.

Сохрани обязательно:
- кто пользователь (бренд/бизнес ищет блогера, блогер ищет бренд/бартер, или блогер ищет кросс-промо);
- какие критерии он называл (город, ниша, бюджет, число подписчиков и т.д.);
- какие блогеры/бренды уже были предложены ранее (чтобы не повторять их снова);
- текущее состояние диалога (например, ждём уточнения от пользователя, или уже была выдана подборка).

Пиши компактно, простым текстом на русском, без markdown, не более 300 слов. Не добавляй ничего, чего не было в переписке.`;

  const userPrompt = previousSummary
    ? `ПРЕДЫДУЩЕЕ САММАРИ:\n${previousSummary}\n\nНОВЫЕ СООБЩЕНИЯ ДЛЯ ВКЛЮЧЕНИЯ:\n${transcript}\n\nПерепиши единое обновлённое саммари, включающее и старое, и новое.`
    : `ПЕРЕПИСКА ДЛЯ СЖАТИЯ:\n${transcript}`;

  const response = await anthropic.messages.create({
    model: SUMMARY_MODEL,
    max_tokens: 500,
    system,
    messages: [{ role: "user", content: userPrompt }],
  });

  const text = response.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  return {
    text,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
  };
}
