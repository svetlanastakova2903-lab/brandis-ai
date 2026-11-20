// Keep Tilda's catalogue available until the replacement is actually ready.
(()=>{
  const start=async()=>{
    if(document.getElementById('brandis-catalog'))return;
    const native=document.getElementById('rec1241984746');if(!native)return;
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
