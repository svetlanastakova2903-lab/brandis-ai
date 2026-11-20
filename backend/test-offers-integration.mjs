// Run with PGLITE_MODULE pointing to the installed @electric-sql/pglite module.
// PGlite executes PostgreSQL, rather than mocking SQL statements.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {initVerificationSchema} from './verification.js';
import {initOffersSchema,createOffer,deliverOffers,validateOffer,offerText} from './offers.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
const database=new PGlite();
const query=(sql,args)=>database.query(sql,args);
const pool={query,async connect(){return {query,release(){}};}};
await query('CREATE TABLE users(telegram_id BIGINT PRIMARY KEY)');
await query('INSERT INTO users VALUES(1),(2),(3)');
await initVerificationSchema(query);
await initOffersSchema(query);
const claim=crypto.randomUUID();
await query(`INSERT INTO verification_claims(id,telegram_id,profile_url,phone,proof_code,status,paid_at,offers_enabled)
  VALUES($1,1,'https://instagram.com/test','','BRANDIS-1234567890ABCDEF','verified',now(),true)`,[claim]);
const body=()=>({claim_id:claim,request_id:crypto.randomUUID(),message:'Предлагаем совместный проект <hello>',contact:'@sender',share_contact:true});
test('validates message and explicit contact consent; escapes Telegram HTML',()=>{
  assert.throws(()=>validateOffer({...body(),share_contact:false}));
  assert.throws(()=>validateOffer({...body(),message:'short'}));
  assert.throws(()=>validateOffer({...body(),contact:'one\ntwo'}));
  assert.match(offerText({id:'id',profile_url:'url',message:'<b>x&y</b>',contact:'@user'}),/&lt;b&gt;x&amp;y/);
});
test('same request cannot create two offers, even after a successful delivery',async()=>{
  const input=body();const first=await createOffer({pool,senderId:2,input});
  assert.deepEqual(await createOffer({pool,senderId:2,input}),first);
  await assert.rejects(createOffer({pool,senderId:2,input:{...input,message:'Изменённое предложение'}}));
  let sends=0;
  await deliverOffers({query,sendMessage:async(recipient,text)=>{assert.equal(String(recipient),'1');assert.match(text,/@sender/);sends++;return {ok:true,result:{message_id:77}};}});
  assert.equal(sends,1);
  assert.equal((await createOffer({pool,senderId:2,input})).status,'delivered');
  await deliverOffers({query,sendMessage:async()=>{sends++;}});assert.equal(sends,1);
});
test('self offers, recipient hourly limit, opt out and unverified recipients rejected',async()=>{
  await assert.rejects(createOffer({pool,senderId:1,input:body()}));
  await assert.rejects(createOffer({pool,senderId:2,input:body()}));
  await query('UPDATE verification_claims SET offers_enabled=false WHERE id=$1',[claim]);
  await assert.rejects(createOffer({pool,senderId:3,input:body()}));
  await query("UPDATE verification_claims SET offers_enabled=true,status='pending_review' WHERE id=$1",[claim]);
  await assert.rejects(createOffer({pool,senderId:3,input:body()}));
  await query("UPDATE verification_claims SET status='verified' WHERE id=$1",[claim]);
});
test('timeout produces an uncertain delivery and is not retried automatically',async()=>{
  const offer=await createOffer({pool,senderId:3,input:body()});let sends=0;
  await deliverOffers({query,sendMessage:async()=>{sends++;throw new Error('timeout');}});
  assert.equal((await query('SELECT status FROM collaboration_offers WHERE id=$1',[offer.id])).rows[0].status,'unknown');
  await deliverOffers({query,sendMessage:async()=>{sends++;}});assert.equal(sends,1);
});
test('queued proposal is cancelled after the owner opts out',async()=>{
  await query("UPDATE collaboration_offers SET created_at=now()-interval '2 hours'");
  const offer=await createOffer({pool,senderId:3,input:body()});
  await query('UPDATE verification_claims SET offers_enabled=false WHERE id=$1',[claim]);
  await deliverOffers({query,sendMessage:async()=>{assert.fail('must not send');}});
  assert.equal((await query('SELECT status FROM collaboration_offers WHERE id=$1',[offer.id])).rows[0].status,'cancelled');
});
test.after(async()=>database.close());
