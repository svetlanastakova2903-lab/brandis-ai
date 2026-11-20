import test from 'node:test';
import assert from 'node:assert/strict';
import { validWebhookSecret, linkIsFresh, privateSender, webhookSecret } from './auth-security.js';

test('webhook secret can be derived without exposing or copying the bot token',()=>{
 const env={TELEGRAM_BOT_TOKEN:'test-credential-not-real'};
 const secret=webhookSecret(env);assert.equal(secret.length,64);assert.notEqual(secret,env.TELEGRAM_BOT_TOKEN);
 assert.equal(webhookSecret(env),secret);assert.equal(webhookSecret({}),'');
 assert.equal(webhookSecret({...env,TELEGRAM_WEBHOOK_SECRET:'configured'}),'configured');
 assert.equal(validWebhookSecret(secret,secret),true);
});

test('webhook rejects missing, malformed and forged secrets', () => {
  const secret = 'a'.repeat(48);
  assert.equal(validWebhookSecret(secret, secret), true);
  for (const value of [undefined, '', 'a'.repeat(47), 'b'.repeat(48), ['a'.repeat(48)]]) {
    assert.equal(validWebhookSecret(value, secret), false);
  }
  assert.equal(validWebhookSecret(undefined, undefined), false);
  assert.equal(validWebhookSecret('short', 'short'), false);
});

test('login link expires at 15 minutes and rejects future or invalid dates', () => {
  const now = Date.now();
  assert.equal(linkIsFresh({created_at: new Date(now - 899999)}, now), true);
  for (const created_at of [new Date(now - 900000), new Date(now + 1000), 'invalid']) {
    assert.equal(linkIsFresh({created_at}, now), false);
  }
  assert.equal(linkIsFresh(null, now), false);
});

test('only the actual private sender may link an account', () => {
  const message = {chat: {type:'private', id:123}, from:{id:123, is_bot:false}};
  assert.equal(privateSender(message), true);
  assert.equal(privateSender({...message, chat:{type:'group',id:123}}), false);
  assert.equal(privateSender({...message, from:{id:124}}), false);
  assert.equal(privateSender({...message, from:{id:123,is_bot:true}}), false);
  assert.equal(privateSender(null), false);
});
