import crypto from "crypto";

const API_BASE = "https://api.yookassa.ru/v3";

function authHeader() {
  const shopId = process.env.YOOKASSA_SHOP_ID;
  const secretKey = process.env.YOOKASSA_SECRET_KEY;
  if (!shopId || !secretKey) {
    throw new Error("YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY не заданы в окружении.");
  }
  return "Basic " + Buffer.from(`${shopId}:${secretKey}`).toString("base64");
}

async function yookassaFetch(path, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      "Idempotence-Key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.description || data?.type || `HTTP ${res.status}`;
    const err = new Error(`ЮKassa API ошибка: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function yookassaGet(path) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "GET",
    headers: { Authorization: authHeader() },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.description || data?.type || `HTTP ${res.status}`;
    throw new Error(`ЮKassa API ошибка: ${msg}`);
  }
  return data;
}

/**
 * Создаёт первый платёж подписки с сохранением способа оплаты для будущих автосписаний.
 */
export async function createSubscriptionInitialPayment({ telegramId, returnUrl }) {
  return yookassaFetch("/payments", {
    amount: { value: "999.00", currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    save_payment_method: true,
    description: "Подписка Brandis AI — 999₽/мес (50 поисков)",
    metadata: { telegram_id: String(telegramId), type: "subscription_initial" },
  });
}

/**
 * Повторное (рекуррентное) списание по сохранённому payment_method_id — без участия пользователя.
 */
export async function chargeSubscriptionRenewal({ telegramId, paymentMethodId }) {
  return yookassaFetch("/payments", {
    amount: { value: "999.00", currency: "RUB" },
    capture: true,
    payment_method_id: paymentMethodId,
    description: "Продление подписки Brandis AI — 999₽/мес",
    metadata: { telegram_id: String(telegramId), type: "subscription_recurring" },
  });
}

/**
 * Разовый платёж за пакет +20 поисков.
 */
export async function createAddonPayment({ telegramId, returnUrl }) {
  return yookassaFetch("/payments", {
    amount: { value: "299.00", currency: "RUB" },
    capture: true,
    confirmation: { type: "redirect", return_url: returnUrl },
    description: "Пакет +20 поисков Brandis AI — 299₽",
    metadata: { telegram_id: String(telegramId), type: "addon" },
  });
}

/**
 * Авторитетная проверка статуса платежа напрямую в ЮKassa — используется в обработчике вебхука,
 * чтобы не доверять слепо телу уведомления (рекомендация самой ЮKassa).
 */
export async function getPayment(paymentId) {
  return yookassaGet(`/payments/${paymentId}`);
}

// Подсети, с которых ЮKassa отправляет вебхуки (см. документацию ЮKassa "Входящие уведомления").
export const YOOKASSA_WEBHOOK_CIDRS = [
  "185.71.76.0/27",
  "185.71.77.0/27",
  "77.75.153.0/25",
  "77.75.156.11/32",
  "77.75.156.35/32",
  "77.75.154.128/25",
  "2a02:5180::/32",
];

function ipToLong(ip) {
  return ip.split(".").reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isIpInCidr(ip, cidr) {
  if (cidr.includes(":")) return false; // IPv6 диапазон не проверяем через это простое сравнение
  const [range, bitsStr] = cidr.split("/");
  const bits = parseInt(bitsStr, 10);
  if (!ip.includes(".")) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  try {
    return (ipToLong(ip) & mask) === (ipToLong(range) & mask);
  } catch {
    return false;
  }
}

export function isYookassaIp(ip) {
  if (!ip) return false;
  const clean = ip.replace("::ffff:", "");
  return YOOKASSA_WEBHOOK_CIDRS.some((cidr) => isIpInCidr(clean, cidr));
}
