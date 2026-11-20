import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import crypto from 'node:crypto';
import {initVerificationSchema,registerVerificationRoutes} from './verification.js';
import {initOffersSchema,registerOfferRoutes,deliverOffers} from './offers.js';
import {registerCatalogRoutes} from './catalog-priority.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');
test('HTTP flow: claim, payment, ownership, ranking, opt-in and delivery',async()=>{
 const database=new PGlite(),query=(sql,args)=>database.query(sql,args);
 const pool={query,async connect(){return{query,release(){}};}};
 await query('CREATE TABLE users(telegram_id BIGINT PRIMARY KEY)');await query('INSERT INTO users VALUES(1),(2)');
 await initVerificationSchema(query);await initOffersSchema(query);
 const items=[{name:'Ordinary',city:'Рязань',contact:'https://instagram.com/ordinary'},{name:'Owner',city:'Москва',contact:'https://instagram.com/owner'}];
 const app=express();app.use(express.json());
 const requireAuth=(req,res,next)=>{if(!['1','2'].includes(req.get('authorization')))return res.sendStatus(401);req.telegramId=req.get('authorization');next();};
 let payment;
 const provider={async createVerificationPayment({claimId,telegramId}){payment={id:'local-payment',paid:true,status:'succeeded',metadata:{type:'verification',claim_id:claimId,telegram_id:telegramId},amount:{value:'500.00',currency:'RUB'}};return payment;},async getPayment(){return payment;}};
 registerVerificationRoutes(app,{requireAuth,query,pool,provider,enabled:()=>true,paymentsEnabled:()=>true,returnUrl:()=> 'https://example.test/me',getProfiles:()=>items,
   readDescription:async()=> (await query('SELECT proof_code FROM verification_claims')).rows[0].proof_code});
 registerCatalogRoutes(app,{getCatalog:()=>items,query,enabled:()=>true});
 registerOfferRoutes(app,{requireAuth,pool,query,enabled:()=>true});
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 const base='http://127.0.0.1:'+server.address().port;
 const call=async(path,body,user='1')=>{const response=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json().catch(()=>null)};};
 try{
  assert.equal((await call('/api/verification/me',null,'')).status,401);
  assert.equal((await call('/api/verification/claims',{profile_url:'https://instagram.com/missing',contact_consent:true})).status,409);
  const {data:{claim}}=await call('/api/verification/claims',{profile_url:items[1].contact,contact_consent:true});
  assert.equal(claim.proof_code,null);
  assert.equal((await call('/api/verification/claims/'+claim.id+'/check',{})).status,409);
  assert.equal((await call('/api/verification/claims/'+claim.id+'/pay',{})).status,200);
  assert.equal((await call('/api/catalog')).data.items[0].name,'Ordinary');
  assert.equal((await call('/api/verification/claims/'+claim.id+'/check',{},'2')).status,409);
  assert.equal((await call('/api/verification/claims/'+claim.id+'/check',{})).data.claim.status,'verified');
  assert.equal((await call('/api/catalog')).data.items[0].name,'Owner');
  assert.equal((await call('/api/catalog?city='+encodeURIComponent('Рязань'))).data.total,1);
  const input={claim_id:claim.id,request_id:crypto.randomUUID(),message:'Предложение сотрудничества',contact:'@sender',share_contact:true};
  assert.equal((await call('/api/offers',input,'2')).status,409);
  await call('/api/verification/claims/'+claim.id+'/notifications',{enabled:true});
  const offer=await call('/api/offers',input,'2');assert.equal(offer.status,202);
  assert.equal((await call('/api/offers/'+offer.data.id,null,'1')).status,404);
  await deliverOffers({query,sendMessage:async()=>({ok:true,result:{message_id:1}})});
  assert.equal((await call('/api/offers/'+offer.data.id,null,'2')).data.status,'delivered');
 }finally{await new Promise(resolve=>server.close(resolve));await database.close();}
});
