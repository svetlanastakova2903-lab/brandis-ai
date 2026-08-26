import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.warn(
    "ВНИМАНИЕ: DATABASE_URL не задан. Биллинг, авторизация через Telegram и история диалогов работать не будут."
  );
}

// Большинство бесплатных управляемых Postgres (Supabase, Neon, Render Postgres) требуют SSL.
// Для локальной разработки на голом Postgres можно выставить PGSSL=false в .env.
const useSsl = process.env.PGSSL !== "false";

export const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: useSsl ? { rejectUnauthorized: false } : false,
      max: 5,
    })
  : null;

function requirePool() {
  if (!pool) throw new Error("DATABASE_URL не настроен — операция с БД невозможна.");
  return pool;
}

export async function query(text, params) {
  return requirePool().query(text, params);
}

// ---------- Инициализация схемы (идемпотентно, безопасно вызывать при каждом старте) ----------
export async function initSchema() {
  if (!pool) return;

  await query(`
    CREATE TABLE IF NOT EXISTS pending_links (
      session_code   TEXT PRIMARY KEY,
      telegram_id    BIGINT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      linked_at      TIMESTAMPTZ
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS users (
      telegram_id                 BIGINT PRIMARY KEY,
      telegram_username           TEXT,
      telegram_first_name         TEXT,
      access_token                TEXT UNIQUE,

      free_search_used            BOOLEAN NOT NULL DEFAULT false,

      subscription_status         TEXT NOT NULL DEFAULT 'inactive', -- 'active' | 'inactive'
      subscription_id             TEXT,
      payment_method_id           TEXT,
      subscription_period_start   TIMESTAMPTZ,
      subscription_period_end     TIMESTAMPTZ,
      searches_used_this_period   INTEGER NOT NULL DEFAULT 0,
      addon_searches_remaining    INTEGER NOT NULL DEFAULT 0,
      addon_expires_at            TIMESTAMPTZ,

      renewal_failed_attempts     INTEGER NOT NULL DEFAULT 0,
      last_renewal_attempt_at     TIMESTAMPTZ,

      conversation_summary        TEXT NOT NULL DEFAULT '',
      summary_covers_up_to_seq    INTEGER NOT NULL DEFAULT 0,

      created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  // Счётчик сообщений с момента последней выданной подборки. Добавляем отдельным ALTER:
  // CREATE TABLE IF NOT EXISTS выше не меняет уже существующую таблицу.
  await query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS turns_since_search INTEGER NOT NULL DEFAULT 0;`);

  await query(`
    CREATE TABLE IF NOT EXISTS messages (
      id            BIGSERIAL PRIMARY KEY,
      telegram_id   BIGINT NOT NULL REFERENCES users(telegram_id),
      seq           INTEGER NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_messages_telegram_seq ON messages(telegram_id, seq);`);

  await query(`
    CREATE TABLE IF NOT EXISTS search_events (
      id             BIGSERIAL PRIMARY KEY,
      telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
      completed_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      billed_as      TEXT NOT NULL, -- 'free' | 'subscription' | 'addon'
      intent         TEXT,
      model          TEXT,
      input_tokens   INTEGER,
      output_tokens  INTEGER
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_search_events_telegram ON search_events(telegram_id);`);

  await query(`
    CREATE TABLE IF NOT EXISTS summary_events (
      id             BIGSERIAL PRIMARY KEY,
      telegram_id    BIGINT NOT NULL REFERENCES users(telegram_id),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      model          TEXT,
      input_tokens   INTEGER,
      output_tokens  INTEGER
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS payments (
      id                     BIGSERIAL PRIMARY KEY,
      telegram_id            BIGINT NOT NULL REFERENCES users(telegram_id),
      yookassa_payment_id    TEXT UNIQUE NOT NULL,
      type                   TEXT NOT NULL, -- 'subscription_initial' | 'subscription_recurring' | 'addon'
      amount_rub             NUMERIC NOT NULL,
      status                 TEXT NOT NULL, -- 'pending' | 'succeeded' | 'canceled'
      raw_payload            JSONB,
      created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await query(`CREATE INDEX IF NOT EXISTS idx_payments_telegram ON payments(telegram_id);`);

  console.log("Схема БД проверена/создана.");
}

// ---------- users ----------
export async function getUser(telegramId) {
  const { rows } = await query(`SELECT * FROM users WHERE telegram_id = $1`, [telegramId]);
  return rows[0] || null;
}

// Единственный способ, которым фронтенд может себя авторизовать после привязки Telegram —
// telegram_id сам по себе НЕ секрет и не принимается как удостоверение личности ни в одном
// эндпоинте ниже (см. requireAuth в server.js), только этот непрозрачный токен.
export async function getUserByAccessToken(accessToken) {
  if (!accessToken) return null;
  const { rows } = await query(`SELECT * FROM users WHERE access_token = $1`, [accessToken]);
  return rows[0] || null;
}

export async function getOrCreateUser(telegramId, { username, firstName } = {}) {
  const { rows } = await query(
    `INSERT INTO users (telegram_id, telegram_username, telegram_first_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_id) DO UPDATE SET
       telegram_username = COALESCE(EXCLUDED.telegram_username, users.telegram_username),
       telegram_first_name = COALESCE(EXCLUDED.telegram_first_name, users.telegram_first_name)
     RETURNING *`,
    [telegramId, username || null, firstName || null]
  );
  return rows[0];
}

export async function updateUser(telegramId, patch) {
  const fields = Object.keys(patch);
  if (fields.length === 0) return getUser(telegramId);
  const setClause = fields.map((f, i) => `${f} = $${i + 2}`).join(", ");
  const values = fields.map((f) => patch[f]);
  const { rows } = await query(
    `UPDATE users SET ${setClause}, updated_at = now() WHERE telegram_id = $1 RETURNING *`,
    [telegramId, ...values]
  );
  return rows[0];
}

// ---------- pending_links (Telegram-привязка) ----------
export async function createPendingLink(sessionCode) {
  await query(
    `INSERT INTO pending_links (session_code) VALUES ($1)
     ON CONFLICT (session_code) DO NOTHING`,
    [sessionCode]
  );
}

export async function getPendingLink(sessionCode) {
  const { rows } = await query(`SELECT * FROM pending_links WHERE session_code = $1`, [sessionCode]);
  return rows[0] || null;
}

export async function completePendingLink(sessionCode, telegramId) {
  const { rows } = await query(
    `UPDATE pending_links SET telegram_id = $2, linked_at = now()
     WHERE session_code = $1
     RETURNING *`,
    [sessionCode, telegramId]
  );
  return rows[0] || null;
}

// ---------- messages ----------
export async function getNextSeq(telegramId) {
  const { rows } = await query(
    `SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE telegram_id = $1`,
    [telegramId]
  );
  return rows[0].next_seq;
}

export async function insertMessage(telegramId, seq, role, content) {
  await query(
    `INSERT INTO messages (telegram_id, seq, role, content) VALUES ($1, $2, $3, $4)`,
    [telegramId, seq, role, content]
  );
}

export async function getAllMessages(telegramId) {
  const { rows } = await query(
    `SELECT seq, role, content, created_at FROM messages WHERE telegram_id = $1 ORDER BY seq ASC`,
    [telegramId]
  );
  return rows;
}

export async function getRecentMessages(telegramId, limit) {
  const { rows } = await query(
    `SELECT seq, role, content FROM messages WHERE telegram_id = $1 ORDER BY seq DESC LIMIT $2`,
    [telegramId, limit]
  );
  return rows.reverse();
}

export async function getPendingMessagesForSummary(telegramId, sinceSeqExclusive, upToSeqInclusive) {
  const { rows } = await query(
    `SELECT seq, role, content FROM messages
     WHERE telegram_id = $1 AND seq > $2 AND seq <= $3
     ORDER BY seq ASC`,
    [telegramId, sinceSeqExclusive, upToSeqInclusive]
  );
  return rows;
}

// ---------- search_events ----------
export async function insertSearchEvent(telegramId, { billedAs, intent, model, inputTokens, outputTokens }) {
  await query(
    `INSERT INTO search_events (telegram_id, billed_as, intent, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [telegramId, billedAs, intent || null, model || null, inputTokens || null, outputTokens || null]
  );
}

// ---------- summary_events ----------
export async function insertSummaryEvent(telegramId, { model, inputTokens, outputTokens }) {
  await query(
    `INSERT INTO summary_events (telegram_id, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, $4)`,
    [telegramId, model || null, inputTokens || null, outputTokens || null]
  );
}

// ---------- payments ----------
export async function insertPayment(telegramId, { yookassaPaymentId, type, amountRub, status, rawPayload }) {
  const { rows } = await query(
    `INSERT INTO payments (telegram_id, yookassa_payment_id, type, amount_rub, status, raw_payload)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (yookassa_payment_id) DO NOTHING
     RETURNING *`,
    [telegramId, yookassaPaymentId, type, amountRub, status, rawPayload ? JSON.stringify(rawPayload) : null]
  );
  return rows[0] || null;
}

export async function getPaymentByYookassaId(yookassaPaymentId) {
  const { rows } = await query(`SELECT * FROM payments WHERE yookassa_payment_id = $1`, [yookassaPaymentId]);
  return rows[0] || null;
}

export async function updatePaymentStatus(yookassaPaymentId, status, rawPayload) {
  await query(
    `UPDATE payments SET status = $2, raw_payload = COALESCE($3, raw_payload), updated_at = now()
     WHERE yookassa_payment_id = $1`,
    [yookassaPaymentId, status, rawPayload ? JSON.stringify(rawPayload) : null]
  );
}

// ---------- рассылки / due renewals ----------
export async function listDueRenewals(now = new Date()) {
  const { rows } = await query(
    `SELECT * FROM users
     WHERE subscription_status = 'active'
       AND subscription_period_end IS NOT NULL
       AND subscription_period_end <= $1
       AND payment_method_id IS NOT NULL
     ORDER BY subscription_period_end ASC
     LIMIT 50`,
    [now.toISOString()]
  );
  return rows;
}
