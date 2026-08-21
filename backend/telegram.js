const API_BASE = "https://api.telegram.org";

function botToken() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN не задан в окружении.");
  return token;
}

async function callTelegramApi(method, body) {
  const res = await fetch(`${API_BASE}/bot${botToken()}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => null);
  if (!data?.ok) {
    console.error(`Telegram API ошибка (${method}):`, data);
  }
  return data;
}

export async function sendMessage(chatId, text) {
  return callTelegramApi("sendMessage", { chat_id: chatId, text, parse_mode: "HTML" });
}

export async function getMe() {
  return callTelegramApi("getMe", {});
}

let cachedBotUsername = null;
/**
 * Возвращает username бота (для построения deep-link t.me/<username>?start=...).
 * Можно задать вручную через TELEGRAM_BOT_USERNAME в .env, чтобы не дёргать API при каждом старте;
 * если не задан — один раз запрашивается через getMe() и кешируется в памяти процесса.
 */
export async function getBotUsername() {
  if (process.env.TELEGRAM_BOT_USERNAME) return process.env.TELEGRAM_BOT_USERNAME;
  if (cachedBotUsername) return cachedBotUsername;
  try {
    const me = await getMe();
    cachedBotUsername = me?.result?.username || null;
    return cachedBotUsername;
  } catch (err) {
    console.error("Не удалось получить username бота через getMe():", err);
    return null;
  }
}

/**
 * Регистрирует URL вебхука в Telegram. Вызывается один раз вручную (см. README) —
 * не на каждом старте сервера, чтобы не дёргать API Telegram лишний раз.
 */
export async function setWebhook(url) {
  return callTelegramApi("setWebhook", { url });
}

/**
 * Обрабатывает входящее обновление от Telegram (вызывается из POST /api/telegram/webhook).
 * Нас интересует только "/start <session_code>" — deep-link из чата на сайте.
 */
export async function handleUpdate(update, { onStartLink }) {
  const message = update?.message;
  if (!message || !message.text) return;

  const text = message.text.trim();
  const chatId = message.chat.id;
  const telegramId = message.from.id;

  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    const sessionCode = parts[1];

    if (!sessionCode) {
      await sendMessage(
        chatId,
        "Привет! Это бот Brandis 🙂 Чтобы привязать аккаунт, открой чат на сайте и нажми «Войти через Telegram» — сюда придёт персональная ссылка."
      );
      return;
    }

    const result = await onStartLink({
      sessionCode,
      telegramId,
      username: message.from.username,
      firstName: message.from.first_name,
    });

    if (result?.linked) {
      await sendMessage(
        chatId,
        "Готово! Аккаунт привязан ✅ Возвращайся на сайт — чат уже разблокирован."
      );
    } else {
      await sendMessage(
        chatId,
        "Не получилось привязать аккаунт (ссылка устарела или уже использована). Вернись на сайт и попробуй ещё раз — сгенерируется новая ссылка."
      );
    }
    return;
  }

  // Любые другие сообщения боту — просто мягкая подсказка, вся логика подбора живёт на сайте.
  await sendMessage(chatId, "Чат с AI-подбором Brandis — на сайте: перейди на страницу чата и пиши там 🙂");
}
