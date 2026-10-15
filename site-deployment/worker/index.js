const MIRRORS = ['https://de1.api.radio-browser.info','https://nl1.api.radio-browser.info','https://at1.api.radio-browser.info','https://all.api.radio-browser.info'];
const KEYS = ['stationuuid','name','url_resolved','url','homepage','favicon','tags','country','countrycode','language','codec','bitrate','votes','clickcount','hls','geo_lat','geo_long'];
const json = (value,status=200) => new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}});
const limit = (v,max,def) => Math.min(max,Math.max(1,Number(v)||def));
const trimmed = list => list.map(s=>{
  const item=Object.fromEntries(KEYS.map(k=>[k,s[k]??null]));
  if(item.countrycode==='TW')item.country='中国台湾';
  return item;
});
const result = list => ({count:list.length,stations:trimmed(list)});
async function radio(path,params={}) {
  let failure;
  for(const mirror of MIRRORS) {
    const url=new URL(path,mirror);
    for(const [k,v] of Object.entries(params)) if(v!==''&&v!=null) url.searchParams.set(k,String(v));
    try {
      const r=await fetch(url,{signal:AbortSignal.timeout(9000)});
      if(!r.ok) throw new Error('Radio Browser '+r.status);
      return await r.json();
    } catch(e) { failure=e; }
  }
  throw failure||new Error('Radio Browser unavailable');
}
async function search(p) {
  const requested = limit(p.limit, 100, 20);
  const params = {
    hidebroken: 'true', order: p.order || 'clickcount', reverse: 'true',
    limit: Math.min(requested * 3, 100), name: p.name || '', tag: p.tag || '',
    tagList: p.tags?.length ? p.tags.join(',') : '',
    countrycode: p.countrycode || '', language: p.language || '',
  };
  let stations;
  if(p.countrycode==='CN') {
    const replies=await Promise.allSettled(['CN','TW'].map(countrycode=>radio('/json/stations/search',{...params,countrycode})));
    stations=replies.flatMap(reply=>reply.status==='fulfilled'?reply.value:[]);
    if(replies.every(reply=>reply.status==='rejected'))throw replies[0].reason;
    const seen=new Set();
    stations=stations.filter(s=>{if(seen.has(s.stationuuid))return false;seen.add(s.stationuuid);return true;});
    const order=params.order;
    stations.sort((a,b)=>['votes','clickcount','bitrate','lastcheckok'].includes(order)
      ? Number(b[order]||0)-Number(a[order]||0)
      : String(b[order]||'').localeCompare(String(a[order]||'')));
  } else {
    stations=await radio('/json/stations/search',params);
  }
  // 公开站点是 HTTPS；浏览器会拦截 HTTP 音频流。
  return stations.filter(s => /^https:\/\//i.test(s.url_resolved || s.url || '')).slice(0, requested);
}
async function geoStations(countrycode,requested) {
  const codes=countrycode==='CN'?['CN','TW']:[countrycode];
  const replies=await Promise.allSettled(codes.map(code=>radio('/json/stations/search',{
    countrycode:code,has_geo_info:'true',is_https:'true',hidebroken:'true',
    order:'clickcount',reverse:'true',limit:countrycode==='CN'?Math.ceil(requested/2):requested,
  })));
  if(replies.every(reply=>reply.status==='rejected'))throw replies[0].reason;
  const seen=new Set();
  return replies.flatMap(reply=>reply.status==='fulfilled'?reply.value:[]).filter(s=>{
    if(seen.has(s.stationuuid))return false;
    seen.add(s.stationuuid);
    return s.geo_lat!=null&&s.geo_long!=null&&Number.isFinite(Number(s.geo_lat))&&Number.isFinite(Number(s.geo_long))&&Math.abs(Number(s.geo_lat))<=90&&Math.abs(Number(s.geo_long))<=180&&/^https:\/\//i.test(s.url_resolved||s.url||'');
  }).slice(0,requested);
}
async function recommend(p) {
  const tags=(p.tags||'').split(',').map(x=>x.trim()).filter(Boolean), countrycode=p.countrycode||'', language=p.language||'';
  const attempts=tags.length?[
    {tags,countrycode,language},{tags,countrycode,language:''},{tags,countrycode:'',language:''},{tags:tags.slice(0,1),countrycode:'',language:''}
  ]:[{tags:[],countrycode,language},{tags:[],countrycode,language:''},{tags:[],countrycode:'',language:''},{tags:[],countrycode:'',language:''}];
  let stations=[],level=null;
  for(const [i,a] of attempts.entries()) {
    try { stations=await search({...a,name:p.name||'',limit:p.limit||20}); } catch { continue; }
    if(stations.length) {level='level_'+(i+1);break;}
  }
  return {...result(stations),level,matched:{tags,countrycode,language}};
}
const WORDS={jazz:['爵士','jazz'],rock:['摇滚','rock'],classical:['古典','钢琴','classical','piano'],electronic:['电子','电音','electronic','edm','house'],pop:['流行','pop'],'hip hop':['嘻哈','说唱','hip hop','rap'],folk:['民谣','folk'],chillout:['放松','舒缓','轻音乐','chill','ambient'],news:['新闻','news'],blues:['蓝调','blues'],oldies:['老歌','怀旧','经典']};
const COUNTRIES={US:['美国','usa','america'],GB:['英国','uk','britain'],CN:['中国','china','台湾','taiwan'],JP:['日本','japan','东京'],KR:['韩国','korea'],FR:['法国','france'],DE:['德国','germany'],IT:['意大利','italy'],ES:['西班牙','spain'],BR:['巴西','brazil']};
const LANGUAGES={chinese:['中文','汉语','国语'],english:['英文','英语'],japanese:['日语','日文'],korean:['韩语','韩文'],french:['法语'],german:['德语'],spanish:['西班牙语']};
function intent(text='') {
  const low=text.toLowerCase(),hit=words=>words.some(w=>low.includes(w.toLowerCase()));
  const out={tags:[],raw:text.trim()};
  for(const [tag,words] of Object.entries(WORDS)) if(hit(words)) out.tags.push(tag);
  for(const [cc,words] of Object.entries(COUNTRIES)) if(hit(words)){out.country=cc;break;}
  for(const [lang,words] of Object.entries(LANGUAGES)) if(hit(words)){out.language=lang;break;}
  const moods={work:[['工作','学习','专注'],['ambient','classical']],sleep:[['睡觉','助眠','睡眠'],['ambient','chillout']],sport:[['运动','跑步','健身'],['electronic','pop']],night:[['深夜','夜晚','午夜'],['jazz','chillout']],party:[['派对','聚会','跳舞'],['dance','electronic']]};
  for(const [mood,[words,tags]] of Object.entries(moods)) if(hit(words)){out.mood=mood;for(const tag of tags) if(!out.tags.includes(tag)) out.tags.push(tag);}
  const quoted=text.match(/"([^"]+)"/);if(quoted)out.name=quoted[1];
  return out;
}
async function llm(cfg,system,prompt){
  if(!cfg?.api_key)return null;
  const base=(cfg.base_url||'https://api.deepseek.com').replace(/\/$/,'');
  if(!/^https:\/\//.test(base))return null;
  const response=await fetch(base+'/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+cfg.api_key},body:JSON.stringify({model:cfg.model||'deepseek-chat',messages:[{role:'system',content:system},{role:'user',content:prompt}],response_format:{type:'json_object'},stream:false}),signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('LLM '+response.status);
  const data=await response.json();return JSON.parse(data.choices?.[0]?.message?.content||'{}');
}
function period(hour){if(hour>=5&&hour<9)return ['morning','清晨'];if(hour>=9&&hour<12)return ['day','上午'];if(hour>=12&&hour<18)return ['noon','午后'];if(hour>=18&&hour<22)return ['evening','傍晚'];return ['night','深夜'];}
const QUOTES={
  morning:[['清晨的光落在窗台，世界还没有完全醒来',['ambient','chillout'],'清晨 · 清醒'],['咖啡香里，慢一点，把今天过成一首诗',['jazz'],'清晨 · 慵懒']],
  day:[['专注是此刻最好的旋律，让思绪安静成一条河',['ambient','classical'],'上午 · 专注'],['努力的人，配得上一首轻快的歌',['pop'],'上午 · 元气']],
  noon:[['午后的阳光慵懒，像一只伸懒腰的猫',['jazz'],'午后 · 慵懒'],['给忙碌一个逗号，再继续赶路',['chillout'],'午后 · 放松']],
  evening:[['晚霞是天空写给你的一封情书',['pop'],'傍晚 · 浪漫'],['华灯初上，城市的夜开始呼吸',['electronic'],'傍晚 · 都市']],
  night:[['夜深了，把白天的喧嚣轻轻放下',['ambient','chillout'],'深夜 · 静谧'],['月亮是个安静的倾听者',['classical'],'深夜 · 空灵']]
};
async function personalize(body){
  const lat=Number(body.latitude),lon=Number(body.longitude);if(!Number.isFinite(lat)||!Number.isFinite(lon)||Math.abs(lat)>90||Math.abs(lon)>180)return json({error:'Invalid coordinates'},400);
  const hour=Number(body.hour)||new Date().getHours();let weather=null,location=null;
  try{const d=await(await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,weather_code`,{signal:AbortSignal.timeout(6000)})).json();const c=d.current?.weather_code||0;weather={temperature:d.current?.temperature_2m,description:c>=71?'雪':c>=51?'雨':c>=3?'多云':'晴'};}catch{}
  try{const d=await(await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=zh`,{signal:AbortSignal.timeout(6000)})).json();location={city:d.city||d.locality||'',country:d.countryName||''};}catch{}
  const [key,label]=period(hour),defaults={morning:['acoustic','pop'],day:['ambient','classical'],noon:['jazz','chillout'],evening:['pop','electronic'],night:['ambient','chillout']};
  let tags=weather?.description==='雨'?['jazz','chillout']:weather?.description==='雪'?['classical','ambient']:defaults[key],explanation=`${label}适合听听${tags.join('、')}。`;
  try{const suggestion=await llm(body.llm,'按天气和时间推荐电台风格。只输出 JSON：{"tags":["jazz"],"explanation":"中文说明"}',`时间：${label}；天气：${weather?.description||'未知'}；地点：${location?.city||'未知'}`);if(suggestion?.tags?.length)tags=suggestion.tags.slice(0,4);if(suggestion?.explanation)explanation=String(suggestion.explanation).slice(0,100);}catch{}
  const found=await recommend({tags:tags.join(','),limit:15});return json({...found,explanation,context:{weather,location,hour}});
}
async function api(request,url){
  const p=url.pathname,q=Object.fromEntries(url.searchParams);
  if(p==='/api/health')return json({status:'ok',service:'radio-agent'});
  if(p==='/api/llm/status')return json({server_key:false,model:'deepseek-chat',base_url:'https://api.deepseek.com'});
  if(p==='/api/meta/tags')return json((await radio('/json/tags',{limit:limit(q.limit,200,80),order:'stationcount',reverse:'true',hidebroken:'true'})).filter(x=>x.name?.length>=2&&x.stationcount>0));
  if(p==='/api/meta/countries')return json(await radio('/json/countries',{order:'stationcount',reverse:'true'}));
  if(p==='/api/meta/languages')return json(await radio('/json/languages',{order:'stationcount',reverse:'true'}));
  if(p==='/api/stations/search')return json(result(await search(q)));
  if(p==='/api/stations/geo'){const n=limit(q.limit,500,200);if(q.countrycode&&!q.tag)return json(result(await geoStations(q.countrycode,n)));const list=await search({...q,limit:Math.min(n*2,500)});const geo=list.filter(s=>s.geo_lat!=null&&s.geo_long!=null&&Number.isFinite(Number(s.geo_lat))&&Number.isFinite(Number(s.geo_long))&&Math.abs(Number(s.geo_lat))<=90&&Math.abs(Number(s.geo_long))<=180).slice(0,n);return json(result(geo));}
  if(p==='/api/recommend')return json(await recommend(q));
  if(p==='/api/quotes'){const [key,label]=period(Number(q.hour??new Date().getHours()));return json({period:key,label,source:'preset',quotes:QUOTES[key].map(([text,tags,mood])=>({text,tags,mood}))});}
  if(p==='/api/intent'&&request.method==='POST'){const body=await request.json(),fallback=intent(body.text||'');try{const x=await llm(body.llm,'识别电台需求。只输出 JSON：{"tags":["jazz"],"country":"JP","language":"","mood":""}',body.text||'');return json(x?{...fallback,...x,raw:fallback.raw}:fallback);}catch{return json(fallback);}}
  if(p==='/api/personalize'&&request.method==='POST')return personalize(await request.json());
  if(p==='/api/click'&&request.method==='POST'){const body=await request.json();if(body.stationuuid)try{await radio('/json/url/'+encodeURIComponent(body.stationuuid));}catch{}return json({ok:true});}
  return json({error:'Not found'},404);
}
export default {async fetch(request){const url=new URL(request.url);if(url.pathname.startsWith('/api/'))try{return await api(request,url);}catch(e){return json({error:String(e?.message||e)},502);}const key=url.pathname==='/'?'/index.html':url.pathname,asset=ASSETS[key];return asset?new Response(asset.body,{headers:{'content-type':asset.type,'cache-control':key==='/index.html'?'no-store':'public, max-age=3600'}}):new Response('Not found',{status:404});}};
