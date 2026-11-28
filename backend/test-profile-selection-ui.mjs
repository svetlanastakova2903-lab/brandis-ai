import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const {JSDOM}=await import(process.env.JSDOM_MODULE||'jsdom');
const source=fs.readFileSync(new URL('../frontend/verification-panel.html',import.meta.url),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,30));
test('selected card survives Telegram login and saves only after confirmation',async()=>{
 const profile={uid:'123',name:'Example',contact:'https://instagram.com/example',city:'Рязань'};
 let saved=null,watchToken;const calls=[];
 const dom=new JSDOM(source,{url:'https://brandisapp.ru/me?claim=123',runScripts:'dangerously',beforeParse(w){
   w.setInterval=fn=>{watchToken=fn;};
   w.fetch=async(url,options={})=>{calls.push({url,options});
     if(url.endsWith('/review'))return {ok:false,json:async()=>({error:'Not admin'})};
     if(url.endsWith('/me'))return {ok:true,json:async()=>({claims:[],telegram_id:'1',payments_enabled:false})};
     if(url.endsWith('/catalog/123'))return {ok:true,json:async()=>({profile})};
     if(url.endsWith('/selection')){if(options.method==='POST')saved=JSON.parse(options.body);return {ok:true,json:async()=>({profile:saved?profile:null})};}
     throw Error('Unexpected request: '+url);
   };
 }});
 try{
   await tick();assert.equal(calls.length,0);
   dom.window.localStorage.setItem('brandis_access_token','test-only');watchToken();await tick();
   const d=dom.window.document;
   assert.match(d.querySelector('#bv-selection').textContent,/Example/);
   assert.equal(d.querySelector('#bv-form').hidden,true);assert.equal(saved,null);
   d.querySelector('#bv-selection button').click();await tick();
   assert.deepEqual(saved,{catalog_uid:'123'});assert.equal(dom.window.location.search,'');
   assert.equal(d.querySelector('#bv-form').hidden,false);
   assert.equal(d.querySelector('[name=profile_url]').value,profile.contact);
   assert.equal(d.querySelector('[name=profile_url]').readOnly,true);
   assert.equal(calls.some(c=>c.url.includes('/pay')),false);
 }finally{dom.window.close();}
});
test('native Tilda cards receive one claim link after dynamic rendering',async()=>{
 const dom=new JSDOM('<div id="rec1241984746"><div class="js-product" data-product-uid="123"><div class="t-store__card__textwrapper"></div><div class="t-store__card__btns-wrapper"><button class="bdz-fav">В избранное</button></div></div></div>',{url:'https://brandisapp.ru/catalog',runScripts:'outside-only',pretendToBeVisual:true});
 try{
   dom.window.fetch=async()=>({ok:true,json:async()=>({catalog_priority:false})});
   dom.window.eval(fs.readFileSync(new URL('../frontend/catalog-embed.js',import.meta.url),'utf8'));
   dom.window.document.dispatchEvent(new dom.window.Event('DOMContentLoaded'));await tick();
   const card=dom.window.document.querySelector('.js-product');
   assert.equal(card.querySelectorAll('.brandis-claim').length,1);
   assert.equal(card.querySelector('.bdz-fav').nextElementSibling.className,'brandis-claim');
   assert.match(card.querySelector('.brandis-claim').href,/\/me\?claim=123#/);
   card.append(dom.window.document.createElement('span'));await tick();
   assert.equal(card.querySelectorAll('.brandis-claim').length,1);
 }finally{dom.window.close();}
});
