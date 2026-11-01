import {weatherQuery} from '../public/weather-options.js';
let browser=null,busy=false;
const cache=new Map();
let transitCamera=null;
export async function renderFrame({port,view,mode,weatherOptions,executablePath}){
  const query=new URLSearchParams({frame:'1',view,mode});
  if(view==='weather')for(const [key,value] of weatherQuery(weatherOptions))query.set(key,value);
  const key=port+':'+query,old=cache.get(key);
  if(old&&Date.now()-old.time<25_000)return old.png;
  if(busy)throw new Error('renderer_busy');
  busy=true;let page;
  try{
    const {chromium}=await import('playwright');
    if(!browser?.isConnected())browser=await chromium.launch({headless:true,...(executablePath?{executablePath}:{})});
    page=await browser.newPage({viewport:{width:720,height:960},deviceScaleFactor:1.95,colorScheme:'light'});
    await page.goto(`http://127.0.0.1:${port}/?${query}`,{waitUntil:'networkidle',timeout:40_000});
    await page.waitForFunction(()=>window.frameReady===true,{},{timeout:30_000});
    if(view==='transit'&&mode==='live'){
      if(transitCamera)await page.evaluate(state=>window.displayCamera?.restore(state),transitCamera);
      transitCamera=await page.evaluate(()=>window.displayCamera?.read());
    }
    const source=await page.screenshot({type:'png',animations:'disabled'});
    // Quantize the actual browser rendering to 16 neutral gray levels. This is
    // an image endpoint, not E1003 firmware or a physical-panel simulation.
    const uri=await page.evaluate(async b64=>{
      const img=new Image();img.src='data:image/png;base64,'+b64;await img.decode();
      const c=document.createElement('canvas');c.width=1404;c.height=1872;
      const ctx=c.getContext('2d');ctx.drawImage(img,0,0,c.width,c.height);
      const pixels=ctx.getImageData(0,0,c.width,c.height),d=pixels.data;
      for(let i=0;i<d.length;i+=4){const v=Math.round((.2126*d[i]+.7152*d[i+1]+.0722*d[i+2])/17)*17;d[i]=d[i+1]=d[i+2]=v;d[i+3]=255;}
      ctx.putImageData(pixels,0,0);return c.toDataURL('image/png').split(',')[1];
    },source.toString('base64'));
    const png=Buffer.from(uri,'base64');
    for(const [id,item] of cache)if(Date.now()-item.time>=25_000)cache.delete(id);
    while(cache.size>=8)cache.delete(cache.keys().next().value);
    cache.set(key,{time:Date.now(),png});return png;
  }finally{await page?.close();busy=false;}
}
export async function closeRenderer(){await browser?.close();browser=null;cache.clear();transitCamera=null;}
