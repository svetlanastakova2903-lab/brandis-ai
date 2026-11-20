import crypto from 'node:crypto';

export function webhookSecret(env=process.env) {
  if(env.TELEGRAM_WEBHOOK_SECRET)return env.TELEGRAM_WEBHOOK_SECRET;
  // Domain-separated secret derived from the existing high-entropy bot credential.
  // This is not the bot token and is never returned by public endpoints.
  if(!env.TELEGRAM_BOT_TOKEN)return '';
  return crypto.createHmac('sha256',env.TELEGRAM_BOT_TOKEN).update('brandis:telegram-webhook:v1').digest('hex');
}

export function validWebhookSecret(received, expected) {
  if (typeof expected !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/.test(expected)) return false;
  if (typeof received !== 'string') return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function linkIsFresh(link, now = Date.now()) {
  const created = link?.created_at instanceof Date ? link.created_at.getTime() : Date.parse(link?.created_at);
  return Number.isFinite(created) && created <= now && now - created < 15 * 60 * 1000;
}

export function privateSender(message) {
  return message?.chat?.type === 'private' &&
    Number.isSafeInteger(message?.from?.id) && message.from.id > 0 &&
    message.chat.id === message.from.id && !message.from.is_bot;
}
