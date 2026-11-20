import test from 'node:test';
import assert from 'node:assert/strict';
import {parseFollowers,transformBlogger,transformBrand} from './refreshCatalog.js';
test('HTML nonbreaking spaces do not truncate follower counts',()=>{
  for(const space of [' ','\u00a0','&nbsp;','&#160;','&#xA0;'])assert.equal(parseFollowers(`1${space}015${space}211 подписчиков`),1015211);
  assert.equal(parseFollowers('24,4 тыс. подписчиков'),24400);
  assert.equal(parseFollowers('неизвестно'),null);
});
test('both catalogue categories retain product IDs, detail links and images',()=>{
  const p={uid:'123',title:'Name',url:'https://brandisapp.ru/catalog/tproduct/123-name',gallery:JSON.stringify([{img:'https://example.com/photo.jpg'}]),characteristics:[{title:'Контакт',value:'https://t.me/test'},{title:'Город',value:'спб'}]};
  for(const transform of [transformBlogger,transformBrand]){
    const item=transform(p);assert.equal(item.uid,'123');assert.equal(item.catalog_url,p.url);assert.equal(item.photo,'https://example.com/photo.jpg');assert.equal(item.city,'Санкт-Петербург');assert.equal(item.profile_url,'https://t.me/test');
  }
});
