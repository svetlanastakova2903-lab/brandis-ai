import crypto from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateOffer(body) {
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  const contact = typeof body?.contact === 'string' ? body.contact.trim() : '';
  if (!UUID.test(body?.claim_id || '') || !UUID.test(body?.request_id || '')) throw new Error('Обновите страницу анкеты и попробуйте ещё раз.');
  if (message.length < 10 || message.length > 2000) throw new Error('Напишите предложение от 10 до 2000 символов.');
  if (!contact || contact.length > 200 || /[\r\n\x00-\x1f]/.test(contact)) throw new Error('Укажите контакт для ответа, до 200 символов.');
  if (body.share_contact !== true) throw new Error('Подтвердите передачу контакта получателю.');
  return {claimId: body.claim_id, requestId: body.request_id, message, contact};
}
export function offerText(offer) {
  const escape = value => String(value).replace(/[&<>]/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[char]));
  return `<b>Новое предложение в Brandis</b>\nАнкета: ${escape(offer.profile_url)}\n\n${escape(offer.message)}\n\n<b>Контакт для ответа:</b> ${escape(offer.contact)}\n\nЗаявка №${escape(offer.id)}`;
}
export async function initOffersSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS collaboration_offers (
    id UUID PRIMARY KEY, request_id UUID NOT NULL,
    sender_id BIGINT NOT NULL REFERENCES users(telegram_id),
    claim_id UUID NOT NULL REFERENCES verification_claims(id),
    recipient_id BIGINT NOT NULL REFERENCES users(telegram_id),
    profile_url TEXT NOT NULL, message TEXT NOT NULL, contact TEXT NOT NULL,
    consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','delivered','failed','unknown','cancelled')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(), attempted_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ, telegram_message_id BIGINT,
    UNIQUE(sender_id, request_id)
  )`);
  await query(`CREATE INDEX IF NOT EXISTS collaboration_offers_sender_time ON collaboration_offers(sender_id,created_at)`);
}
export async function createOffer({pool, senderId, input}) {
  const data = validateOffer(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Serialize one sender across processes so simultaneous clicks cannot bypass limits.
    await client.query('SELECT telegram_id FROM users WHERE telegram_id=$1 FOR UPDATE',[senderId]);
    const {rows:[existing]}=await client.query('SELECT id,status,claim_id,message,contact FROM collaboration_offers WHERE sender_id=$1 AND request_id=$2',[senderId,data.requestId]);
    if(existing){
      if(existing.claim_id!==data.claimId || existing.message!==data.message || existing.contact!==data.contact) throw new Error('Этот запрос уже использован для другого предложения.');
      await client.query('COMMIT');
      return {id:existing.id,status:existing.status};
    }
    const {rows:[claim]}=await client.query(`SELECT id,telegram_id,profile_url FROM verification_claims
      WHERE id=$1 AND status='verified' AND paid_at IS NOT NULL AND offers_enabled=true FOR SHARE`,[data.claimId]);
    if(!claim) throw new Error('Эта анкета пока не принимает предложения.');
    if(String(claim.telegram_id)===String(senderId)) throw new Error('Нельзя отправить предложение собственной анкете. Для проверки войдите с другого аккаунта.');
    const {rows:[limits]}=await client.query(`SELECT count(*) AS daily,
      count(*) FILTER(WHERE recipient_id=$2 AND created_at>now()-interval '1 hour') AS recipient
      FROM collaboration_offers WHERE sender_id=$1 AND created_at>now()-interval '1 day'`,[senderId,claim.telegram_id]);
    if(Number(limits.daily)>=10 || Number(limits.recipient)>=1) throw new Error('Лимит предложений достигнут. Одному получателю можно написать раз в час, всего — 10 раз в сутки.');
    const id=crypto.randomUUID();
    await client.query(`INSERT INTO collaboration_offers(id,request_id,sender_id,claim_id,recipient_id,profile_url,message,contact)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,data.requestId,senderId,data.claimId,claim.telegram_id,claim.profile_url,data.message,data.contact]);
    await client.query('COMMIT');
    return {id,status:'queued'};
  } catch(error){await client.query('ROLLBACK');throw error;}
  finally{client.release();}
}
export async function deliverOffers({query,sendMessage}) {
  // Telegram sendMessage has no idempotency key: uncertain sends must be reviewed,
  // not blindly resent after a timeout or process crash.
  await query(`UPDATE collaboration_offers SET status='unknown' WHERE status='sending' AND attempted_at<now()-interval '5 minutes'`);
  for(let i=0;i<10;i++){
    const {rows:[offer]}=await query(`UPDATE collaboration_offers SET status='sending',attempted_at=now()
      WHERE id=(SELECT id FROM collaboration_offers WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING *`);
    if(!offer) break;
    const {rows:[owner]}=await query(`SELECT telegram_id FROM verification_claims WHERE id=$1 AND status='verified' AND paid_at IS NOT NULL AND offers_enabled=true`,[offer.claim_id]);
    if(!owner || String(owner.telegram_id)!==String(offer.recipient_id)){
      await query(`UPDATE collaboration_offers SET status='cancelled' WHERE id=$1`,[offer.id]);continue;
    }
    let result;
    try {result=await sendMessage(offer.recipient_id,offerText(offer));}
    catch {await query(`UPDATE collaboration_offers SET status='unknown' WHERE id=$1`,[offer.id]);continue;}
    if(result?.ok && result.result?.message_id){
      await query(`UPDATE collaboration_offers SET status='delivered',delivered_at=now(),telegram_message_id=$2 WHERE id=$1`,[offer.id,result.result.message_id]);
    }else{
      await query(`UPDATE collaboration_offers SET status=$2 WHERE id=$1`,[offer.id,result?.ok===false?'failed':'unknown']);
    }
  }
}
export function registerOfferRoutes(app,{requireAuth,pool,query,enabled}){
  const available=(req,res,next)=>enabled()?next():res.status(503).json({error:'Предложения пока не открыты.'});
  app.post('/api/offers',available,requireAuth,async(req,res)=>{
    try{res.status(202).json(await createOffer({pool,senderId:req.telegramId,input:req.body}));}
    catch(error){res.status(409).json({error:error.message});}
  });
  app.get('/api/offers/:id',available,requireAuth,async(req,res)=>{
    if(!UUID.test(req.params.id))return res.sendStatus(404);
    try{
      const {rows:[offer]}=await query('SELECT id,status,created_at,delivered_at FROM collaboration_offers WHERE id=$1 AND sender_id=$2',[req.params.id,req.telegramId]);
      if(!offer)return res.sendStatus(404);
      res.set('Cache-Control','no-store').json(offer);
    }catch{res.sendStatus(503);}
  });
}
