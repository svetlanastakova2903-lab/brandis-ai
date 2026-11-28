// Keep Tilda's catalogue available until the replacement is actually ready.
(()=>{
  const start=async()=>{
    if(document.getElementById('brandis-catalog'))return;
    const native=document.getElementById('rec1241984746');if(!native)return;
    // Native Tilda remains the public catalogue while the replacement is in preview.
    const decorate=()=>{
      for(const card of native.querySelectorAll('.js-product[data-product-uid]')){
        const uid=card.getAttribute('data-product-uid');if(!uid)continue;
        const actions=card.querySelector('.t-store__card__btns-wrapper')||card.querySelector('.bdz-fav')?.parentElement;
        if(!actions || actions.querySelector('.brandis-claim'))continue;
        const link=document.createElement('a');link.className='brandis-claim';link.textContent='Это моя анкета';
        link.href='/me?claim='+encodeURIComponent(uid)+'#brandis-verification';
        link.style.cssText='display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:100%;min-height:44px;margin-top:8px;padding:6px 10px;border:1px solid #aa795d;border-radius:20px;color:#f2ede4;font-family:inherit;font-size:14px;font-weight:600;text-decoration:none;position:relative;z-index:2';
        link.addEventListener('click',event=>event.stopPropagation());
        actions.append(link);
      }
    };
    decorate();let scheduled=false;
    new MutationObserver(()=>{if(scheduled)return;scheduled=true;requestAnimationFrame(()=>{scheduled=false;decorate();});}).observe(native,{childList:true,subtree:true});
    const api=window.BRANDIS_API_URL||'https://brandis-ai.onrender.com';
    try{
      const response=await fetch(api+'/api/features',{signal:AbortSignal.timeout(65000)});
      if(!response.ok)return;const features=await response.json();
      if(!features.catalog_priority && new URLSearchParams(location.search).get('brandis_preview')!=='1')return;
      const root=document.createElement('section');root.id='brandis-catalog';root.hidden=true;native.before(root);
      const css=document.createElement('link');css.rel='stylesheet';css.href=api+'/catalog-verified.css';document.head.append(css);
      root.addEventListener('brandis:catalog-ready',()=>{native.style.display='none';root.hidden=false;},{once:true});
      const script=document.createElement('script');script.src=api+'/catalog-verified.js';script.onerror=()=>root.remove();document.head.append(script);
    }catch{/* Keep the original catalogue on network failure. */}
  };
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start,{once:true});else start();
})();
