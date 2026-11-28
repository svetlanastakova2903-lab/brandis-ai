import crypto from 'node:crypto';
import {publicClaim, checkoutVerification} from './verification-payments.js';
import {profileKey} from './catalog-priority.js';

// This phase only collects claims. Payment and a Telegram login never grant a badge.
export function validateClaim(body) {
  let url;
  try { url = new URL(body?.profile_url); } catch { throw new Error('Укажите ссылку на свой профиль.'); }
  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
      !['instagram.com', 't.me', 'vk.com', 'youtube.com'].includes(host) || url.pathname === '/') {
    throw new Error('Нужна HTTPS-ссылка на профиль Instagram, Telegram, VK или YouTube.');
  }
  url.hostname = host;
  const profilePath=url.pathname.replace(/\/$/,'');
  const validPath = host === 'youtube.com' ? /^\/@[a-zA-Z0-9_.-]+$/.test(profilePath) : /^\/[a-zA-Z0-9_.-]+$/.test(profilePath);
  const reserved={ 'instagram.com':['p','reel','reels','stories','explore','accounts'], 't.me':['share','joinchat','addstickers','proxy'], 'vk.com':['feed','video','wall','login'], 'youtube.com':[] };
  if(!validPath || reserved[host].includes(profilePath.slice(1).toLowerCase())) throw new Error('Укажите ссылку на сам профиль, а не публикацию или приглашение.');
  url.pathname=profilePath.toLowerCase();
  url.search = '';
  url.hash = '';
  const profileUrl = url.toString().replace(/\/$/, '');
  if (profileUrl.length > 500) throw new Error('Ссылка слишком длинная.');
  const phone = typeof body.phone === 'string' ? body.phone.replace(/[ ()-]/g, '') : '';
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone)) throw new Error('Укажите телефон с кодом страны, например +7…');
  if (body.contact_consent !== true) throw new Error('Нужно согласие на связь для проверки анкеты.');
  return { profileUrl, phone };
}

export async function initVerificationSchema(query) {
  await query(`CREATE TABLE IF NOT EXISTS verification_claims (
    id UUID PRIMARY KEY,
    telegram_id BIGINT NOT NULL REFERENCES users(telegram_id),
    profile_url TEXT NOT NULL,
    phone TEXT NOT NULL,
    proof_code TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'awaiting_payment' CHECK (status IN
      ('awaiting_proof','awaiting_payment','pending_review','needs_information','verified','rejected','refund_pending','refunded')),
    contact_consent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (telegram_id, profile_url)
  )`);
  await query(`ALTER TABLE verification_claims ALTER COLUMN status SET DEFAULT 'awaiting_payment'`);
  await query(`ALTER TABLE verification_claims ADD COLUMN IF NOT EXISTS payment_id TEXT UNIQUE,
    ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS checkout_key UUID,
    ADD COLUMN IF NOT EXISTS checkout_started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS checkout_return_url TEXT,
    ADD COLUMN IF NOT EXISTS reviewed_by BIGINT,
    ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS review_note TEXT`);
  await query(`ALTER TABLE verification_claims ADD COLUMN IF NOT EXISTS offers_enabled BOOLEAN NOT NULL DEFAULT false`);
  await query(`ALTER TABLE verification_claims ADD COLUMN IF NOT EXISTS catalog_uid TEXT`);
  await query(`CREATE TABLE IF NOT EXISTS profile_selections (
    telegram_id BIGINT PRIMARY KEY REFERENCES users(telegram_id),
    catalog_uid TEXT NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // Multiple people may claim a profile, but only one may ever own its verified badge.
  await query(`CREATE UNIQUE INDEX IF NOT EXISTS verification_verified_profile
    ON verification_claims(profile_url) WHERE status = 'verified'`);
}

export function containsProof(description, code) {
  return typeof description==='string' && typeof code==='string' && /^BRANDIS-[A-F0-9]{16}$/.test(code) &&
    description.split(/[^A-Za-z0-9-]+/).includes(code);
}

export function registerVerificationRoutes(app, {requireAuth, query, enabled, pool, provider, returnUrl, getProfiles=()=>[], readDescription=async()=>null, paymentsEnabled=()=>false, adminIds=()=>[]}) {
  const available = (req,res,next) => enabled() ? next() : res.status(503).json({error:'Верификация пока не открыта.'});
  const findCard = uid => typeof uid==='string' && /^[0-9]{1,30}$/.test(uid) ? getProfiles().find(item => String(item.uid) === uid) : undefined;
  const publicCard = item => item ? {uid:String(item.uid),name:item.name,photo:item.photo,
    contact:item.profile_url||item.contact,city:item.city} : null;
  app.get('/api/verification/catalog/:uid', available, (req,res) => {
    const item=findCard(req.params.uid);
    if(!item)return res.status(404).json({error:'Анкета не найдена. Выберите её заново в каталоге.'});
    res.json({profile:publicCard(item)});
  });
  app.get('/api/verification/selection', available, requireAuth, async(req,res)=>{
    try{
      const {rows:[row]}=await query('SELECT catalog_uid FROM profile_selections WHERE telegram_id=$1',[req.telegramId]);
      res.json({profile:row ? publicCard(findCard(row.catalog_uid)) : null, missing:!!row&&!findCard(row.catalog_uid)});
    }catch{res.status(500).json({error:'Не удалось загрузить выбранную анкету.'});}
  });
  app.post('/api/verification/selection', available, requireAuth, async(req,res)=>{
    const item=findCard(req.body?.catalog_uid);
    if(!item)return res.status(404).json({error:'Анкета не найдена. Выберите её заново в каталоге.'});
    try{
      await query(`INSERT INTO profile_selections (telegram_id,catalog_uid) VALUES ($1,$2)
        ON CONFLICT (telegram_id) DO UPDATE SET catalog_uid=EXCLUDED.catalog_uid,updated_at=now()`,[req.telegramId,String(item.uid)]);
      res.json({profile:publicCard(item)});
    }catch{res.status(500).json({error:'Не удалось сохранить выбранную анкету.'});}
  });
  app.get('/api/verification/me', available, requireAuth, async (req,res) => {
    try {
      const {rows} = await query(`SELECT *
        FROM verification_claims WHERE telegram_id=$1 ORDER BY created_at DESC`, [req.telegramId]);
      res.json({claims:rows.map(publicClaim), payments_enabled:paymentsEnabled(req.telegramId), price_rub:500,telegram_id:String(req.telegramId)});
    } catch { res.status(500).json({error:'Не удалось загрузить заявки.'}); }
  });
  app.post('/api/verification/claims', available, requireAuth, async (req,res) => {
    let data;
    try {
      const selected=req.body?.catalog_uid ? findCard(req.body.catalog_uid) : null;
      if(req.body?.catalog_uid && !selected)throw new Error('Выбранная анкета не найдена в каталоге.');
      data = validateClaim(selected ? {...req.body,profile_url:selected.profile_url||selected.contact} : req.body);
      data.catalogUid=selected ? String(selected.uid) : null;
    }
    catch (error) { return res.status(400).json({error:error.message}); }
    if(!getProfiles().some(item=>profileKey(item.profile_url||item.contact)===profileKey(data.profileUrl)))return res.status(409).json({error:'Сначала добавьте анкету в каталог Brandis. Проверка оплачивается после её размещения.'});
    try {
      const {rows:[owner]}=await query(`SELECT telegram_id FROM verification_claims WHERE profile_url=$1 AND status='verified'`,[data.profileUrl]);
      if(owner && String(owner.telegram_id)!==String(req.telegramId))return res.status(409).json({error:'У этой анкеты уже подтверждён владелец. Для изменения владельца обратитесь в поддержку.'});
      const {rows} = await query(`INSERT INTO verification_claims
        (id,telegram_id,profile_url,phone,proof_code,catalog_uid)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (telegram_id,profile_url) DO UPDATE SET catalog_uid=COALESCE(verification_claims.catalog_uid,EXCLUDED.catalog_uid)
        RETURNING *`,
        [crypto.randomUUID(),req.telegramId,data.profileUrl,data.phone,'BRANDIS-'+crypto.randomBytes(8).toString('hex').toUpperCase(),data.catalogUid]);
      res.status(200).json({claim:publicClaim(rows[0])});
    } catch { res.status(500).json({error:'Не удалось сохранить заявку.'}); }
  });
  app.post('/api/verification/claims/:id/pay', available, requireAuth, async (req,res) => {
    if (!paymentsEnabled(req.telegramId)) return res.status(503).json({error:'Оплата верификации пока не открыта для этого аккаунта.'});
    try {
      const {rows:[claim]}=await query('SELECT profile_url FROM verification_claims WHERE id=$1 AND telegram_id=$2',[req.params.id,req.telegramId]);
      if(!claim || !getProfiles().some(item=>profileKey(item.profile_url||item.contact)===profileKey(claim.profile_url)))return res.status(409).json({error:'Анкета не найдена в каталоге. Оплата недоступна.'});
      res.json(await checkoutVerification({pool,provider,claimId:req.params.id,telegramId:req.telegramId,returnUrl:returnUrl()})); }
    catch(error) { res.status(409).json({error:error.message}); }
  });
  app.post('/api/verification/claims/:id/notifications',available,requireAuth,async(req,res)=>{
    if(typeof req.body?.enabled!=='boolean')return res.status(400).json({error:'Укажите, хотите ли вы получать предложения.'});
    try{
      const {rows:[claim]}=await query(`UPDATE verification_claims SET offers_enabled=$3,updated_at=now() WHERE id=$1 AND telegram_id=$2 RETURNING *`,[req.params.id,req.telegramId,req.body.enabled]);
      if(!claim)return res.sendStatus(404);
      res.json({claim:publicClaim(claim)});
    }catch{res.sendStatus(500);}
  });
  app.post('/api/verification/claims/:id/check', available, requireAuth, async (req,res) => {
    try {
      const {rows:[claim]}=await query(`SELECT * FROM verification_claims WHERE id=$1 AND telegram_id=$2`,[req.params.id,req.telegramId]);
      if(!claim?.paid_at || !['awaiting_proof','needs_information','pending_review'].includes(claim.status)) return res.status(409).json({error:'Сначала завершите оплату или обновите статус заявки.'});
      let description=null;
      try { description=await readDescription(claim.profile_url); } catch { /* unavailable => manual review */ }
      const verified=containsProof(description,claim.proof_code);
      const {rows} = await query(`UPDATE verification_claims SET status='pending_review',updated_at=now()
        WHERE id=$1 AND telegram_id=$2 AND paid_at IS NOT NULL AND status IN ('awaiting_proof','needs_information','pending_review')
        RETURNING *`,[req.params.id,req.telegramId]);
      if (!rows[0]) return res.status(409).json({error:'Сначала завершите оплату или обновите статус заявки.'});
      if(verified){
        const {rows:[approved]}=await query(`UPDATE verification_claims SET status='verified',reviewed_at=now(),review_note='Код подтверждён через Telegram Bot API',updated_at=now()
          WHERE id=$1 AND telegram_id=$2 AND paid_at IS NOT NULL AND status='pending_review' RETURNING *`,[claim.id,req.telegramId]);
        if(approved)return res.json({claim:publicClaim(approved),message:'Владелец подтверждён. Код можно удалить из описания.'});
      }
      res.json({claim:publicClaim(rows[0]),message:'Заявка передана на проверку. Сохраните код в описании профиля до получения результата. Повторная оплата не нужна.'});
    } catch { res.status(500).json({error:'Не удалось отправить заявку на проверку.'}); }
  });
  const admin = (req,res,next) => adminIds().includes(String(req.telegramId)) ? next() : res.sendStatus(403);
  app.post('/api/verification/review/:id/revoke',available,requireAuth,admin,async(req,res)=>{
    const note=typeof req.body?.note==='string'?req.body.note.trim():'';
    if(note.length<5 || note.length>1000)return res.status(400).json({error:'Укажите причину снятия подтверждения.'});
    try{
      const {rows:[claim]}=await query(`UPDATE verification_claims SET status='rejected',offers_enabled=false,review_note=$2,reviewed_by=$3,reviewed_at=now(),updated_at=now() WHERE id=$1 AND status='verified' RETURNING *`,[req.params.id,note,req.telegramId]);
      if(!claim)return res.sendStatus(409);res.json({claim:publicClaim(claim)});
    }catch{res.sendStatus(500);}
  });
  app.get('/api/verification/review', available, requireAuth, admin, async (req,res) => {
    try {
      const {rows} = await query(`SELECT id,profile_url,proof_code,status,created_at FROM verification_claims
        WHERE status='pending_review' AND paid_at IS NOT NULL ORDER BY updated_at LIMIT 100`);
      res.json({claims:rows});
    } catch { res.sendStatus(500); }
  });
  app.post('/api/verification/review/:id', available, requireAuth, admin, async (req,res) => {
    const decision = req.body?.decision;
    const note = typeof req.body?.note === 'string' ? req.body.note.trim() : '';
    if (!['verified','needs_information','refund_pending'].includes(decision) || note.length < 5 || note.length > 1000) {
      return res.status(400).json({error:'Укажите результат проверки и комментарий (5–1000 символов).'});
    }
    try {
      const {rows} = await query(`UPDATE verification_claims SET status=$2,review_note=$3,
        reviewed_by=$4,reviewed_at=now(),updated_at=now()
        WHERE id=$1 AND paid_at IS NOT NULL AND status='pending_review' RETURNING *`,[req.params.id,decision,note,req.telegramId]);
      if (!rows[0]) return res.status(409).json({error:'Заявка уже обработана или не оплачена.'});
      res.json({claim:publicClaim(rows[0])});
    } catch { res.status(409).json({error:'Не удалось подтвердить. Проверьте, не закреплён ли профиль за другим владельцем.'}); }
  });
}
