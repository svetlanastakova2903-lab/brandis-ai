import crypto from 'node:crypto';

export function matchesVerificationPayment(payment, claim) {
  return !!payment?.id && payment.metadata?.type === 'verification' &&
    payment.metadata.claim_id === claim.id &&
    String(payment.metadata.telegram_id) === String(claim.telegram_id) &&
    payment.amount?.value === '500.00' && payment.amount?.currency === 'RUB' &&
    (!claim.payment_id || claim.payment_id === payment.id);
}

export function publicClaim(row) {
  const {id, profile_url, status, created_at} = row;
  return {id, profile_url, status, created_at, offers_enabled:row.offers_enabled===true,
    proof_code: row.paid_at && !['refund_pending','refunded','rejected'].includes(status) ? row.proof_code : null};
}

async function transaction(pool, action) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function applyVerificationPayment(pool, payment) {
  if (payment?.metadata?.type !== 'verification') return false;
  await transaction(pool, async client => {
    const {rows:[claim]} = await client.query('SELECT * FROM verification_claims WHERE id=$1 FOR UPDATE', [payment.metadata.claim_id]);
    if (!claim || !claim.checkout_started_at || !matchesVerificationPayment(payment,claim)) throw new Error('Verification payment mismatch');
    if (payment.status !== 'succeeded' || payment.paid !== true) return;
    // A repeated or late notification cannot revert a reviewed/refunded claim.
    if (claim.paid_at) return;
    await client.query(`UPDATE verification_claims SET payment_id=$2, paid_at=now(),
      status='awaiting_proof',updated_at=now() WHERE id=$1 AND status='awaiting_payment'`,[claim.id,payment.id]);
  });
  return true;
}

export async function checkoutVerification({pool,provider,claimId,telegramId,returnUrl}) {
  // Persist the request identity BEFORE calling the provider. Retries reuse it even after a crash.
  const claim = await transaction(pool, async client => {
    const {rows:[row]} = await client.query('SELECT * FROM verification_claims WHERE id=$1 AND telegram_id=$2 FOR UPDATE',[claimId,telegramId]);
    if (!row) throw new Error('Заявка не найдена.');
    if (row.status !== 'awaiting_payment') return row;
    if (!row.checkout_started_at) {
      const {rows:[updated]} = await client.query(`UPDATE verification_claims SET checkout_key=$2,
        checkout_started_at=now(),checkout_return_url=$3 WHERE id=$1 RETURNING *`,[row.id,crypto.randomUUID(),returnUrl]);
      return updated;
    }
    return row;
  });
  if (claim.status !== 'awaiting_payment') return {claim:publicClaim(claim)};
  let payment;
  if (claim.payment_id) payment = await provider.getPayment(claim.payment_id);
  else {
    // YooKassa retains idempotence for 24 hours. Never silently generate a second charge afterwards.
    if (Date.now()-new Date(claim.checkout_started_at).getTime() > 23*60*60*1000) {
      throw new Error('Проверяем состояние предыдущей оплаты. Не платите повторно — обратитесь в поддержку.');
    }
    payment = await provider.createVerificationPayment({claimId:claim.id,telegramId,
      returnUrl:claim.checkout_return_url,idempotenceKey:claim.checkout_key});
  }
  if (!matchesVerificationPayment(payment,claim)) throw new Error('Не удалось сверить платёж.');
  await pool.query(`UPDATE verification_claims SET payment_id=$2 WHERE id=$1 AND (payment_id IS NULL OR payment_id=$2)`,[claim.id,payment.id]);
  await applyVerificationPayment(pool,payment);
  if (payment.status === 'canceled') throw new Error('Платёж отменён. Обратитесь в поддержку для повторной попытки.');
  if (payment.status === 'succeeded') return {paid:true};
  const url = new URL(payment.confirmation?.confirmation_url);
  if (url.protocol !== 'https:') throw new Error('Некорректная ссылка оплаты.');
  return {confirmation_url:url.href};
}
