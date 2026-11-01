import {etaMinutes,arrivalsFor,weatherAt,displayTime} from './live-utils.js';
import {assessRide,planRide,rainClass} from './ride-weather.js';
import {normalizeWeatherOptions,arrivalOffset} from './weather-options.js';
export async function mount(root,{initialOptions={},onChange=()=>{}}={}) {
      let settings=normalizeWeatherOptions(initialOptions);
      const scene=root.querySelector('.weather-map');
      const timeline=root.querySelector('.rain-timeline');
      const bikeRoute=await fetch('/assets/bike-route.json').then(r=>r.json());
      const data=await fetch('/assets/geography.json').then(r=>r.json());
      const illustration='/assets/whimsy.png';
      const terrain=data.terrain,land=Uint8Array.from(atob(terrain.land),c=>c.charCodeAt(0));
      const extent=[terrain.xs[0],terrain.ys[0],terrain.xs.at(-1),terrain.ys.at(-1)];
      const stepX=(extent[2]-extent[0])/(terrain.w-1),stepY=(extent[3]-extent[1])/(terrain.h-1);
      const places=[
        {name:'HOME',short:'Home',p:data.home.p,offset:0},
        {name:'FREMONT',short:'Fremont',p:[-728.1,1335.4,16.6],offset:9},
        {name:'SLU',short:'SLU',p:bikeRoute.stops[2],offset:22}
      ];
      // Map coordinates are the existing d3.geoMercator projection of published
      // Seattle/King County geometry. Fremont is at N 34th & Fremont Ave N.
      // The thin route follows sourced street and bicycle-facility geometry.
      // Passage offsets are assumptions; weather is simulated or provider-backed.
      const crops={sleep:[49,311,301,185],sit:[490,187,290,317],stand:[890,214,325,290],boat:[884,762,269,279]};
      let liveSnapshot=null,transitSnapshot=null,baseTime=Date.now();
      let departure=settings.departure==='auto'?0:settings.departure,followSuggestion=settings.departure==='auto',current=null,scenario=settings.scenario,preference=settings.preference,width=666,height=365;
      let mapBackground={width:0,html:''};
      const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
      const mix=(a,b,t)=>a+(b-a)*t;
      const num=x=>Math.round(x*10)/10;
      const clock=t=>{if(liveSnapshot)return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',hour:'numeric',minute:'2-digit'}).format(new Date(baseTime+t*60000)).replace(/ [AP]M$/,'');const m=490+t;return Math.floor(m/60)+':'+String(m%60).padStart(2,'0');};
      const el=(tag,a,c='')=>'<'+tag+' '+Object.entries(a).map(([k,v])=>k+'="'+v+'"').join(' ')+'>'+c+'</'+tag+'>';
      const path=ps=>ps.map((p,i)=>(i?'L':'M')+p.map(num).join(' ')).join(' ');
      const stroke=(ps,color,w,extra={})=>el('path',{d:path(ps),fill:'none',stroke:color,'stroke-width':w,'stroke-linecap':'round','stroke-linejoin':'round',...extra});
      const circle=(p,r,fill,line='none',sw=1)=>el('circle',{cx:num(p[0]),cy:num(p[1]),r,fill,stroke:line,'stroke-width':sw});
      const text=(p,str,cls,extra={})=>el('text',{x:num(p[0]),y:num(p[1]),class:cls,...extra},str);
      const bounds=ps=>[Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))];
      function elevation(x,y){
        const fi=clamp((x-extent[0])/stepX,0,terrain.w-2),fj=clamp((y-extent[1])/stepY,0,terrain.h-2);
        const i=Math.floor(fi),j=Math.floor(fj),a=fi-i,b=fj-j,k=j*terrain.w+i,z=terrain.z;
        return ((1-a)*(1-b)*z[k]+a*(1-b)*z[k+1]+(1-a)*b*z[k+terrain.w]+a*b*z[k+terrain.w+1])/4;
      }
      function dry(x,y){
        if(x<extent[0]||x>extent[2]||y<extent[1]||y>extent[3])return false;
        const i=clamp(Math.round((x-extent[0])/stepX),0,terrain.w-1),j=clamp(Math.round((y-extent[1])/stepY),0,terrain.h-1),k=j*terrain.w+i;
        return (land[k>>3]&(1<<(k&7)))!==0;
      }
      function weather(index,t){
        if(liveSnapshot)return weatherAt(liveSnapshot,index,baseTime+t*60000);
        if(scenario==='stale')return {rain:null,temp:null,gust:null};
        // Example data uses the same 15-minute blocks as the live forecast.
        const rain=scenario!=='showers'?0:[t>50?.9:0,t<=20?.65:t>50?1.2:0,t<=20?.2:t>65?.8:0][index];
        const gust=scenario==='wind'?[12,23,30][index]:[9,14,17][index];
        const temp=(scenario==='wind'?[49,50,51]:[52,51,53])[index]+(t>=45?1:0);
        return {rain,temp,gust};
      }
      function condition(w){return !w.complete?'No data':w.rain<.1&&w.gust>settings.gustLimit?'Gusty':({dry:'Dry',drizzle:'Drizzle',rain:'Rain',unknown:'No data'})[rainClass(w.rain)];}
      const where=i=>i===0?'at home':'near '+places[i].short;
      function advice(){
        const arriveByMinutes=arrivalOffset(settings.arriveBy,baseTime,{demo:!liveSnapshot});
        const rideOptions={preference,offsets:places.map(p=>p.offset),gustLimit:settings.gustLimit};
        const plan=planRide(weather,{...rideOptions,earliest:followSuggestion?0:departure,arriveByMinutes});
        if(followSuggestion)departure=plan.departure;
        const a=assessRide(weather,departure,rideOptions),compareNow=followSuggestion&&departure>0&&a.state==='bike'&&!!plan.window;
        const common={...a,compareNow,window:plan.window,arriveByMinutes};
        if(arriveByMinutes!==null&&arriveByMinutes<0)return {...common,compareNow:false,state:'deadline',title:'Arrival time has passed.',reason:'Change or clear your '+clock(arriveByMinutes)+' arrival time to plan this ride.'};
        if(a.state==='unknown')return {...common,compareNow:false,title:'Waiting for weather.',reason:'The forecast is incomplete or out of date. Ride guidance is paused.'};
        if((followSuggestion&&plan.deadlineBlocked)||(!followSuggestion&&arriveByMinutes!==null&&departure+places[2].offset+3>arriveByMinutes)){
          const flexible=followSuggestion?planRide(weather,rideOptions):null;
          const firstArrival=(flexible?.window?.start??departure)+places[2].offset;
          const reason=flexible?.window||a.state==='bike'?'The '+(followSuggestion?'first suitable':'shown')+' bike ride arrives around '+clock(firstArrival)+'. '+(firstArrival>arriveByMinutes?'Your deadline is '+clock(arriveByMinutes)+'.':'There is less than your 3-minute allowance before '+clock(arriveByMinutes)+'.'):
            'Your '+places[2].offset+'-minute ride plus the 3-minute allowance does not fit before '+clock(arriveByMinutes)+'.';
          return {...common,compareNow:false,state:'deadline',title:'Check the 62.',reason};
        }
        if(followSuggestion&&plan.brief)return {...common,compareNow:false,state:'brief',title:'Only a brief opening.',reason:'Conditions change close to the ride. No five-minute departure window fits your preferences.'};
        if(a.state==='bike'){
          const initial=plan.initial;
          const reason=compareNow?(initial.windAt>=0?'Stronger gusts '+where(initial.windAt):'Rain '+where(initial.wetAt))+' if you leave now.'+(a.maxRain>=.1?' Bring a rain shell.':''):
            a.maxRain>=.1?'Light drizzle at a checkpoint, within your rain preference. Bring a shell.':'Little rain forecast at all three checkpoints; gusts stay within your setting.';
          const windowTitle=followSuggestion&&plan.window&&plan.window.end>departure?'Bike '+clock(departure)+'–'+clock(plan.window.end)+'.':'Bike around '+clock(departure)+'.';
          return {...common,title:departure>0?windowTitle:a.maxRain>=.1?'Bike + rain shell.':'Bike now.',reason};
        }
        const later=plan.departure>departure?' Around '+clock(plan.departure)+' looks better.':' Consider the 62 for this departure.';
        if(a.windAt>=0)return {...common,compareNow:false,title:'Gusty '+where(a.windAt)+'.',reason:'Gusts reach '+Math.round(a.values[a.windAt].gust)+' mph, above your '+settings.gustLimit+' mph comfort limit.'+later};
        return {...common,compareNow:false,title:'Rain '+where(a.wetAt)+'.',reason:'Above your '+(preference==='dry'?'keep-me-dry':'light-drizzle')+' preference.'+later};
      }
      function picture(name,x,y,w,h){
        const [sx,sy,sw,sh]=crops[name],s=Math.min(w/sw,h/sh);
        return el('g',{transform:'matrix('+s+' 0 0 '+s+' '+(x+(w-sw*s)/2-sx*s)+' '+(y+h-sh*s-sy*s)+')','clip-path':'url(#rw-crop-'+name+')','data-whimsy':name,'aria-hidden':'true'},'<use xlink:href="#rw-art"/>');
      }
      function artDefs(){
        return '<defs>'+Object.entries(crops).map(([name,[x,y,w,h]])=>el('clipPath',{id:'rw-crop-'+name,clipPathUnits:'userSpaceOnUse'},el('rect',{x,y,width:w,height:h}))).join('')+'<filter id="rw-art-ink" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -.2126 -.7152 -.0722 1 0" result="ink-mask"/><feFlood flood-color="var(--paper)" result="paper-tone"/><feComposite in="paper-tone" in2="SourceAlpha" operator="in" result="paper-base"/><feFlood flood-color="var(--ink)" result="ink-tone"/><feComposite in="ink-tone" in2="ink-mask" operator="in" result="ink-lines"/><feMerge><feMergeNode in="paper-base"/><feMergeNode in="ink-lines"/></feMerge></filter><image id="rw-art" width="1254" height="1254" xlink:href="'+illustration+'" filter="url(#rw-art-ink)"/></defs>';
      }
      function renderMap(){
        width=Math.max(250,scene.clientWidth||666);height=width<430?365:365;
        const small=width<430,theta=(small?35:15)*Math.PI/180,C=Math.cos(theta),S=Math.sin(theta);
        const relief=2.2,homeZ=data.home.p[2];
        const rz=p=>p[2]===undefined?elevation(p[0],p[1]):p[2];
        const iso=p=>{const x=p[0]*C-p[1]*S,y=p[0]*S+p[1]*C;return [-.8660254*(x+y),.5*(x-y)-(rz(p)-homeZ)*relief];};
        const south=iso(places[2].p),s=(height-135)/-south[1];
        const cam={x:width*(small?.59:.76),y:height-65};
        const project=p=>{const q=iso(p);return [cam.x+q[0]*s,cam.y+q[1]*s];};
        const onMap=(p,m=0)=>p[0]>m&&p[0]<width-m&&p[1]>m&&p[1]<height-m;
        let out;
        if(mapBackground.width===width)out=mapBackground.html;
        else {
        out='<title>Your ride from home through Fremont to SLU</title><desc>A dark bicycle route connects home, Fremont, and South Lake Union. Callouts show forecasts at the estimated passage times, with a three-minute timing allowance. Terrain uses published Seattle geography and USGS elevations.</desc>';
        out+='<defs><clipPath id="rw-map-clip"><rect width="'+width+'" height="'+height+'"/></clipPath><linearGradient id="rw-fade"><stop stop-color="var(--paper)"/><stop offset="1" stop-color="var(--paper)" stop-opacity="0"/></linearGradient><linearGradient id="rw-fade-y" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--paper)"/><stop offset="1" stop-color="var(--paper)" stop-opacity="0"/></linearGradient></defs>'+artDefs();
        out+='<g clip-path="url(#rw-map-clip)">';
        const groups=Array.from({length:5},()=>[]),spacing=(small?5.7:6.2)/s;
        for(let y=Math.ceil(extent[1]/spacing)*spacing;y<extent[3];y+=spacing)for(let x=Math.ceil(extent[0]/spacing)*spacing;x<extent[2];x+=spacing){
          if(!dry(x,y))continue;
          const p=project([x,y]);if(!onMap(p,3))continue;
          const dx=(elevation(x+35,y)-elevation(x-35,y))/70,dy=(elevation(x,y+35)-elevation(x,y-35))/70;
          const bucket=Math.min(4,Math.floor(clamp(.43+dx*.65-dy*.55,.12,.85)*5));
          const radius=(small?.6:.65)+bucket*.055;
          groups[bucket].push('M'+num(p[0]-radius)+' '+num(p[1])+'a'+radius+' '+radius+' 0 1 0 '+radius*2+' 0a'+radius+' '+radius+' 0 1 0 -'+radius*2+' 0');
        }
        for(let i=0;i<groups.length;i++)out+=el('path',{d:groups[i].join(''),fill:'var(--dot)','data-terrain-band':i});
        for(const w of data.water){
          const rings=w.rings.map(r=>r.map(p=>project([p[0],p[1],w.name==='Puget Sound'?0:7])));
          out+=el('path',{d:rings.map(r=>path(r)+'Z').join(' '),fill:'var(--paper)','fill-rule':'evenodd',stroke:'var(--water-edge)','stroke-width':.9});
        }
        for(const r of data.roads){
          if(r.a===0)continue;
          const ps=r.p.map(project),b=bounds(ps);if(b[2]<0||b[0]>width||b[3]<0||b[1]>height)continue;
          out+=stroke(ps,'var(--paper)',2.1);out+=stroke(ps,'var(--road)',r.a===1?.9:.75);
        }
        const routePoints=bikeRoute.p.map(project);
        out+=stroke(routePoints,'var(--paper)',4.8,{'data-bike-route-halo':'true'});
        out+=stroke(routePoints,'var(--ink)',2.2,{'data-bike-route-line':'true'});
        out+='</g>';
        out+=el('rect',{width:25,height,fill:'url(#rw-fade)'});
        out+=el('rect',{width:25,height,fill:'url(#rw-fade)',transform:'translate('+width+' 0) scale(-1 1)'});
        out+=el('rect',{width,height:24,fill:'url(#rw-fade-y)'});
        out+=el('rect',{width,height:35,fill:'url(#rw-fade-y)',transform:'translate(0 '+height+') scale(1 -1)'});
        const lake=project(small?[500,3100,7]:[708.1,2227.1,7]);
        if(onMap(lake,35)){
          out+=text([lake[0],lake[1]],'Lake Union','place-label',{'text-anchor':'middle'});
          out+=picture('boat',lake[0]-10,lake[1]+10,21,23);
        }
        mapBackground={width,html:out};
        }
        // Fixed callout zones keep the three neighborhoods legible as the camera
        // adopts a more upright angle on a narrow display. Leaders preserve location.
        const markerPoints=places.map(p=>project(p.p));
        const labelW=small?126:145,labelH=72;
        const cards=small?[
          {x:clamp(markerPoints[0][0]-labelW-20,9,width-labelW-9),y:height-78},
          {x:9,y:195},
          {x:clamp(markerPoints[2][0]+17,10,width-labelW-8),y:18}
        ]:[
          {x:markerPoints[0][0]+18+labelW<=width-9?markerPoints[0][0]+18:markerPoints[0][0]-labelW-18,y:height-78},
          {x:clamp(markerPoints[1][0]+22,9,width-labelW-9),y:134},
          {x:markerPoints[2][0]-labelW-22>=9?markerPoints[2][0]-labelW-22:markerPoints[2][0]+17,y:24}
        ];
        const a=current;
        places.forEach((place,i)=>{
          const p=markerPoints[i],b=cards[i],w=a.values[i];
          const anchor=[clamp(p[0],b.x,b.x+labelW),clamp(p[1],b.y+5,b.y+labelH-5)];
          out+=stroke([p,anchor],'var(--muted-ink)',1);
          out+=el('rect',{x:b.x-5,y:b.y-4,width:labelW+10,height:labelH+5,fill:'var(--paper)',rx:1});
          out+=circle(p,6.5,'var(--paper)','var(--ink)',1.4)+circle(p,2.3,'var(--ink)');
          out+=text([b.x,b.y+11],place.name,'point-name');
          out+=text([b.x+labelW,b.y+11],clock(departure+place.offset),'point-time',{'text-anchor':'end'});
          out+=text([b.x,b.y+43],condition(w),'point-condition');
          const temperature=Number.isFinite(w.temp)?Math.round(w.temp)+'°F':'—°F';
          out+=text([b.x,b.y+65],temperature+' · gust '+(Number.isFinite(w.gust)?Math.round(w.gust):'—')+' mph','point-wind',{'font-weight':w.gust>settings.gustLimit?500:400});
        });
        const homeCard=cards[0],pose=a.state==='bike'?'stand':a.state==='unknown'?'sit':'sleep';
        const petX=small?Math.min(width-38,homeCard.x+labelW+10):Math.max(5,homeCard.x-39);
        out+=picture(pose,petX,height-38,34,30);
        scene.setAttribute('viewBox','0 0 '+width+' '+height);scene.setAttribute('height',height);scene.innerHTML=out;
      }
      function renderTimeline(){
        const horizon=Math.max(70,Math.ceil((45+places[2].offset+3)/10)*10);
        const w=Math.max(250,timeline.clientWidth||666),h=158,left=57,right=w-5,span=right-left,x=t=>left+t/horizon*span;
        // Leaving now is a stable comparison, even for a manually chosen ride
        // or unavailable weather. It describes timing, not a recommendation.
        const compareNow=departure>0;
        let out='<title>Your ride across the rain forecast</title><desc>The dotted line shows leaving now: Home at '+clock(0)+', Fremont at '+clock(places[1].offset)+', and SLU at '+clock(places[2].offset)+'. '+(compareNow?'The solid line follows the ride shown: Home at '+clock(departure)+', Fremont at '+clock(departure+places[1].offset)+', and SLU at '+clock(departure+places[2].offset)+'. ':'')+'Sparse hatching means drizzle; dense hatching means rain. Question marks mean no forecast. Short horizontal marks show the assumed three-minute passage allowance.'+(settings.arriveBy?' The upright mark in the SLU lane is your arrival deadline.':'')+'</desc><defs><pattern id="rw-rain-hatch" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><path d="M 0 0 L 0 5" stroke="var(--rain)" stroke-width="1.4"/></pattern><pattern id="rw-drizzle-hatch" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(28)"><path d="M 0 0 L 0 9" stroke="var(--rain)" stroke-width="1.2"/></pattern><pattern id="rw-missing" width="27" height="16" patternUnits="userSpaceOnUse"><text x="11" y="12" fill="var(--muted-ink)">?</text></pattern></defs>';
        const rows=[24,66,108];
        const pass=places.map((p,i)=>[x(departure+p.offset),rows[i]]);
        let hasMissing=false;
        places.forEach((p,i)=>{
          const y=rows[i];out+=text([0,y+4],p.short,'timeline-label');
          out+=el('rect',{x:left,y:y-8,width:span,height:16,fill:'var(--track)',rx:1});
          // Preserve discrete forecast intervals, including gaps anywhere in them.
          let start=0,kind=rainClass(weather(i,.5).rain);
          for(let t=1;t<=horizon;t++){
            const next=t===horizon?null:rainClass(weather(i,t+.5).rain);
            if(next!==kind){
              if(kind!=='dry')out+=el('rect',{x:x(start),y:y-8,width:x(t)-x(start),height:16,fill:'url(#'+(kind==='unknown'?'rw-missing':kind==='rain'?'rw-rain-hatch':'rw-drizzle-hatch')+')','data-forecast-band':kind});
              if(kind==='unknown')hasMissing=true;
              start=t;kind=next;
            }
          }
        });
        if(compareNow){
          const nowPass=places.map((p,i)=>[x(p.offset),rows[i]]);
          out+=stroke(nowPass,'var(--paper)',5);
          out+=stroke(nowPass,'var(--ink)',1.8,{'stroke-dasharray':'1 5','data-leave-now-line':'true'});
          nowPass.forEach(p=>{out+=circle(p,3.2,'var(--paper)','var(--ink)',1.3);});
        }
        // Draw the ride above the rain bands so the time path stays continuous.
        out+=stroke(pass,'var(--paper)',4.8);
        out+=stroke(pass,'var(--ink)',compareNow?2.2:1.8,{'data-ride-time-line':'true',...(!compareNow?{'stroke-dasharray':'1 5','data-leave-now-line':'true'}:{})});
        pass.forEach((p,i)=>{
          const at=departure+places[i].offset;
          out+=stroke([[x(Math.max(0,at-3)),p[1]],[x(Math.min(horizon,at+3)),p[1]]],'var(--paper)',5);
          out+=stroke([[x(Math.max(0,at-3)),p[1]],[x(Math.min(horizon,at+3)),p[1]]],'var(--ink)',1.5,{'data-passage-allowance':'true'});
          out+=circle(p,4.7,'var(--paper)','var(--ink)',1.4)+circle(p,1.7,'var(--ink)');
          const toLeft=p[0]+48>right,tx=p[0]+(toLeft?-9:9);
          out+=text([tx,p[1]-13],clock(at),'passage-time',{'text-anchor':toLeft?'end':'start','data-passage-label':places[i].short});
        });
        if(current.arriveByMinutes!==null&&current.arriveByMinutes>=0&&current.arriveByMinutes<=horizon){
          out+=stroke([[x(current.arriveByMinutes),100],[x(current.arriveByMinutes),123]],'var(--paper)',4);
          out+=stroke([[x(current.arriveByMinutes),100],[x(current.arriveByMinutes),123]],'var(--ink)',1.5,{'data-arrival-deadline':'true'});
        }
        for(const t of [0,Math.floor(horizon/20)*10,horizon])out+=text([x(t),153],clock(t),'timeline-tick',{'text-anchor':t===0?'start':t===horizon?'end':'middle'});
        root.querySelector('[data-shown-ride-key]').hidden=!compareNow;
        root.querySelector('[data-leave-now-label]').textContent='Leave now · '+clock(0);
        root.querySelector('[data-timeline-note]').textContent=hasMissing?'? = no forecast':compareNow?'Leave now → SLU '+clock(places[2].offset):'Forecast at each checkpoint';
        timeline.setAttribute('viewBox','0 0 '+w+' '+h);timeline.setAttribute('height',h);timeline.innerHTML=out;
      }
      function renderBus(){
        const node=root.querySelector('[data-bus-note]');
        if(!liveSnapshot){node.textContent='Next from home · 12 min · example';return;}
        const arrivals=arrivalsFor(transitSnapshot,'62'),first=arrivals[0];
        node.textContent=first?'Next from home · '+(etaMinutes(first)===0?'due now':etaMinutes(first)+' min')+(first.predicted?' · predicted':' · scheduled'):'Arrivals unavailable';
      }
      function update(){
        places[1].offset=settings.homeMinutes;places[2].offset=settings.homeMinutes+settings.sluMinutes;
        const a=current=advice();
        root.querySelector('.demo').textContent=liveSnapshot?'WEATHER FORECAST':'WEATHER DEMO';
        root.querySelector('[data-clock-note]').textContent=(followSuggestion?'Suggested':'Chosen')+' · '+(liveSnapshot?'Seattle time':'example morning');
        root.querySelector('[data-source-note]').textContent=liveSnapshot?('OPEN-METEO / NOAA · 15-min model forecast'+(liveSnapshot.sharedGrid?' · shared forecast grid':'')+' · '+(liveSnapshot.fetchedAt?'received '+displayTime(liveSnapshot.fetchedAt,{date:true}):'no update')):'DEMO · simulated weather · three forecast checkpoints';
        root.querySelector('[data-headline]').textContent=a.title;
        root.querySelector('[data-decision-label]').hidden=!(followSuggestion&&a.window&&a.state==='bike'&&departure>0);
        root.querySelector('[data-reason]').textContent=a.reason;
        root.querySelector('[data-journey]').textContent='Shown ride · '+clock(departure)+' → about '+clock(departure+places[2].offset);
        root.querySelector('[data-ride-duration]').textContent=places[2].offset+' min ride estimate';
        root.querySelector('[data-grid-note]').textContent=liveSnapshot?.sharedGrid?'Nearby points share a model cell':'15-minute model periods';
        root.querySelector('[data-arrival-note]').textContent=settings.arriveBy?'SLU deadline '+clock(a.arriveByMinutes):'Passage allowance ±3 min';
        root.querySelector('[data-departure-time]').textContent=clock(departure)+(liveSnapshot?' Seattle':' AM');
        root.querySelector('[data-departure]').value=departure;
        root.querySelector('[data-use-suggestion]').hidden=followSuggestion;
        for(const [selector,key] of [['[data-home-minutes]','homeMinutes'],['[data-slu-minutes]','sluMinutes'],['[data-gust-limit]','gustLimit'],['[data-arrive-by]','arriveBy']])root.querySelector(selector).value=settings[key];
        root.querySelector('[data-preference]').value=preference;
        root.querySelector('[data-scenario]').value=scenario;
        root.querySelector('[data-departure]').setAttribute('aria-valuetext',clock(departure)+(liveSnapshot?' Seattle':' AM'));
        root.querySelector('[data-announcement]').textContent=a.title+' '+a.reason+' Departure '+clock(departure)+'.';
        renderMap();renderTimeline();renderBus();onChange(options());
      }
      function options(){return {...settings,preference,scenario,departure:followSuggestion?'auto':departure};}
      for(const [selector,key] of [['[data-home-minutes]','homeMinutes'],['[data-slu-minutes]','sluMinutes'],['[data-gust-limit]','gustLimit'],['[data-arrive-by]','arriveBy']]){
        root.querySelector(selector).addEventListener('change',e=>{
          try{settings=normalizeWeatherOptions({...options(),[key]:e.target.value});root.querySelector('[data-setting-error]').textContent='';update();}
          catch{root.querySelector('[data-setting-error]').textContent='Enter a valid time or a number within the shown range.';}
        });
      }
      root.querySelector('[data-scenario]').addEventListener('change',e=>{scenario=e.target.value;followSuggestion=true;update();});
      root.querySelector('[data-preference]').addEventListener('change',e=>{preference=e.target.value;update();});
      root.querySelector('[data-departure]').addEventListener('input',e=>{departure=+e.target.value;followSuggestion=false;update();});
      root.querySelector('[data-use-suggestion]').addEventListener('click',()=>{followSuggestion=true;update();});
      new ResizeObserver(()=>{renderMap();renderTimeline();}).observe(scene);
      update();
      return {
        setLive(snapshot){liveSnapshot=snapshot;baseTime=Math.floor(Date.now()/60000)*60000;update();},
        setTransit(snapshot){transitSnapshot=snapshot;renderBus();},
        setDemo(){liveSnapshot=null;update();},
        options,
        render(){update();}
      };

    }
