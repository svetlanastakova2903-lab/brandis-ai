import test from 'node:test';
import assert from 'node:assert/strict';
import {validateClaim,containsProof} from './verification.js';
const valid = {profile_url:'https://www.instagram.com/example/?utm_source=test',phone:'+7 (999) 123-45-67',contact_consent:true};
test('normalizes a claim without trusting ownership or status from the browser', () => {
  assert.deepEqual(validateClaim({...valid,status:'verified',telegram_id:'someone_else'}),
    {profileUrl:'https://instagram.com/example',phone:'+79991234567'});
});
test('proof must be the exact complete code, not a substring or an unavailable profile',()=>{
  const code='BRANDIS-0123456789ABCDEF';
  assert.equal(containsProof('Мой профиль\n'+code,code),true);
  assert.equal(containsProof(code+'0',code),false);
  assert.equal(containsProof(null,code),false);
  assert.equal(containsProof('BRANDIS-0000000000000000',code),false);
});
test('rejects unsafe or unsupported profile URLs', () => {
  for (const profile_url of ['javascript:alert(1)','https://instagram.com.evil.test/x','https://user:pass@instagram.com/x','http://t.me/x','https://t.me/']) {
    assert.throws(()=>validateClaim({...valid,profile_url}));
  }
});
test('requires contact consent and a plausible international phone', () => {
  assert.throws(()=>validateClaim({...valid,contact_consent:false}));
  assert.throws(()=>validateClaim({...valid,phone:'123'}));
});
