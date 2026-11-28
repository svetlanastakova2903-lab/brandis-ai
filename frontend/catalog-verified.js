(()=>{
  const root=document.getElementById('brandis-catalog');if(!root)return;
  const api=window.BRANDIS_API_URL||'https://brandis-ai.onrender.com';
  const site='https://brandisapp.ru';
  const params=new URLSearchParams(location.search);
  const state={category:params.get('tab')==='brands'?'brands':'bloggers',page:1,city:[],niche:[],platform:[],search:'',sort:'default'};
  const legacySort={'price:asc':'price_asc','price:desc':'price_desc','title:asc':'name','title:desc':'name_desc','created:asc':'oldest','created:desc':'newest'};
  if(params.get('tfc_storepartuid[1241984746]')==='Бренды')state.category='brands';
  for(const [field,id] of [['city','8696422'],['niche','8696430'],['platform','8765152']]){
    const raw=params.get('bc_'+field)??params.get('tfc_charact:'+id+'[1241984746]');
    if(raw)state[field]=raw.split(':::').map(x=>field==='niche'?x.replace(/\s*\([^)]*\)\s*$/,'').trim():field==='city'?x.replace(/\s*-\s*/g,'-').trim():x);
  }
  state.search=params.get('bc_search')||params.get('tfc_query[1241984746]')||'';
  state.sort=params.get('bc_sort')||legacySort[params.get('tfc_sort[1241984746]')]||'default';
  let sequence=0, facetsCategory=null, favorites=new Set();
  function el(tag,text,parent){const node=document.createElement(tag);if(text!==null)node.textContent=text;if(parent)parent.append(node);return node;}
  function safeUrl(value){try{const url=new URL(value,site);return ['https:','http:'].includes(url.protocol)?url.href:null;}catch{return null;}}
  function token(){return localStorage.getItem('brandis_access_token');}
  async function request(path,body,method){
    const response=await fetch(api+path,{method:method||(body?'POST':'GET'),headers:{'Content-Type':'application/json',...(token()?{Authorization:'Bearer '+token()}: {})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(65000)});
    const data=await response.json().catch(()=>({}));
    if(response.status===401)throw new Error('Сначала войдите через Telegram в кабинете Brandis.');
    if(!response.ok)throw new Error(data.error||'Не удалось выполнить запрос. Попробуйте ещё раз.');return data;
  }
  function button(label,parent,action){const b=el('button',label,parent);b.type='button';b.onclick=action;return b;}
  root.replaceChildren();
  if(!document.getElementById('rec1241984746'))el('h1','Блогеры и бренды для коллабораций',root);
  el('p','Подтверждённые владельцы отмечены ✦ и показаны первыми среди подходящих анкет.',root);
  const login=el('a',token()?'Личный кабинет':'Войти через Telegram',root);login.href=site+'/me';
  const tabs=el('div',null,root);tabs.className='bc-tabs';
  const categoryButtons={};
  for(const [value,label] of [['bloggers','Блогеры'],['brands','Бренды']])categoryButtons[value]=button(label,tabs,()=>{state.category=value;state.page=1;state.city=[];state.niche=[];state.platform=[];load();});
  const filterForm=el('form',null,root);filterForm.className='bc-filters';
  const search=el('input',null,filterForm);search.type='search';search.placeholder='Найти по имени или тематике';search.setAttribute('aria-label','Поиск анкет');
  search.value=state.search;
  const facetRoot=el('div',null,filterForm);facetRoot.className='bc-filters';facetRoot.style.margin='0';
  const sort=el('select',null,filterForm);sort.setAttribute('aria-label','Порядок анкет');
  for(const [value,label] of [['default','Порядок по умолчанию'],['newest','Сперва новые'],['oldest','Сперва старые'],['name','Название: А—Я'],['name_desc','Название: Я—А'],['followers_desc','Больше подписчиков'],['followers_asc','Меньше подписчиков'],['price_asc','Цена: по возрастанию'],['price_desc','Цена: по убыванию']]){const o=el('option',label,sort);o.value=value;}
  const apply=el('button','Найти',filterForm);apply.type='submit';
  sort.value=state.sort;
  button('Сбросить',filterForm,()=>{search.value='';sort.value='default';Object.assign(state,{city:[],niche:[],platform:[],page:1,search:'',sort:'default'});facetsCategory=null;load();});
  filterForm.onsubmit=e=>{e.preventDefault();state.search=search.value;state.sort=sort.value;state.page=1;load();};
  sort.onchange=()=>filterForm.requestSubmit();
  const status=el('p','',root);status.className='bc-status';status.setAttribute('role','status');
  const grid=el('div',null,root);grid.className='bc-grid';const pages=el('nav',null,root);pages.setAttribute('aria-label','Страницы каталога');
  function facets(data){
    if(facetsCategory===state.category)return;facetsCategory=state.category;facetRoot.replaceChildren();
    for(const [field,label] of [['city','Город'],['niche','Тематика'],['platform','Платформа']]){
      const details=el('details',null,facetRoot);el('summary',label,details);const list=el('div',null,details);list.className='bc-options';
      const groups=new Map();
      const countries={
        'Россия':'Архангельск|Воронеж|Выкса|Екатеринбург|Казань|Калининград|Калуга|Краснодар|Курск|Липецк|Москва|Нижний Новгород|Новоалтайск|Новороссийск|Новосибирск|Новошахтинск|Омск|Пермь|Рязань|Санкт-Петербург|Саратов|Сочи|Тюмень|Ханты-Мансийск|Чебоксары|Челябинск|Тула|Суздаль',
        'Вьетнам':'Нячанг|Ханой|Хошимин|Дананг|Далат|Фукуок',
        'Казахстан':'Астана|Костанай|Алматы|Казахстан',
        'Грузия':'Батуми|Тбилиси', 'Сербия':'Белград', 'Кыргызстан':'Бишкек',
        'Австрия':'Вена','Китай':'Гонконг|Шанхай|Яншо', 'Сингапур':'Сингапур',
        'Индонезия':'Bali|Бали', 'Таиланд':'Бангкок|Пхукет|Самуи', 'ОАЭ':'Дубай|Dubai'
      };
      for(const value of data[field]||[]){
        const country=field==='city'?(Object.entries(countries).find(([,cities])=>cities.split('|').includes(value))?.[0]||'Другие / уточняем страну'):'';
        if(!groups.has(country))groups.set(country,[]);groups.get(country).push(value);
      }
      for(const [country,values] of [...groups].sort(([a],[b])=>a==='Россия'?-1:b==='Россия'?1:a.localeCompare(b,'ru'))){
        const group=country?el('details',null,list):list;
        if(country){group.className='bc-country';el('summary',country+' · '+values.length,group);group.open=values.some(value=>state[field].includes(value));}
        for(const value of values){const l=el('label',null,group);const c=el('input',null,l);c.type='checkbox';c.checked=state[field].includes(value);l.append(document.createTextNode(' '+value));c.onchange=()=>{state[field]=c.checked?[...state[field],value]:state[field].filter(x=>x!==value);state.page=1;load();};}
      }
    }
  }
  async function favorite(item,b){
    if(!token()){location.assign(site+'/me');return;}b.disabled=true;
    try{const active=favorites.has(item.uid);await request('/api/favorites'+(active?'/'+encodeURIComponent(item.uid):''),active?null:{uid:item.uid,title:item.name,url:item.catalog_url,photo:item.photo,category:state.category},active?'DELETE':'POST');if(active)favorites.delete(item.uid);else favorites.add(item.uid);b.textContent=favorites.has(item.uid)?'★ В избранном':'☆ В избранное';}
    catch(e){status.textContent=e.message;}finally{b.disabled=false;}
  }
  function card(item){
    const article=el('article',null,grid);const href=safeUrl(item.catalog_url||item.contact);
    if(item.photo){const photoLink=el('a',null,article);if(href)photoLink.href=href;const img=el('img',null,photoLink);const photo=safeUrl(item.photo);if(photo)img.src=photo;img.alt=item.name;img.loading='lazy';}
    const title=el('h2',item.name,article);if(item.verified){const star=el('span',' ✦',title);star.className='bc-star';star.title='Владение профилем подтверждено';star.setAttribute('aria-label','Владение профилем подтверждено');}
    el('p',[item.city,(item.niche||[]).join(', '),item.platform].filter(Boolean).join(' · '),article);
    if(Number.isFinite(item.followers))el('p',item.followers.toLocaleString('ru')+' подписчиков',article);
    if(href){const a=el('a','Подробнее',article);a.href=href;}
    if(item.uid){const claim=el('a','Это моя анкета',article);claim.href=site+'/me?claim='+encodeURIComponent(item.uid)+'#brandis-verification';claim.className='bc-claim';}
    if(item.uid){const fav=button(favorites.has(item.uid)?'★ В избранном':'☆ В избранное',article,()=>favorite(item,fav));}
    if(item.verified&&item.accepts_offers){const b=button('Написать',article,()=>openOffer(item));b.className='bc-send';}
  }
  async function load(){
    const run=++sequence;status.textContent='Загружаем каталог…';apply.disabled=true;
    for(const [key,b] of Object.entries(categoryButtons))b.setAttribute('aria-pressed',String(key===state.category));
    const query=new URLSearchParams({category:state.category,page:state.page,size:20,search:state.search,sort:state.sort});for(const f of ['city','niche','platform'])for(const v of state[f])query.append(f,v);
    try{const data=await request('/api/catalog?'+query);if(run!==sequence)return;facets(data.facets);grid.replaceChildren();data.items.forEach(card);status.textContent='Найдено: '+data.total;pages.replaceChildren();
      const previous=button('← Назад',pages,()=>{state.page--;load();});previous.disabled=state.page<=1;
      el('span','Страница '+state.page+' из '+Math.max(1,Math.ceil(data.total/20)),pages);
      const next=button('Далее →',pages,()=>{state.page++;load();});next.disabled=state.page*20>=data.total;
      root.dispatchEvent(new Event('brandis:catalog-ready'));
      const url=new URL(location.href);for(const key of [...url.searchParams.keys()])if(key.startsWith('tfc_')||key.startsWith('bc_'))url.searchParams.delete(key);
      if(state.category==='brands')url.searchParams.set('tab','brands');else url.searchParams.delete('tab');
      for(const field of ['city','niche','platform'])if(state[field].length)url.searchParams.set('bc_'+field,state[field].join(':::'));
      if(state.search)url.searchParams.set('bc_search',state.search);if(state.sort!=='default')url.searchParams.set('bc_sort',state.sort);history.replaceState(null,'',url);
    }catch(e){if(run===sequence)status.textContent=e.message;}finally{if(run===sequence)apply.disabled=false;}
  }
  function openOffer(item){
    const dialog=el('dialog',null,root);el('h2','Написать: '+item.name,dialog);
    button('Закрыть',dialog,()=>dialog.close());
    const form=el('form',null,dialog),messageLabel=el('label','Ваше предложение',form),message=el('textarea',null,messageLabel);message.required=true;message.minLength=10;message.maxLength=2000;
    const contactLabel=el('label','Контакт для ответа (Telegram, email или телефон)',form),contact=el('input',null,contactLabel);contact.required=true;contact.maxLength=200;
    const consentLabel=el('label',null,form),consent=el('input',null,consentLabel);consent.type='checkbox';consent.required=true;consentLabel.append(document.createTextNode('Передать мой контакт владельцу этой анкеты вместе с сообщением.'));
    const info=el('p','',form);info.setAttribute('role','status');
    const submit=el('button','Отправить предложение',form);submit.type='submit';
    const requestId=crypto.randomUUID();let savedId=null;
    const labels={queued:'Предложение сохранено. Ожидает отправки в Telegram.',sending:'Отправляем в Telegram…',delivered:'Доставлено владельцу в Telegram.',failed:'Предложение сохранено, но Telegram отказал в доставке. Свяжитесь с поддержкой Brandis.',unknown:'Предложение сохранено. Подтверждение доставки не получено; повторно не отправляйте. Команда проверит доставку.',cancelled:'Получатель отключил предложения или больше не подтверждён. Сообщение не отправлено.'};
    form.onsubmit=async e=>{e.preventDefault();if(!token()){info.textContent='Войдите через Telegram в кабинете Brandis и вернитесь сюда.';const a=el('a','Открыть кабинет',info);a.href=site+'/me';a.target='_blank';a.rel='noopener';return;}submit.disabled=true;
      try{if(!savedId){const result=await request('/api/offers',{claim_id:item.verification_id,request_id:requestId,message:message.value,contact:contact.value,share_contact:consent.checked});savedId=result.id;message.disabled=contact.disabled=consent.disabled=true;}
        const result=await request('/api/offers/'+savedId);info.textContent=labels[result.status]||'Проверяем статус';submit.textContent='Обновить статус';submit.disabled=result.status==='delivered';
      }catch(err){info.textContent=err.message;submit.disabled=false;}
    };
    dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  }
  (async()=>{if(token())try{const data=await request('/api/favorites');favorites=new Set(data.favorites.map(f=>String(f.product_uid)));}catch{}await load();})();
})();
