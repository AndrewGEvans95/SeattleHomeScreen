import {mount as mountTransit} from './transit.js';
import {mount as mountWeather} from './weather.js';
import {readWeatherOptions,weatherQuery} from './weather-options.js';
const params=new URLSearchParams(location.search);
let weatherOptions;
try{const saved=params.has('frame')?{}:JSON.parse(localStorage.getItem('seattle-window-weather')||'{}');weatherOptions=readWeatherOptions(params,saved);}catch{weatherOptions=readWeatherOptions(new URLSearchParams());}
let currentView=params.get('view')==='weather'?'weather':'transit';
let mode=params.get('mode')==='live'?'live':'demo';
let generation=0,pollTimer,controllers=[];
window.frameReady=false;
const modeSelect=document.querySelector('#data-mode'),connection=document.querySelector('#connection');
const modules={};
const snapshots={transit:null,weather:null,vehicles:null};
function updateDownload(){
  const query=new URLSearchParams({view:currentView,mode});
  if(currentView==='weather')for(const [key,value] of weatherQuery(weatherOptions))query.set(key,value);
  document.querySelector('#download').href='/api/frame.png?'+query;
}
function weatherChanged(options){
  weatherOptions=options;updateDownload();
  if(params.has('frame'))return;
  const {homeMinutes,sluMinutes,gustLimit,preference}=options;
  try{localStorage.setItem('seattle-window-weather',JSON.stringify({homeMinutes,sluMinutes,gustLimit,preference}));}catch{/* Settings still work when browser storage is unavailable. */}
  const url=new URL(location);for(const [key,value] of weatherQuery(options))url.searchParams.set(key,value);
  history.replaceState(null,'',url);
}
function selectView(view){
  currentView=view;
  if(!params.has('frame')){const url=new URL(location);url.searchParams.set('view',view);url.searchParams.set('mode',mode);history.replaceState(null,'',url);}
  for(const name of ['transit','weather'])document.getElementById(name+'-panel').hidden=name!==view;
  document.querySelectorAll('nav [data-view]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.view===view)));
  updateDownload();
  requestAnimationFrame(()=>modules[view]?.render());
}
function describe(){
  if(mode==='demo'){connection.textContent='DEMO · All arrivals and weather are simulated. Choose Live to connect the data providers.';return;}
  const t=snapshots.transit,w=snapshots.weather,v=snapshots.vehicles;
  const failure=(snapshot,label)=>label+' '+(snapshot?.error?.message||'Check the local server and internet connection; the app will retry automatically.');
  const gps=v?.status==='loading'?'Connecting to Metro GPS…':v?.status==='ok'?'Metro GPS connected.':failure(v,'Metro GPS unavailable.');
  const transit=t?.status==='loading'?'Connecting to arrivals…':t?.status==='unconfigured'?'Arrival predictions need your OneBusAway key in .env.':t?.status==='ok'?'Transit connected.':failure(t,'Transit unavailable; predictions are hidden.');
  const weather=w?.status==='loading'?'Connecting to weather…':w?.status==='ok'?'Weather connected: 15-minute model estimates.':failure(w,'Weather unavailable; ride guidance is paused.');
  const extra=t?.status==='ok'&&t.extraStatus==='unavailable'?failure({error:t.extraError},'Fremont stop arrivals unavailable.'):'';
  connection.textContent=[gps,transit,weather,extra].filter(Boolean).join(' ');
}
async function poll(ticket){
  if(mode!=='live'||ticket!==generation)return;
  await Promise.all(['transit','weather','vehicles'].map(async name=>{
    const controller=new AbortController();controllers.push(controller);
    const timeout=setTimeout(()=>controller.abort(),15000);
    let data;
    try{const r=await fetch('/api/'+name,{signal:controller.signal});if(!r.ok)throw new Error();data=await r.json();}
    catch{data={status:'unavailable',arrivals:[],fetchedAt:null};}
    finally{clearTimeout(timeout);controllers=controllers.filter(c=>c!==controller);}
    if(mode==='live'&&ticket===generation){snapshots[name]=data;if(name==='vehicles')modules.transit.setVehicles(data);else modules[name].setLive(data);if(name==='transit')modules.weather.setTransit(data);describe();}
  }));
  if(ticket===generation){window.frameReady=true;if(!params.has('frame'))pollTimer=setTimeout(()=>poll(ticket),30000);}
}
async function setMode(next){
  mode=next;modeSelect.value=mode;generation++;clearTimeout(pollTimer);controllers.forEach(c=>c.abort());controllers=[];
  document.body.classList.toggle('live',mode==='live');
  const url=new URL(location);url.searchParams.set('mode',mode);url.searchParams.set('view',currentView);history.replaceState(null,'',url);
  if(mode==='live'){
    modules.weather.setTransit({status:'loading',arrivals:[]});
    snapshots.vehicles={status:'loading',vehicles:[]};modules.transit.setVehicles(snapshots.vehicles);
    for(const name of ['transit','weather']){snapshots[name]={status:'loading',arrivals:[],fetchedAt:null};modules[name].setLive(snapshots[name]);}
    describe();await poll(generation);
  }else{Object.values(modules).forEach(m=>m.setDemo());describe();window.frameReady=true;}
  selectView(currentView);
}
async function start(){
  document.body.classList.toggle('frame',params.has('frame'));
  const fragments=await Promise.all(['transit','weather'].map(n=>fetch('/'+n+'.html').then(r=>{if(!r.ok)throw new Error('Missing view');return r.text();})));
  ['transit','weather'].forEach((n,i)=>document.getElementById(n+'-panel').innerHTML=fragments[i]);
  selectView(currentView);
  [modules.transit,modules.weather]=await Promise.all([mountTransit(document.querySelector('#seattle-transit-eink')),mountWeather(document.querySelector('#seattle-weather-eink'),{initialOptions:weatherOptions,onChange:weatherChanged})]);
  window.displayCamera={read:()=>modules.transit.cameraState(),restore:state=>modules.transit.restoreCamera(state)};
  document.querySelectorAll('nav [data-view]').forEach(b=>b.addEventListener('click',()=>selectView(b.dataset.view)));
  modeSelect.addEventListener('change',()=>setMode(modeSelect.value));
  const exit=document.querySelector('#exit-kiosk');
  document.querySelector('#fullscreen').addEventListener('click',async()=>{
    document.body.classList.add('kiosk');exit.hidden=false;
    try{await document.documentElement.requestFullscreen();}catch{/* Escape button remains available if browser denies fullscreen. */}
  });
  exit.addEventListener('click',()=>{document.body.classList.remove('kiosk');exit.hidden=true;if(document.fullscreenElement)document.exitFullscreen();});
  document.addEventListener('fullscreenchange',()=>{if(!document.fullscreenElement){document.body.classList.remove('kiosk');exit.hidden=true;}});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'){document.body.classList.remove('kiosk');exit.hidden=true;}});
  await setMode(mode);
}
start().catch(()=>{connection.textContent='The display could not load. Check the server terminal, then reload this page.';window.frameReady=false;});
