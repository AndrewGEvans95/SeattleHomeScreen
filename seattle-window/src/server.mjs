import http from 'node:http';
import {readFile,stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createFeeds} from './data.mjs';
import {renderFrame,closeRenderer} from './renderer.mjs';
import {readWeatherOptions} from '../public/weather-options.js';
import {configureNetwork} from './network.mjs';

export const projectRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export async function loadConfig(){
  const config={HOST:'127.0.0.1',PORT:'8787',HOME_STOP_ID:'1_29530',FREMONT_STOP_ID:'',OBA_API_KEY:''};
  try{for(const line of (await readFile(path.join(projectRoot,'.env'),'utf8')).split(/\r?\n/)){
    const m=line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);if(m&&!line.trim().startsWith('#'))config[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
  }}catch(e){if(e.code!=='ENOENT')throw e;}
  for(const key of [...Object.keys(config),'CHROMIUM_EXECUTABLE','GTFS_INDEX','ESTIMATOR_STATE_PATH'])if(process.env[key]!==undefined)config[key]=process.env[key];
  if(!/^\d+$/.test(config.PORT)||+config.PORT<1||+config.PORT>65535)throw new Error('Invalid PORT');
  return config;
}
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.json':'application/json; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
export function createServer({config,feeds}){
  const publicRoot=path.join(projectRoot,'public');
  return http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Cache-Control','no-store');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'self'; base-uri 'none'");
    const json=(code,value)=>{res.writeHead(code,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      if(req.method!=='GET'&&req.method!=='HEAD')return json(405,{error:'Read-only service'});
      const u=new URL(req.url,'http://localhost');
      if(u.pathname==='/api/health')return json(200,{ok:true,transitConfigured:!!config.OBA_API_KEY});
      if(u.pathname==='/api/transit')return json(200,await feeds.transit());
      if(u.pathname==='/api/gps-estimates')return json(200,await feeds.gpsEstimates());
      if(u.pathname==='/api/estimator')return json(200,await feeds.estimator());
      if(u.pathname==='/api/vehicles')return json(200,await feeds.vehicles());
      if(u.pathname==='/api/weather')return json(200,await feeds.weather());
      if(u.pathname==='/api/frame.png'){
        const view=u.searchParams.get('view')||'transit',mode=u.searchParams.get('mode')||'live';
        if(!['transit','weather'].includes(view)||!['live','demo'].includes(mode))return json(400,{error:'Invalid view or mode'});
        let weatherOptions;
        try{if(view==='weather')weatherOptions=readWeatherOptions(u.searchParams);}catch{return json(400,{error:'Invalid weather settings'});}
        try{
          const png=await renderFrame({port:config.PORT,view,mode,weatherOptions,executablePath:config.CHROMIUM_EXECUTABLE});
          res.writeHead(200,{'Content-Type':'image/png'});return res.end(png);
        }catch(e){return json(503,{error:e.message==='renderer_busy'?'An image is already rendering. Try again shortly.':'PNG renderer unavailable. Run npm run install:renderer, or configure CHROMIUM_EXECUTABLE. The browser prototype still works.'});}
      }
      if(u.pathname.startsWith('/api/'))return json(404,{error:'Unknown endpoint'});
      const decoded=decodeURIComponent(u.pathname==='/'?'/index.html':u.pathname);
      const file=path.resolve(publicRoot,'.'+decoded);
      if(!file.startsWith(publicRoot+path.sep))return json(403,{error:'Forbidden'});
      try{if(!(await stat(file)).isFile())return json(404,{error:'Not found'});}catch{return json(404,{error:'Not found'});}
      const content=await readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream'});res.end(req.method==='HEAD'?undefined:content);
    }catch{return json(500,{error:'Request failed. No credentials are included in this response.'});}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  configureNetwork();
  const config=await loadConfig();
  const places=JSON.parse(await readFile(path.join(projectRoot,'public/assets/places.json'),'utf8'));
  const feeds=createFeeds(config,places);
  const server=createServer({config,feeds});
  server.on('error',e=>{console.error(e.code==='EADDRINUSE'?'Port already in use; change PORT in .env.':`Server error: ${e.code}`);process.exitCode=1;});
  server.listen(+config.PORT,config.HOST,()=>{
    feeds.start();
    console.log(`Seattle Window: http://localhost:${config.PORT}\nTransit: ${config.OBA_API_KEY?'OneBusAway key configured':'GPS estimates (experimental)'}\nOpen the page and choose Live to connect providers.`);
  });
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{server.close();Promise.allSettled([feeds.close(),closeRenderer()]).finally(()=>process.exit(0));});
}
