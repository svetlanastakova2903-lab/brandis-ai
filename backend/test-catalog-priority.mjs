import test from 'node:test';
import assert from 'node:assert/strict';
import { selectCatalog, profileKey } from './catalog-priority.js';

const items = Array.from({length: 60}, (_, i) => ({
  name: `Profile ${i}`, profile_url: `https://instagram.com/person${i}/`,
  city: i === 59 ? 'Москва' : 'Рязань', niche: ['Красота'],
  platform: 'Instagram', followers: i * 100,
}));
const claim = (i, overrides = {}) => ({id: String(i), profile_url: items[i].profile_url,
  status: 'verified', paid_at: '2026-11-20', ...overrides});

test('oldest and newest ordering remain subordinate to verification',()=>{
 const cards=items.map((p,i)=>({...p,created_rank:i}));
 assert.deepEqual(selectCatalog(cards,[claim(2),claim(8)],{sort:'oldest',size:3}).items.map(p=>p.name),['Profile 8','Profile 2','Profile 59']);
 assert.deepEqual(selectCatalog(cards,[claim(2),claim(8)],{sort:'newest',size:3}).items.map(p=>p.name),['Profile 2','Profile 8','Profile 0']);
});

test('verification moves a distant profile to page one, without duplicates between pages', () => {
  const claims = [claim(58)];
  const first = selectCatalog(items, claims, {size: 24});
  assert.equal(first.items[0].name, 'Profile 58');
  const all = [1,2,3].flatMap(page => selectCatalog(items, claims, {page,size:24}).items);
  assert.equal(new Set(all.map(p => p.profile_url)).size, 60);
  assert.equal(all.length, 60);
});
test('all selected filters apply before priority', () => {
  const result = selectCatalog(items, [claim(59), claim(58)], {
    city:'Рязань', niche:'Красота', platform:'Instagram', search:'Profile',
  });
  assert.equal(result.total, 59);
  assert.equal(result.items[0].name, 'Profile 58');
  assert.ok(result.items.every(p => p.city === 'Рязань'));
  assert.equal(selectCatalog(items, [claim(58)], {niche:'Авто'}).total, 0);
  assert.equal(selectCatalog(items, [claim(58)], {platform:'YouTube'}).total, 0);
});
test('payment without approval, refund and revoked approval confer no priority', () => {
  for (const overrides of [{status:'pending_review'}, {status:'refunded'}, {status:'rejected'}, {paid_at:null}]) {
    const result = selectCatalog(items, [claim(58,overrides)]);
    assert.equal(result.items[0].name, 'Profile 0');
    assert.ok(result.items.every(p => !p.verified));
  }
});
test('chosen follower ordering is preserved inside each priority group', () => {
  const result = selectCatalog(items, [claim(1),claim(3)], {sort:'followers_desc'});
  assert.deepEqual(result.items.slice(0,4).map(p=>p.name), ['Profile 3','Profile 1','Profile 59','Profile 58']);
});
test('brand scalar niches and multiple cities can be searched and filtered', () => {
  const brands = [{name:'Cafe',city:'Москва;Рязань',niche:'Еда',contact:'https://t.me/cafe'}];
  const claims = [{id:'b',profile_url:'https://t.me/cafe',status:'verified',paid_at:'2026-11-20'}];
  assert.equal(selectCatalog(brands, claims, {city:'Рязань',search:'еда'}).items[0].verified,true);
});
test('profile matching ignores tracking but preserves YouTube channel ID case', () => {
  assert.equal(profileKey('https://www.instagram.com/Person58/?igsh=123'),profileKey(items[58].profile_url));
  assert.notEqual(profileKey('https://youtube.com/channel/AbC'), profileKey('https://youtube.com/channel/abc'));
  assert.equal(profileKey('javascript:alert(1)'),null);
});
