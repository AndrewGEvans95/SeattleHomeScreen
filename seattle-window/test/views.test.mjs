// Exercise the actual SVG renderers and controls without requiring Chromium.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {mount as transitMount} from '../public/transit.js';
import {mount as weatherMount} from '../public/weather.js';
function root(width){
  const nodes={};return {nodes,querySelector(k){return nodes[k]||(nodes[k]={innerHTML:'',textContent:'',value:'',checked:false,hidden:false,clientWidth:width,style:{},attrs:{},setAttribute(k,v){this.attrs[k]=v;},addEventListener(k,v){this[k]=v;}});}};
}
test('both views: demo, live, absent GPS, missing data and recovery',async()=>{
  const old={fetch:global.fetch,document:global.document,ResizeObserver:global.ResizeObserver};
  global.fetch=async u=>({json:async()=>JSON.parse(await readFile(new URL('../public'+u,import.meta.url),'utf8'))});
  global.document={addEventListener(){}};global.ResizeObserver=class{observe(){}};
  try{
    for(const width of [666,272]){
      const tr=root(width),wr=root(width),t=await transitMount(tr),w=await weatherMount(wr);
      assert.equal(tr.querySelector('[data-eta]').textContent,'12');assert.equal(wr.querySelector('[data-headline]').textContent,'Bike 8:25–8:45.');
      assert.match(wr.querySelector('[data-journey]').textContent,/8:25 → about 8:47/);
      assert(wr.querySelector('.rain-timeline').innerHTML.includes('data-leave-now-line'));
      wr.querySelector('[data-departure]').input({target:{value:'10'}});
      assert(wr.querySelector('.rain-timeline').innerHTML.includes('data-leave-now-line'));
      assert.equal(wr.querySelector('[data-shown-ride-key]').hidden,false);
      wr.querySelector('[data-departure]').input({target:{value:'0'}});
      assert(wr.querySelector('.rain-timeline').innerHTML.includes('data-leave-now-line'));
      assert.equal(wr.querySelector('[data-shown-ride-key]').hidden,true);
      assert.equal(wr.querySelector('[data-headline]').textContent,'Rain near Fremont.');
      assert.match(wr.querySelector('[data-journey]').textContent,/8:10 → about 8:32/);
      wr.querySelector('[data-use-suggestion]').click();
      assert.equal(wr.querySelector('[data-departure]').value,15);
      wr.querySelector('[data-arrive-by]').change({target:{value:'08:40'}});
      assert.equal(wr.querySelector('[data-headline]').textContent,'Check the 62.');
      wr.querySelector('[data-arrive-by]').change({target:{value:''}});
      wr.querySelector('[data-home-minutes]').change({target:{value:'12'}});
      assert.equal(w.options().homeMinutes,12);assert.match(wr.querySelector('[data-ride-duration]').textContent,/25 min/);
      wr.querySelector('[data-home-minutes]').change({target:{value:'9'}});
      tr.querySelector('[data-step]').click();assert.equal(tr.querySelector('[data-eta]').textContent,'11');
      t.setLive({status:'unconfigured',arrivals:[]});assert.equal(tr.querySelector('[data-eta]').textContent,'—');assert(!tr.querySelector('.map').innerHTML.includes('class="bus-number"'));
      const now=Date.now(),first={route:'62',tripId:'a',arrivalTime:now+119000,predicted:true,location:{lon:-122.339653,lat:47.661461,updatedAt:now}};
      t.setLive({status:'ok',fetchedAt:now,arrivals:[first],extraStatus:'not_configured'});
      assert.equal(tr.querySelector('[data-leave]').textContent,'Too close to count on');assert(tr.querySelector('.map').innerHTML.includes('>62</text>'));
      t.setLive({status:'ok',fetchedAt:now,arrivals:[{...first,arrivalTime:now+7*60000}]});assert.equal(t.cameraState().level,0);
      t.setLive({status:'ok',fetchedAt:now,arrivals:[{...first,tripId:'next',arrivalTime:now+7*60000}]});assert.equal(t.cameraState().level,2);
      t.setLive({status:'ok',fetchedAt:now,arrivals:[{...first,location:{lon:-122.29,lat:47.72,updatedAt:now}}]});
      assert.match(tr.querySelector('[data-view-name]').textContent,/outside view/);assert(!tr.querySelector('.map').innerHTML.includes('class="bus-number"'));
      t.setLive({status:'ok',fetchedAt:now,arrivals:[{...first,location:null,predicted:false}]});
      assert.match(tr.querySelector('[data-leave]').textContent,/Scheduled/);assert(!tr.querySelector('.map').innerHTML.includes('class="bus-number"'));
      t.setLive({status:'stale',fetchedAt:now-180000,arrivals:[first]});assert.equal(tr.querySelector('[data-eta]').textContent,'—');
      const gps={...first,source:'gps_estimate',predicted:false,arrivalTime:now+360000,earliestArrivalTime:now+299000,latestArrivalTime:now+421000,updatedAt:now,validUntil:now+90000};
      const estimateSnapshot={status:'ok',source:'gps_estimate',fetchedAt:now,arrivals:[gps,{...gps,route:'44'}],extraStatus:'not_configured',estimator:{status:'ready',message:'GPS ranges are experimental.'}};
      t.setLive(estimateSnapshot);
      assert.equal(tr.querySelector('[data-eta]').textContent,'4–8');
      assert.equal(tr.querySelector('[data-leave]').textContent,'Aim to leave in 1 min');
      assert.equal(tr.querySelector('[data-source-note]').textContent,'GPS estimate · experimental');
      assert.equal(tr.querySelector('[data-eta44]').textContent,'4–8');
      assert.equal(tr.querySelector('.secondary-unit').textContent,'min · GPS est.');
      assert.match(tr.querySelector('[data-announcement]').textContent,/GPS estimate 4–8 minutes/);
      t.setLive({...estimateSnapshot,arrivals:[{...gps,validUntil:now-1}]});
      assert.equal(tr.querySelector('[data-eta]').textContent,'—');
      t.setLive({...estimateSnapshot,arrivals:[],estimator:{status:'warming_up',message:'Collecting fresh observations.'}});
      assert.equal(tr.querySelector('[data-leave]').textContent,'Learning bus movement');
      assert.equal(tr.querySelector('[data-allowance-note]').textContent,'Collecting fresh observations.');
      const end=Math.ceil(now/900000)*900000;
      const point={samples:Array.from({length:13},(_,i)=>({end:end+(i-1)*900000,rain:0,temp:52.7,gust:12.3}))};
      w.setLive({status:'ok',fetchedAt:now,points:[point,point,point],sharedGrid:true});assert.equal(wr.querySelector('[data-headline]').textContent,'Bike now.');assert.match(wr.querySelector('[data-source-note]').textContent,/shared forecast grid/);
      w.setTransit({status:'ok',fetchedAt:now,arrivals:[{...first,arrivalTime:now+10*60000}]});assert.match(wr.querySelector('[data-bus-note]').textContent,/10 min · predicted/);
      w.setTransit(estimateSnapshot);assert.equal(wr.querySelector('[data-bus-note]').textContent,'Next from home · 4–8 min · GPS estimate · experimental');
      w.setTransit({...estimateSnapshot,arrivals:[{...gps,validUntil:now-1}]});assert.equal(wr.querySelector('[data-bus-note]').textContent,'Arrivals unavailable');
      w.setTransit({status:'stale',fetchedAt:now,arrivals:[first]});assert.equal(wr.querySelector('[data-bus-note]').textContent,'Arrivals unavailable');
      assert(wr.querySelector('.rain-timeline').innerHTML.includes('data-ride-time-line'));assert(wr.querySelector('.weather-map').innerHTML.includes('data-bike-route-line'));
      const partial={samples:point.samples.map((s,i)=>i===5?{...s,rain:null}:s)};
      w.setLive({status:'ok',fetchedAt:now,points:[partial,point,point]});assert(wr.querySelector('.rain-timeline').innerHTML.includes('data-forecast-band="unknown"'));
      w.setLive({status:'unavailable'});assert.equal(wr.querySelector('[data-headline]').textContent,'Waiting for weather.');assert.equal(wr.querySelector('[data-timeline-note]').textContent,'? = no forecast');
      t.setDemo();w.setDemo();assert.equal(tr.querySelector('[data-eta]').textContent,'12');assert.equal(wr.querySelector('[data-headline]').textContent,'Bike 8:25–8:45.');
      assert(!/NaN|undefined/.test(tr.querySelector('.map').innerHTML+wr.querySelector('.weather-map').innerHTML));
    }
  }finally{Object.assign(global,old);}
});
