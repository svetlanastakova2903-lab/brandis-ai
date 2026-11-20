import test from 'node:test';
import assert from 'node:assert/strict';
import {matchesVerificationPayment,publicClaim,applyVerificationPayment,checkoutVerification} from './verification-payments.js';
const claim={id:'claim',telegram_id:'42',status:'awaiting_payment',proof_code:'SECRET',checkout_started_at:new Date(),checkout_key:'persistent-key',checkout_return_url:'https://brandisapp.ru/me'};
const payment={id:'pay',paid:true,status:'succeeded',metadata:{type:'verification',claim_id:'claim',telegram_id:'42'},amount:{value:'500.00',currency:'RUB'}};
test('wrong amounts, users, currencies and payment identities do not unlock proof',()=>{
  assert.equal(matchesVerificationPayment(payment,claim),true);
  for(const p of [{...payment,amount:{value:'1.00',currency:'RUB'}},{...payment,amount:{value:'500.00',currency:'USD'}},{...payment,metadata:{...payment.metadata,telegram_id:'43'}}])assert.equal(matchesVerificationPayment(p,claim),false);
  assert.equal(matchesVerificationPayment(payment,{...claim,payment_id:'different'}),false);
});
test('code is hidden before payment and after refund',()=>{
  assert.equal(publicClaim(claim).proof_code,null);
  assert.equal(publicClaim({...claim,paid_at:new Date(),status:'awaiting_proof'}).proof_code,'SECRET');
  assert.equal(publicClaim({...claim,paid_at:new Date(),status:'refunded'}).proof_code,null);
});
function fakePool(row){
  let updates=0;
  const client={release(){},async query(sql,args){
    if(sql.startsWith('SELECT'))return {rows:[row]};
    if(sql.includes("status='awaiting_proof'")){updates++;row.paid_at=new Date();row.status='awaiting_proof';row.payment_id=args[1];}
    return {rows:[]};
  }};
  return {async connect(){return client;},query:client.query,get updates(){return updates;}};
}
test('repeat success and late notifications do not reset verification or grant a badge',async()=>{
  const row={...claim};const pool=fakePool(row);
  await applyVerificationPayment(pool,payment);assert.equal(row.status,'awaiting_proof');
  row.status='verified';await applyVerificationPayment(pool,payment);
  assert.equal(row.status,'verified');assert.equal(pool.updates,1);
});
test('pending/unpaid notifications cannot unlock proof',async()=>{
  const row={...claim};const pool=fakePool(row);
  await applyVerificationPayment(pool,{...payment,status:'pending',paid:false});
  assert.equal(pool.updates,0);
});
test('uncertain expired checkout never creates a second charge',async()=>{
  const row={...claim,checkout_started_at:new Date(Date.now()-24*60*60*1000)};
  let calls=0;
  await assert.rejects(checkoutVerification({pool:fakePool(row),provider:{createVerificationPayment(){calls++;}},claimId:'claim',telegramId:'42',returnUrl:'https://brandisapp.ru/me'}));
  assert.equal(calls,0);
});
test('network retry reuses persisted provider key and fixed request body',async()=>{
  const row={...claim};const requests=[];
  const provider={async createVerificationPayment(args){requests.push(args);throw new Error('network');}};
  for(let i=0;i<2;i++)await assert.rejects(checkoutVerification({pool:fakePool(row),provider,claimId:'claim',telegramId:'42',returnUrl:'https://different.test/'}));
  assert.deepEqual(requests[0],requests[1]);assert.equal(requests[0].idempotenceKey,'persistent-key');
  assert.equal(requests[0].returnUrl,'https://brandisapp.ru/me');
});
