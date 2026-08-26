import * as db from "./db.js";
import * as yookassa from "./yookassa.js";

export const SUBSCRIPTION_PRICE_RUB = 999;
export const ADDON_PRICE_RUB = 299;
export const SUBSCRIPTION_INCLUDED_SEARCHES = 50;
export const ADDON_SEARCHES = 20;
export const MAX_RENEWAL_ATTEMPTS = 3; // после стольких неудачных попыток подряд — подписка деактивируется

/**
 * Прибавляет ровно 1 календарный месяц к дате, сохраняя "число" по возможности
 * (31 янв + 1 мес -> 28/29 фев, это ожидаемое поведение JS Date для таких кромок).
 */
function addOneMonth(date) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + 1);
  return d;
}

/**
 * Проверка доступа к чату/поиску для пользователя.
 * Возвращает { allowed: true } либо { allowed: false, reason, cta }.
 */
export function checkAccess(user) {
  if (user.subscription_status === "active") {
    if (user.searches_used_this_period < SUBSCRIPTION_INCLUDED_SEARCHES) {
      return { allowed: true, billedAs: "subscription" };
    }
    if (user.addon_searches_remaining > 0) {
      return { allowed: true, billedAs: "addon" };
    }
    return {
      allowed: false,
      reason: "addon_needed",
      message: `Лимит подписки исчерпан (${SUBSCRIPTION_INCLUDED_SEARCHES} подборов в этом периоде). Можно докупить +${ADDON_SEARCHES} подборов за ${ADDON_PRICE_RUB}₽.`,
      cta: "addon",
    };
  }

  if (!user.free_search_used) {
    return { allowed: true, billedAs: "free" };
  }

  // Пакет подборов можно купить и без подписки — тогда он и расходуется первым.
  if (user.addon_searches_remaining > 0) {
    return { allowed: true, billedAs: "addon" };
  }

  return {
    allowed: false,
    reason: "subscription_needed",
    message: `Бесплатный подбор уже использован. Оформи подписку ${SUBSCRIPTION_PRICE_RUB}₽/мес — это ${SUBSCRIPTION_INCLUDED_SEARCHES} подборов в месяц, или разовый пакет ${ADDON_PRICE_RUB}₽ — ${ADDON_SEARCHES} подборов.`,
    cta: "subscribe",
  };
}

/**
 * Вызывается, когда бот выдал завершённую подборку (а не уточняющий вопрос).
 * Списывает поиск из нужного "кармана" и логирует событие для unit-экономики.
 */
export async function recordSearchCompleted(telegramId, { billedAs, intent, model, inputTokens, outputTokens }) {
  await db.insertSearchEvent(telegramId, { billedAs, intent, model, inputTokens, outputTokens });

  if (billedAs === "free") {
    await db.updateUser(telegramId, { free_search_used: true });
  } else if (billedAs === "subscription") {
    await db.query(
      `UPDATE users SET searches_used_this_period = searches_used_this_period + 1, updated_at = now() WHERE telegram_id = $1`,
      [telegramId]
    );
  } else if (billedAs === "addon") {
    await db.query(
      `UPDATE users SET addon_searches_remaining = GREATEST(addon_searches_remaining - 1, 0), updated_at = now() WHERE telegram_id = $1`,
      [telegramId]
    );
  }
}

/**
 * Создаёт ссылку на оплату первой подписки (с сохранением способа оплаты для автосписаний).
 */
export async function startSubscription(telegramId, returnUrl) {
  const user = await db.getUser(telegramId);
  if (!user) throw new Error("Пользователь не найден");
  if (user.subscription_status === "active") {
    throw new Error("Подписка уже активна.");
  }

  const payment = await yookassa.createSubscriptionInitialPayment({ telegramId, returnUrl });
  await db.insertPayment(telegramId, {
    yookassaPaymentId: payment.id,
    type: "subscription_initial",
    amountRub: SUBSCRIPTION_PRICE_RUB,
    status: payment.status,
    rawPayload: payment,
  });
  return payment.confirmation?.confirmation_url;
}

/**
 * Создаёт ссылку на оплату разового пакета +20 подборов. Доступно всем авторизованным.
 */
export async function startAddonPurchase(telegramId, returnUrl) {
  const user = await db.getUser(telegramId);
  if (!user) throw new Error("Пользователь не найден");
  const payment = await yookassa.createAddonPayment({ telegramId, returnUrl });
  await db.insertPayment(telegramId, {
    yookassaPaymentId: payment.id,
    type: "addon",
    amountRub: ADDON_PRICE_RUB,
    status: payment.status,
    rawPayload: payment,
  });
  return payment.confirmation?.confirmation_url;
}

/**
 * Применяет успешный платёж (вызывается из обработчика вебхука после авторитетной проверки статуса в ЮKassa).
 */
export async function applySucceededPayment(payment) {
  const telegramId = Number(payment.metadata?.telegram_id);
  const type = payment.metadata?.type;
  if (!telegramId || !type) {
    console.warn("Платёж без ожидаемых metadata, пропускаю применение:", payment.id);
    return;
  }

  if (type === "subscription_initial") {
    const now = new Date();
    await db.updateUser(telegramId, {
      subscription_status: "active",
      subscription_id: payment.id,
      payment_method_id: payment.payment_method?.id || null,
      subscription_period_start: now.toISOString(),
      subscription_period_end: addOneMonth(now).toISOString(),
      searches_used_this_period: 0,
      addon_searches_remaining: 0,
      renewal_failed_attempts: 0,
    });
  } else if (type === "subscription_recurring") {
    const user = await db.getUser(telegramId);
    // Продлеваем от прежней даты окончания периода, а не от "сейчас" — так дата цикла не "плывёт",
    // даже если наш процесс списал платёж с опозданием (например, сервис "спал").
    const base = user?.subscription_period_end ? new Date(user.subscription_period_end) : new Date();
    await db.updateUser(telegramId, {
      subscription_status: "active",
      subscription_period_start: new Date().toISOString(),
      subscription_period_end: addOneMonth(base).toISOString(),
      searches_used_this_period: 0,
      addon_searches_remaining: 0,
      renewal_failed_attempts: 0,
    });
  } else if (type === "addon") {
    const user = await db.getUser(telegramId);
    await db.query(
      `UPDATE users SET addon_searches_remaining = addon_searches_remaining + $2,
                          addon_expires_at = $3, updated_at = now()
       WHERE telegram_id = $1`,
      [telegramId, ADDON_SEARCHES, user?.subscription_period_end || null]
    );
  }
}

export async function applyFailedPayment(payment) {
  const telegramId = Number(payment.metadata?.telegram_id);
  const type = payment.metadata?.type;
  if (!telegramId) return;

  if (type === "subscription_recurring") {
    const user = await db.getUser(telegramId);
    const attempts = (user?.renewal_failed_attempts || 0) + 1;
    if (attempts >= MAX_RENEWAL_ATTEMPTS) {
      await db.updateUser(telegramId, {
        subscription_status: "inactive",
        renewal_failed_attempts: attempts,
        last_renewal_attempt_at: new Date().toISOString(),
      });
    } else {
      // Мягкий грейс-период: доступ по подписке сохраняется до конца уже оплаченного периода,
      // повторная попытка спишется при следующем "прочёсывании" (см. sweepDueRenewals).
      await db.updateUser(telegramId, {
        renewal_failed_attempts: attempts,
        last_renewal_attempt_at: new Date().toISOString(),
      });
    }
  }
  // subscription_initial / addon failed — ничего не меняем, пользователь просто не получил доступ,
  // может попробовать оплатить ещё раз.
}

/**
 * "Прочёсывание" подписок, чьё продление наступило. Вызывается оппортунистически на входящих
 * запросах (see server.js) — сервис на бесплатном тарифе Render засыпает, поэтому обычный
 * setInterval ненадёжен: любой входящий запрос от ЛЮБОГО пользователя "будит" процесс и заодно
 * выполняет просроченные продления.
 */
export async function sweepDueRenewals() {
  let due;
  try {
    due = await db.listDueRenewals(new Date());
  } catch (err) {
    console.error("sweepDueRenewals: не удалось получить список должников", err);
    return;
  }

  for (const user of due) {
    try {
      await db.updateUser(user.telegram_id, { last_renewal_attempt_at: new Date().toISOString() });
      const payment = await yookassa.chargeSubscriptionRenewal({
        telegramId: user.telegram_id,
        paymentMethodId: user.payment_method_id,
      });
      await db.insertPayment(user.telegram_id, {
        yookassaPaymentId: payment.id,
        type: "subscription_recurring",
        amountRub: SUBSCRIPTION_PRICE_RUB,
        status: payment.status,
        rawPayload: payment,
      });
      if (payment.status === "succeeded") {
        await applySucceededPayment(payment);
      } else if (payment.status === "canceled") {
        await applyFailedPayment(payment);
      }
      // Если статус "pending" — ждём вебхука, applySucceededPayment/applyFailedPayment
      // применится когда придёт уведомление.
    } catch (err) {
      console.error(`sweepDueRenewals: ошибка автосписания для telegram_id=${user.telegram_id}`, err);
      await applyFailedPayment({
        metadata: { telegram_id: String(user.telegram_id), type: "subscription_recurring" },
      });
    }
  }
}
