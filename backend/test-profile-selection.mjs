import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {initVerificationSchema,registerVerificationRoutes} from './verification.js';
const {PGlite}=await import(process.env.PGLITE_MODULE||'@electric-sql/pglite');

test('selection survives login sessions, isolates users and grants no ownership',async()=>{
  const db=new PGlite(),query=(sql,args)=>db.query(sql,args);
  await query('CREATE TABLE users(telegram_id BIGINT PRIMARY KEY)');
  await query('INSERT INTO users VALUES(1),(2)');await initVerificationSchema(query);
  const items=[{uid:'123',name:'Example',contact:'https://instagram.com/example',photo:'https://example.test/photo.jpg'}];
  const app=express();app.use(express.json());
  const requireAuth=(req,res,next)=>{const user=req.get('authorization');if(!['1','2'].includes(user))return res.sendStatus(401);req.telegramId=user;next();};
  registerVerificationRoutes(app,{query,requireAuth,enabled:()=>true,getProfiles:()=>items});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const call=async(path,body,user='1')=>{const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/verification'+path,{method:body?'POST':'GET',headers:{Authorization:user,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json().catch(()=>null)};};
  try{
    assert.equal((await call('/catalog/123',null,'')).data.profile.name,'Example');
    assert.equal((await call('/selection',{catalog_uid:'123'},'')).status,401);
    assert.equal((await call('/selection',{catalog_uid:'missing'})).status,404);
    assert.equal((await call('/selection',{catalog_uid:'123',telegram_id:2,status:'verified'})).status,200);
    assert.equal((await call('/selection')).data.profile.uid,'123');
    assert.equal((await call('/selection',null,'2')).data.profile,null);
    await call('/selection',{catalog_uid:'123'});
    assert.equal((await query('SELECT * FROM profile_selections')).rows.length,1);
    assert.equal((await query('SELECT * FROM verification_claims')).rows.length,0);
    const claim=(await call('/claims',{catalog_uid:'123',profile_url:'https://instagram.com/attacker',contact_consent:true})).data.claim;
    assert.equal(claim.catalog_uid,'123');assert.equal(claim.profile_url,items[0].contact);
    assert.equal(claim.status,'awaiting_payment');assert.equal(claim.proof_code,null);
    items.length=0;
    assert.equal((await call('/selection')).data.missing,true);
    assert.equal((await call('/catalog/123')).status,404);
  }finally{await new Promise(r=>server.close(r));await db.close();}
});
