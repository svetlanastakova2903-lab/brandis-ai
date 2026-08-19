// Лёгкий регрессионный тест биллинг-логики (без моков — реальные запросы к Postgres,
// без обращений к ЮKassa/Telegram/Anthropic). Учитывая, что это логика вокруг реальных денег,
// стоит гонять его перед каждым деплоем изменений в billing.js/db.js.
// Запуск: DATABASE_URL=postgres://... PGSSL=false npm test  (или node test-billing.mjs)
import assert from "node:assert/strict";
import * as db from "./db.js";
import * as billing from "./billing.js";

async function main() {
  await db.initSchema();

  const tid = Date.now(); // уникальный "телеграм id" для теста
  console.log("Тестовый telegram_id:", tid);

  // --- 1. Новый пользователь: бесплатный поиск доступен ---
  let user = await db.getOrCreateUser(tid, { username: "test_user", firstName: "Test" });
  let access = billing.checkAccess(user);
  assert.equal(access.allowed, true);
  assert.equal(access.billedAs, "free");
  console.log("✓ Новый пользователь получает бесплатный поиск");

  // --- 2. После использования бесплатного поиска — блок с cta=subscribe ---
  await billing.recordSearchCompleted(tid, { billedAs: "free", intent: "brand_to_blogger", model: "test", inputTokens: 100, outputTokens: 200 });
  user = await db.getUser(tid);
  assert.equal(user.free_search_used, true);
  access = billing.checkAccess(user);
  assert.equal(access.allowed, false);
  assert.equal(access.cta, "subscribe");
  console.log("✓ После бесплатного поиска доступ заблокирован с cta=subscribe");

  // --- 3. Активная подписка: 50 доступных поисков ---
  const now = new Date();
  const periodEnd = new Date(now);
  periodEnd.setMonth(periodEnd.getMonth() + 1);
  await db.updateUser(tid, {
    subscription_status: "active",
    subscription_period_start: now.toISOString(),
    subscription_period_end: periodEnd.toISOString(),
    searches_used_this_period: 0,
  });
  user = await db.getUser(tid);
  access = billing.checkAccess(user);
  assert.equal(access.allowed, true);
  assert.equal(access.billedAs, "subscription");
  console.log("✓ Активная подписка даёт доступ (billedAs=subscription)");

  // --- 4. Списываем 49 поисков вручную, затем один через recordSearchCompleted -> достигаем 50 ---
  await db.query(`UPDATE users SET searches_used_this_period = 49 WHERE telegram_id = $1`, [tid]);
  await billing.recordSearchCompleted(tid, { billedAs: "subscription", intent: "blogger_to_brand", model: "test", inputTokens: 10, outputTokens: 10 });
  user = await db.getUser(tid);
  assert.equal(user.searches_used_this_period, 50);
  access = billing.checkAccess(user);
  assert.equal(access.allowed, false);
  assert.equal(access.cta, "addon");
  console.log("✓ После 50 поисков в периоде — заблокировано с cta=addon");

  // --- 5. Докупленный пакет открывает доступ, списывается корректно ---
  await db.query(`UPDATE users SET addon_searches_remaining = 20 WHERE telegram_id = $1`, [tid]);
  user = await db.getUser(tid);
  access = billing.checkAccess(user);
  assert.equal(access.allowed, true);
  assert.equal(access.billedAs, "addon");
  await billing.recordSearchCompleted(tid, { billedAs: "addon", intent: "blogger_to_blogger", model: "test", inputTokens: 5, outputTokens: 5 });
  user = await db.getUser(tid);
  assert.equal(user.addon_searches_remaining, 19);
  console.log("✓ Пакет +20 списывается по единице, доступ есть пока остаток > 0");

  // --- 6. Продление через applySucceededPayment(subscription_recurring) сдвигает период от СТАРОЙ даты окончания, не от "сейчас" ---
  const oldPeriodEnd = new Date(user.subscription_period_end);
  await billing.applySucceededPayment({
    id: "test_payment_recurring",
    metadata: { telegram_id: String(tid), type: "subscription_recurring" },
  });
  user = await db.getUser(tid);
  const newPeriodEnd = new Date(user.subscription_period_end);
  const expected = new Date(oldPeriodEnd);
  expected.setMonth(expected.getMonth() + 1);
  assert.equal(newPeriodEnd.toISOString(), expected.toISOString());
  assert.equal(user.searches_used_this_period, 0);
  assert.equal(user.addon_searches_remaining, 0);
  console.log("✓ Продление подписки сдвигает period_end от старой даты (не от now), обнуляет счётчики и сгорает addon");

  // --- 7. Неуспешные автосписания: грейс-период 3 попытки, затем inactive ---
  await db.updateUser(tid, { subscription_status: "active", renewal_failed_attempts: 0 });
  for (let i = 1; i <= 2; i++) {
    await billing.applyFailedPayment({ metadata: { telegram_id: String(tid), type: "subscription_recurring" } });
    user = await db.getUser(tid);
    assert.equal(user.subscription_status, "active", `после ${i}-й неудачи подписка должна оставаться active`);
  }
  await billing.applyFailedPayment({ metadata: { telegram_id: String(tid), type: "subscription_recurring" } });
  user = await db.getUser(tid);
  assert.equal(user.subscription_status, "inactive");
  console.log("✓ После 3 неудачных автосписаний подряд подписка деактивируется");

  // --- 8. Идемпотентность insertPayment по yookassa_payment_id ---
  const dupId = `dup_test_${tid}`;
  const p1 = await db.insertPayment(tid, { yookassaPaymentId: dupId, type: "addon", amountRub: 299, status: "pending", rawPayload: { a: 1 } });
  assert.ok(p1);
  const p2 = await db.insertPayment(tid, { yookassaPaymentId: dupId, type: "addon", amountRub: 299, status: "pending", rawPayload: { a: 1 } });
  assert.equal(p2, null); // ON CONFLICT DO NOTHING -> ничего не вернулось
  console.log("✓ Повторная вставка платежа с тем же yookassa_payment_id идемпотентна");

  // --- 9. Сообщения и подготовка данных для суммаризации ---
  for (let i = 0; i < 12; i++) {
    const seq = await db.getNextSeq(tid);
    await db.insertMessage(tid, seq, i % 2 === 0 ? "user" : "assistant", `Сообщение номер ${seq} `.repeat(20));
  }
  const recent = await db.getRecentMessages(tid, 8);
  assert.equal(recent.length, 8);
  const all = await db.getAllMessages(tid);
  assert.equal(all.length, 12);
  console.log("✓ getRecentMessages/getAllMessages работают корректно (8 последних из 12)");

  console.log("\nВСЕ ПРОВЕРКИ ПРОШЛИ УСПЕШНО");
  process.exit(0);
}

main().catch((err) => {
  console.error("ТЕСТ УПАЛ:", err);
  process.exit(1);
});
