import {vehicleType,busSilhouette} from './fleet.js';
import {etaMinutes,arrivalsFor,worldPoint,departureAdvice,displayTime,gpsEstimateRange,arrivalLabel} from './live-utils.js';
export async function mount(root) {
      const scene=root.querySelector('.map');
      const data=await fetch('/assets/geography.json').then(r=>r.json());
      const illustration='/assets/whimsy.png';
      const illustrations={sleep:[49,311,301,185],sit:[490,187,290,317],stand:[890,214,325,290],crowLeft:[62,794,277,239],crowRight:[480,785,296,248],boat:[884,762,269,279]};
      const viewSelect=root.querySelector('[data-view]');
      const playButton=root.querySelector('[data-play]');
      const stepButton=root.querySelector('[data-step]');
      const allowanceSelect=root.querySelector('[data-allowance]');
      const closeSelect=root.querySelector('[data-close-at]');
      const staleToggle=root.querySelector('[data-stale]');
      const terrain=data.terrain;
      const land=Uint8Array.from(atob(terrain.land),c=>c.charCodeAt(0));
      const names=['Your block','Wallingford','Fremont & Lake Union','Seattle'];
      const homeHeight=data.home.p[2];
      const extent=[terrain.xs[0],terrain.ys[0],terrain.xs.at(-1),terrain.ys.at(-1)];
      const stepX=(extent[2]-extent[0])/(terrain.w-1),stepY=(extent[3]-extent[1])/(terrain.h-1);
      let liveSnapshot=null,gpsSnapshot=null,demoKind='articulated';
      const kindSelect=root.querySelector('[data-vehicle-kind]');
      function freshVehicles(){return gpsSnapshot?.status==='ok'&&gpsSnapshot.fetchedAt&&Date.now()-gpsSnapshot.fetchedAt<120000?(gpsSnapshot.vehicles||[]).filter(v=>Date.now()-v.location.updatedAt<120000):[];}
      function typeDetail(v){const t=v?.type||vehicleType(v?.vehicleId);return t.kind==='unknown'?'Vehicle type unavailable':t.label+' bus';}
      function updateVehicleDetail(){
        const a=liveSnapshot?arrivalsFor(liveSnapshot,'62')[0]:null;
        const profile=root.querySelector('[data-vehicle-profile]');if(profile)profile.hidden=!!liveSnapshot&&!a;
        const assigned=liveSnapshot?freshVehicles().find(v=>v.tripId===a?.tripId):null;
        const t=liveSnapshot?vehicleType(assigned?.vehicleId||a?.vehicleId):{kind:demoKind,label:demoKind==='articulated'?'Articulated':demoKind==='standard'?'Standard':'Type unknown',nominalFeet:demoKind==='articulated'?60:demoKind==='standard'?40:null};
        const glyph=root.querySelector('[data-vehicle-glyph]');if(glyph)glyph.innerHTML=busSilhouette(t.kind);
        const label=root.querySelector('[data-vehicle-label]');if(label)label.textContent=typeDetail({type:t,vehicleId:a?.vehicleId});
        const basis=root.querySelector('[data-vehicle-basis]');if(basis)basis.textContent=liveSnapshot?(a?.vehicleId?(t.kind==='unknown'?'Vehicle type could not be verified':'Vehicle type inferred from fleet roster'):'Awaiting trip assignment'):'Example vehicle';
      }
      let level=3,target=3,timer=null,elapsed=0,allowance=2,stale=false,lastObservation=0;
      let mode='auto',ambientStep=0,closeAt=3,autoTrip=null,autoLevel=3;
      const buffer=1;
      let animationTimer=null,animations=[],settledHTML='';
      let width=666,height=390,primaryOutside=false;
      const clamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
      const mix=(a,b,t)=>a+(b-a)*t;
      const smooth=(a,b,x)=>{const t=clamp((x-a)/(b-a));return t*t*(3-2*t);};
      const num=x=>Math.round(x*10)/10;
      const pts=ps=>ps.map(p=>p.map(num).join(',')).join(' ');
      const path=ps=>ps.map((p,i)=>(i?'L':'M')+p.map(num).join(' ')).join(' ');
      const el=(tag,a,c='')=>'<'+tag+' '+Object.entries(a).map(([k,v])=>k+'="'+v+'"').join(' ')+'>'+c+'</'+tag+'>';
      const polygon=(ps,fill,stroke='none',sw=.6)=>el('polygon',{points:pts(ps),fill,stroke,'stroke-width':sw,'stroke-linejoin':'round'});
      const stroke=(ps,color,w,extra={})=>el('path',{d:path(ps),fill:'none',stroke:color,'stroke-width':w,'stroke-linecap':'round','stroke-linejoin':'round',...extra});
      const circle=(p,r,fill,line='none',sw=1)=>el('circle',{cx:num(p[0]),cy:num(p[1]),r,fill,stroke:line,'stroke-width':sw});
      const txt=(p,str,cls='map-label',anchor='start',extra={})=>el('text',{x:num(p[0]),y:num(p[1]),class:cls,'text-anchor':anchor,...extra},str);
      const textContext=typeof document.createElement==='function'?document.createElement('canvas').getContext('2d'):null;
      function labelWidth(str,quiet,large){
        if(!textContext)return str.length*(large?11.2:quiet?7.4:8.8);
        textContext.font=(quiet?'400':'500')+' '+(large?16:quiet?12:13)+'px "Helvetica Neue", Arial, sans-serif';
        return Math.ceil(textContext.measureText(str).width)+3;
      }
      function picture(name,x,y,w,h){
        const [sx,sy,sw,sh]=illustrations[name],scale=Math.min(w/sw,h/sh);
        const tx=x+(w-sw*scale)/2-sx*scale,ty=y+h-sh*scale-sy*scale;
        return el('g',{transform:'matrix('+scale+' 0 0 '+scale+' '+tx+' '+ty+')','clip-path':'url(#lc-art-crop-'+name+')','data-whimsy':name,'aria-hidden':'true'},'<use xlink:href="#lc-illustration-sheet"/>');
      }
      function withinRing(p,ring){
        let inside=false;
        for(let i=0,j=ring.length-1;i<ring.length;j=i++){
          const a=ring[i],b=ring[j];
          if((a[1]>p[1])!==(b[1]>p[1])&&p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0])inside=!inside;
        }
        return inside;
      }
      // The demo follows connected segments of the published 62 geometry toward
      // the westbound stop, then south on Stone Way. Speeds and timings are illustrative.
      const route62=data.routes.find(r=>r.n==='62');
      const approachParts=[[123,1],[121,1],[119,1],[118,1],[115,1],[114,0],[113,1],[111,1],[109,1],[108,1],[106,1],[105,1],[90,1],[91,1],[92,0],[94,1],[95,0],[96,1],[97,0],[100,0],[103,1],[102,0],[88,0],[86,1]];
      const approach=[];
      for(const [index,reverse] of approachParts){
        const part=route62.parts[index].slice();if(reverse)part.reverse();
        for(const p of part)if(!approach.length||Math.hypot(p[0]-approach.at(-1)[0],p[1]-approach.at(-1)[1])>.2)approach.push(p);
      }
      const distances=[0];
      for(let i=1;i<approach.length;i++)distances.push(distances[i-1]+Math.hypot(approach[i][0]-approach[i-1][0],approach[i][1]-approach[i-1][1]));
      let stopDistance=0,nearest=Infinity;
      for(let i=1;i<approach.length;i++){
        const a=approach[i-1],b=approach[i],dx=b[0]-a[0],dy=b[1]-a[1];
        const t=clamp(((data.stop.p[0]-a[0])*dx+(data.stop.p[1]-a[1])*dy)/(dx*dx+dy*dy));
        const gap=Math.hypot(a[0]+dx*t-data.stop.p[0],a[1]+dy*t-data.stop.p[1]);
        if(gap<nearest){nearest=gap;stopDistance=mix(distances[i-1],distances[i],t);}
      }
      function routePoint(d){
        d=clamp(d,0,distances.at(-1));
        let i=1;while(i<distances.length-1&&distances[i]<d)i++;
        const t=(d-distances[i-1])/(distances[i]-distances[i-1]);
        return approach[i-1].map((v,j)=>mix(v,approach[i][j],t));
      }
      function distanceBeforeStop(minutes){
        const keys=[[0,0],[1,32],[2,85],[4,240],[7,550],[10,1150],[13,1800]];
        if(minutes<0)return minutes*110;
        for(let i=1;i<keys.length;i++)if(minutes<=keys[i][0])return mix(keys[i-1][1],keys[i][1],(minutes-keys[i-1][0])/(keys[i][0]-keys[i-1][0]));
        return keys.at(-1)[1];
      }
      const currentEta=()=>liveSnapshot?etaMinutes(arrivalsFor(liveSnapshot,'62')[0]):(elapsed<=12?12-elapsed:25-elapsed);
      function primaryObservation(){
        if(liveSnapshot){
          const a=arrivalsFor(liveSnapshot,'62')[0],v=freshVehicles().find(v=>v.tripId===a?.tripId),loc=v?.location||a?.location;
          if(!loc||Date.now()-loc.updatedAt>120000||stale)return null;
          const p=worldPoint(loc.lon,loc.lat,data.home.geo);
          return {p,ahead:p,eta:etaMinutes(a),type:vehicleType(v?.vehicleId||a?.vehicleId),vehicleId:v?.vehicleId||a?.vehicleId,updatedAt:loc.updatedAt};
        }
        const observed=stale?lastObservation:elapsed;
        const eta=observed<=12?12-observed:25-observed;
        const d=stopDistance-distanceBeforeStop(eta);
        return {p:routePoint(d),ahead:routePoint(d+18),eta,type:{kind:demoKind}};
      }
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
      function camera(l,w,h){
        const small=w<430;
        const scales=small?[(w-30)/330,(w-24)/1450,(w-26)/3500,(w-28)/8000]:[Math.min(1.05,(w-50)/560),(w-50)/2100,(w-50)/4900,(w-50)/10500];
        const ax=small?[.64,.70,.76,.84]:[.60,.67,.73,.79];
        const ay=small?[.70,.63,.60,.59]:[.70,.72,.78,.78];
        const i=Math.min(2,Math.floor(l)),t=l-i;
        return {scale:Math.exp(mix(Math.log(scales[i]),Math.log(scales[i+1]),t)),x:w*mix(ax[i],ax[i+1],t),y:h*mix(ay[i],ay[i+1],t),relief:3*smooth(.15,1.5,l)};
      }
      const bounds=ps=>[Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))];
      data.roads.forEach(r=>r.box=bounds(r.p));
      data.buildings.forEach(b=>{b.box=bounds(b.p);b.center=[(b.box[0]+b.box[2])/2,(b.box[1]+b.box[3])/2];});
      const crowRoofs=[[-65,75],[50,-55],[-100,-15],[10,110]].map(p=>data.buildings.filter(b=>b.l&&b.id!==data.home.id).reduce((best,b)=>Math.hypot(b.center[0]-p[0],b.center[1]-p[1])<Math.hypot(best.center[0]-p[0],best.center[1]-p[1])?b:best));
      const lakeWater=data.water.filter(w=>w.name==='Lake Union');
      const inLake=p=>lakeWater.some(w=>w.rings.reduce((inside,ring)=>inside!==withinRing(p,ring),false));
      function onMap(p,margin=10){return p[0]>margin&&p[0]<width-margin&&p[1]>margin&&p[1]<height-margin;}
      function render(l){
        primaryOutside=false;
        width=Math.max(250,scene.clientWidth||666);height=width<430?340:390;
        const small=width<430,c=camera(l,width,height),s=c.scale;
        const project=(p,z=0)=>[c.x-.8660254*(p[0]+p[1])*s,c.y+.5*(p[0]-p[1])*s-((p[2]===undefined?elevation(p[0],p[1]):p[2])-homeHeight)*c.relief*s-z*s];
        const projectGround=p=>project(p,0);
        const visibleBox=b=>{
          const ps=[[b[0],b[1]],[b[0],b[3]],[b[2],b[1]],[b[2],b[3]]].map(p=>project(p));
          const bb=bounds(ps);return bb[2]>-60&&bb[0]<width+60&&bb[3]>-70&&bb[1]<height+50;
        };
        const dogPose=stale?'sit':currentEta()<=allowance+buffer+1?'stand':currentEta()<=6?'sit':'sleep';
        let out='<title id="little-city-title">'+names[Math.round(l)].replaceAll('&','&amp;')+' transit view</title><desc id="little-city-description">An isometric view from home. Buildings gradually dissolve into a grid of dots following USGS elevation data. Route 62 remains a solid line. '+(liveSnapshot?'Only fresh reported vehicle locations are shown.':'All buses and arrivals are simulated.')+' Poptart '+(dogPose==='sleep'?'is curled up by Home.':dogPose==='sit'?'sits by Home.':'stands ready by Home.')+' A small illustrated crow changes rooftop perches in the block view; a decorative sailboat appears on Lake Union at wider scales. Terrain relief is exaggerated three times.</desc>';
        out+='<defs><clipPath id="lc-clip"><rect x="0" y="0" width="'+width+'" height="'+height+'"/></clipPath><linearGradient id="lc-side"><stop offset="0" stop-color="var(--paper)"/><stop offset="1" stop-color="var(--paper)" stop-opacity="0"/></linearGradient><linearGradient id="lc-end" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="var(--paper)"/><stop offset="1" stop-color="var(--paper)" stop-opacity="0"/></linearGradient></defs>';
        // Recolor the ink and paper through the product palette in either appearance.
        out+='<defs>'+Object.entries(illustrations).map(([name,[x,y,w,h]])=>el('clipPath',{id:'lc-art-crop-'+name,clipPathUnits:'userSpaceOnUse'},el('rect',{x,y,width:w,height:h}))).join('')+'</defs>';
        out+='<defs><filter id="lc-art-ink" color-interpolation-filters="sRGB" x="0" y="0" width="100%" height="100%"><feColorMatrix in="SourceGraphic" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 -.2126 -.7152 -.0722 1 0" result="ink-mask"/><feFlood flood-color="var(--paper)" result="paper-tone"/><feComposite in="paper-tone" in2="SourceAlpha" operator="in" result="paper-base"/><feFlood flood-color="var(--ink)" result="ink-tone"/><feComposite in="ink-tone" in2="ink-mask" operator="in" result="ink-lines"/><feMerge><feMergeNode in="paper-base"/><feMergeNode in="ink-lines"/></feMerge></filter><image id="lc-illustration-sheet" width="1254" height="1254" xlink:href="'+illustration+'" filter="url(#lc-art-ink)"/></defs>';
        out+='<g clip-path="url(#lc-clip)">';
        // The same georeferenced geometry is retained throughout all four scales.
        const buildingAlpha=1-smooth(.5,1.85,l),dotAlpha=smooth(.35,1.65,l);
        if(l<1.4){
          out+='<g opacity="'+(1-smooth(.15,1.4,l)).toFixed(3)+'">';
          out+=polygon([[-225,-15],[220,-15],[220,215],[-225,215]].map(projectGround),'var(--ground)');out+='</g>';
        }
        if(dotAlpha>.005){
          const spacing=(small?5.7:6.2)/(.8660254*s);
          const groups=Array.from({length:5},()=>[]);
          const backProject=p=>{const u=(c.x-p[0])/(.8660254*s),v=2*(p[1]-c.y)/s;return [(u+v)/2,(u-v)/2];};
          const visible=bounds([[0,0],[width,0],[width,height],[0,height]].map(backProject)),pad=c.relief*160;
          const minX=Math.max(extent[0],visible[0]-pad),minY=Math.max(extent[1],visible[1]-pad),maxX=Math.min(extent[2],visible[2]+pad),maxY=Math.min(extent[3],visible[3]+pad);
          for(let y=Math.ceil(minY/spacing)*spacing;y<=maxY;y+=spacing){
            for(let x=Math.ceil(minX/spacing)*spacing;x<=maxX;x+=spacing){
              if(!dry(x,y))continue;
              const z=elevation(x,y),p=project([x,y,z]);
              if(!onMap(p,4))continue;
              const slopeX=(elevation(x+35,y)-elevation(x-35,y))/70,slopeY=(elevation(x,y+35)-elevation(x,y-35))/70;
              const shade=clamp(.43+slopeX*.65-slopeY*.55,.12,.85);
              const bucket=Math.min(4,Math.floor(shade*5));
              // Tone comes from dot size, keeping individual marks solid on e-paper.
              const radius=(small?.6:.65)+bucket*.055;
              groups[bucket].push('M'+num(p[0]-radius)+' '+num(p[1])+'a'+radius+' '+radius+' 0 1 0 '+(radius*2)+' 0a'+radius+' '+radius+' 0 1 0 -'+(radius*2)+' 0');
            }
          }
          for(let i=0;i<groups.length;i++)out+=el('path',{d:groups[i].join(''),fill:'var(--dot)',opacity:dotAlpha.toFixed(3),'data-terrain-band':i});
        }
        // Water cuts clean openings through the point field; the outlines are sourced.
        if(l>.4)for(const w of data.water){
          const rings=w.rings.map(r=>r.map(p=>project([p[0],p[1],w.name==='Puget Sound'?0:7])));
          out+=el('path',{d:rings.map(r=>path(r)+'Z').join(' '),fill:'var(--water)','fill-rule':'evenodd',stroke:'var(--curb)','stroke-width':.9,opacity:smooth(.4,1.2,l).toFixed(3)});
        }
        // Street widths collapse to restrained hairlines as the camera pulls back.
        for(const r of data.roads){
          if(!visibleBox(r.box))continue;
          if(l>2.15&&r.a===0)continue;
          const ps=r.p.map(projectGround);
          if(l<1.15){
            const wide=Math.max(.6,r.w*s*.8);
            out+=stroke(ps,'var(--curb)',wide+1,{opacity:(1-smooth(.45,1.4,l)).toFixed(3)});
            out+=stroke(ps,'var(--street)',wide,{opacity:(1-smooth(.5,1.5,l)).toFixed(3)});
          }
          if(l>.55){
            const alpha=(r.a===0?.7:1)*smooth(.55,1.4,l);
            out+=stroke(ps,'var(--paper)',l>2?1.8:2.1,{opacity:alpha.toFixed(3)});
            out+=stroke(ps,'var(--road-line)',r.a===1?.9:.75,{opacity:alpha.toFixed(3)});
          }
        }
        if(buildingAlpha>.005){
          const bs=data.buildings.filter(b=>visibleBox(b.box)&&(b.l||l>.16));
          bs.sort((a,b)=>project([...a.center,a.h])[1]-project([...b.center,b.h])[1]);
          for(const b of bs){
            const home=b.id===data.home.id;
            const alpha=buildingAlpha*(b.l?1:smooth(.16,.70,l));
            const rise=(home?14:8)*(1-smooth(.25,1.5,l));
            const base=b.p.map(p=>project([p[0],p[1],b.h])),roof=b.p.map(p=>project([p[0],p[1],b.h],rise));
            out+='<g opacity="'+alpha.toFixed(3)+'">';
            if(rise*s>1.5)for(let i=1;i<base.length;i++)out+=polygon([base[i-1],base[i],roof[i],roof[i-1]],home?'var(--home-face)':(roof[i][0]>roof[i-1][0]?'var(--wall)':'var(--wall-shade)'),home?'var(--ink)':'var(--building-line)',.65);
            out+=polygon(roof,home?'var(--ink)':'var(--roof)',home?'var(--ink)':'var(--building-line)',home?1.15:.8);out+='</g>';
          }
        }
        // Secondary routes recede in the distance; the 62 retains a consistent weight.
        for(const route of data.routes.slice().sort((a,b)=>(a.n==='62'?1:0)-(b.n==='62'?1:0))){
          if((route.n==='31'||route.n==='32')&&l<1.4)continue;
          const primary=route.n==='62';
          const drawn=[];
          for(const part of route.parts){
            let run=[];
            const keep=()=>{if(run.length>1){const ps=run.map(projectGround),bb=bounds(ps);if(bb[2]>=0&&bb[0]<=width&&bb[3]>=0&&bb[1]<=height)drawn.push(ps);}run=[];};
            for(const p of part){
              if(p[0]>=extent[0]&&p[0]<=extent[2]&&p[1]>=extent[1]&&p[1]<=extent[3])run.push(p);
              else keep();
            }
            keep();
          }
          if(primary)for(const ps of drawn)out+=stroke(ps,'var(--paper)',l<1?5.2:4.4);
          for(const ps of drawn)out+=stroke(ps,primary?'var(--ink)':'var(--secondary-route)',primary?mix(2.9,2.3,l/3):(route.n==='44'?1.2:1),primary?{}:{'stroke-dasharray':route.n==='44'?'7 3':'2 4'});
        }
        out+='</g>';
        // A quiet edge keeps the map from becoming a hard rectangular slab.
        const edge=small?18:32;
        out+=el('rect',{x:0,y:0,width:edge,height,fill:'url(#lc-side)'});
        out+=el('rect',{x:0,y:0,width:edge,height,fill:'url(#lc-side)',transform:'translate('+width+' 0) scale(-1 1)'});
        out+=el('rect',{x:0,y:0,width,height:25,fill:'url(#lc-end)'});
        out+=el('rect',{x:0,y:0,width,height:32,fill:'url(#lc-end)',transform:'translate(0 '+height+') scale(1 -1)'});
        const occupied=[],labelBoxes={},petWidth=small?31:35,petHeight=small?29:33;
        function label(p,str,{quiet=false,large=false,priority=false,offsets}={}){
          const tw=labelWidth(str,quiet,large)+(str==='Home'?petWidth+10:0),th=str==='Home'?petHeight:large?20:16;
          const opts=offsets||[[10,-9],[10,20],[-tw-10,-9],[-tw-10,20]];
          for(const [dx,dy] of opts){
            const x=p[0]+dx,y=p[1]+dy,b=[x-3,y-th,x+tw+3,y+4];
            if(b[0]<5||b[2]>width-5||b[1]<4||b[3]>height-5)continue;
            if(occupied.some(a=>!(b[2]+5<a[0]||b[0]-5>a[2]||b[3]+5<a[1]||b[1]-5>a[3])))continue;
            occupied.push(b);labelBoxes[str]=b;out+=txt([x,y],str,'map-label'+(quiet?' quiet':'')+(large?' large':''));return true;
          }
          return false;
        }
        const home=project(data.home.p),stop=project(data.stop.p);
        const observed=stale?lastObservation:elapsed;
        const active=primaryObservation();
        const free=b=>b[0]>=7&&b[1]>=7&&b[2]<=width-7&&b[3]<=height-7&&!occupied.some(a=>!(b[2]+4<a[0]||b[0]-4>a[2]||b[3]+4<a[1]||b[1]-4>a[3]));
        function bus(p,number,{primary=false,tag=false,ahead=null,type={kind:'unknown'}}={}){
          const q=project(p),offscreen=false;
          if(!onMap(q,18)){if(primary)primaryOutside=true;return;}
          const scale=(primary?1:.8)*(l<.6?.78:l<1.6?.64:.5);
          if(type.kind!=='unknown'&&!offscreen&&(primary?l<1.3:l<.55)){
            const y=q[1]-13;
            out+=stroke([q,[q[0],y]],'var(--muted-ink)',.7)+circle(q,2.2,'var(--ink)','var(--paper)',.8);
            out+=el('g',{transform:'translate('+num(q[0])+' '+num(y)+') scale('+scale+')','data-bus-type':type.kind},busSilhouette(type.kind));
            const half=(type.kind==='articulated'?31:21)*scale;occupied.push([q[0]-half,y-9*scale,q[0]+half,y+10*scale]);
          }else out+=el('g',{'data-bus-type':type.kind,'data-marker-style':'compact'},el('rect',{x:num(q[0]-4.3),y:num(q[1]-3.4),width:8.6,height:6.8,rx:1.7,fill:primary&&!stale?'var(--ink)':'var(--paper)',stroke:primary?'var(--ink)':'var(--secondary-route)','stroke-width':1.5}));
          if(!tag)return;
          const opts=[[0,-40],[0,27],[-35,-12],[35,-12],[-35,25],[35,25],[36,-46],[-36,-46],[0,-52],[-58,-25],[58,-25],[-70,-12],[70,-12]];
          for(const [dx,dy] of opts){
            const bx=q[0]+dx,by=q[1]+dy,b=[bx-17,by-14,bx+17,by+14];
            if(!free(b))continue;
            occupied.push(b);
            const dark=primary&&!stale;
            out+=stroke([q,[bx,by]],primary?'var(--ink)':'var(--secondary-route)',.8);
            out+=el('rect',{x:num(bx-15),y:num(by-12),width:30,height:24,rx:4,fill:dark?'var(--ink)':'var(--paper)',stroke:primary?'var(--ink)':'var(--secondary-route)','stroke-width':1});
            out+=txt([bx,by],number,'bus-number','middle',{style:'fill:'+(dark?'var(--paper)':'var(--ink)')});
            if(offscreen)label([bx,by],'Outside view',{quiet:true,offsets:[[-32,-22],[-32,29],[23,4],[-87,4]]});
            return;
          }
        }
        if(l<.55){
          out+=circle(stop,7.5,'var(--paper)','var(--ink)',1.5)+circle(stop,2.7,'var(--ink)');
          out+=stroke([stop,[stop[0]-14,stop[1]-30]],'var(--ink)',.8);
          label([stop[0]-23,stop[1]-32],'YOUR STOP',{offsets:[[-63,-5],[-90,-18]]});
          out+=circle([home[0],home[1]+4],2,'var(--ink)');
        }else{
          if(l<1.3){out+=circle(stop,4,'var(--paper)','var(--ink)',1.4);}
          out+=circle(home,5.3,'var(--paper)','var(--ink)',1.5)+circle(home,2.1,'var(--ink)');
        }
        occupied.push([home[0]-8,home[1]-8,home[0]+8,home[1]+8]);
        if(l<1.3)occupied.push([stop[0]-10,stop[1]-10,stop[0]+10,stop[1]+10]);
        const homeCaptionX=clamp(home[0]-19,12,width-petWidth-10-labelWidth('Home',false,true)-8);
        const homeCaptionY=height-(small?38:18);
        label([homeCaptionX,homeCaptionY],'Home',{large:true,offsets:[[0,0]]});
        out+=stroke([[home[0],home[1]+8],[homeCaptionX+19,homeCaptionY-15]],'var(--muted-ink)',1);
        const primaryStart=out.length;
        if(active)bus(active.p,'62',{primary:true,tag:true,ahead:active.ahead,type:active.type});
        const primaryArtwork=out.slice(primaryStart);out=out.slice(0,primaryStart);
        if(!liveSnapshot){
        const secondary44x=28.74+Math.max(0,15-observed)*45;
        bus([secondary44x,22.5,elevation(secondary44x,22.5)],'44',{tag:l<.55,type:{kind:'standard'}});
        if(l>.7)for(const [i,p] of (data.demoBuses||[]).entries())bus(p,'62',{type:{kind:i%2?'standard':'articulated'}});
        if(observed>12)bus(routePoint(stopDistance+110*(observed-12)),'62');
        }else{
          const first=arrivalsFor(liveSnapshot,'62')[0],seen=new Set(first?.vehicleId?[first.vehicleId]:[]);
          const fresh=freshVehicles();
          const extras=[...fresh,...(stale?[]:liveSnapshot.arrivals||[]).filter(a=>!fresh.some(v=>v.tripId===a.tripId))];
          for(const a of extras){
            if(a===first||a.tripId===first?.tripId||a.arrivalTime<Date.now()||!a.location||Date.now()-a.location.updatedAt>120000||seen.has(a.vehicleId))continue;
            if(a.vehicleId)seen.add(a.vehicleId);
            bus(worldPoint(a.location.lon,a.location.lat,data.home.geo),a.route,{tag:l<.55||!first&&a.route==='62',type:a.type||vehicleType(a.vehicleId)});
          }
        }
        if(l>1.5){
          const lake=data.places.find(p=>p.name==='Lake Union').p;
          const drift=(Math.floor(observed/3)%5-2)*40;
          const offsets=[[0,950],[200,900],[-300,600],[-500,1100],[0,0],[200,-280],[-160,300],[300,300],[-230,-220],[80,430]];
          for(const [dx,dy] of offsets){
            const p=[lake[0]+dx+drift,lake[1]+dy+drift,7];if(!inLake(p))continue;
            const q=project(p),size=l>2.5?(small?18:22):(small?23:27),b=[q[0]-size/2,q[1]-size,q[0]+size/2,q[1]+2];
            if(!free(b))continue;
            occupied.push(b);out+=picture('boat',b[0],b[1],size,size+2);break;
          }
        }
        if(l<.55){
          if(!small){label(project([-100,34,elevation(-100,34)]),'N 45TH ST',{quiet:true});label(project([-162,112,elevation(-162,112)]),'STONE WAY',{quiet:true});}
        }else{
          const labelOrder=['Downtown','Fremont','Lake Union','South Lake Union','Wallingford','Queen Anne','Capitol Hill'];
          for(const p of data.places.slice().sort((a,b)=>labelOrder.indexOf(a.name)-labelOrder.indexOf(b.name))){
            if(l<p.min||l>p.max||small&&p.wideOnly)continue;
            const q=project(p.p);if(!onMap(q,14))continue;
            label(q,p.name,{quiet:p.quiet,large:p.large,offsets:p.offsets});
          }
        }
        if(l<.55){
          const q=project([-165,181,elevation(-165,181)]);
          label([clamp(q[0],72,width-72),22],'Fremont',{offsets:[[-24,0]]});
        }
        // Small discoveries are placed after transit labels, which get first claim on space.
        const homeLabel=labelBoxes.Home;
        if(homeLabel){
          out+=picture(dogPose,homeLabel[2]-petWidth-3,homeLabel[3]-petHeight,petWidth,petHeight);
        }
        if(l<.55){
          const perchStep=Math.floor(observed/2)%crowRoofs.length;
          for(let i=0;i<crowRoofs.length;i++){
            const roof=crowRoofs[(perchStep+i)%crowRoofs.length],q=project([...roof.center,roof.h],8);
            const size=small?17:19,b=[q[0]-size/2,q[1]-size+1,q[0]+size/2,q[1]+1];
            if(!free(b))continue;
            occupied.push(b);out+=picture(perchStep%2?'crowRight':'crowLeft',b[0],b[1],size,size);break;
          }
        }

        out+=primaryArtwork;
        scene.setAttribute('viewBox','0 0 '+width+' '+height);scene.setAttribute('height',height);scene.innerHTML=out;
        return {camera:c,dotAlpha,buildingAlpha};
      }
      function updateCaption(){
        root.querySelector('[data-view-name]').textContent=names[target]+(primaryOutside?' · bus outside view':'');
        const renderNote=root.querySelector('[data-render-note]'); if(renderNote)renderNote.textContent=target<2?'Illustrative building heights':'USGS elevation · relief 3×';
        const c=camera(target,width,height),desired=45/(.8660254*c.scale),units=[20,50,100,200,500,1000,2000];
        const meters=units.reduce((a,b)=>Math.abs(b-desired)<Math.abs(a-desired)?b:a);
        root.querySelector('[data-scale-rule]').style.width=(meters*.8660254*c.scale).toFixed(1)+'px';
        root.querySelector('[data-scale-label]').textContent='≈ '+(meters>=1000?(meters/1000)+' km':meters+' m');
        const focus=stale?'Last known positions':mode!=='auto'?'View held':currentEta()<=closeAt?'Close view held':'Adaptive view';
        const focusNode=root.querySelector('[data-focus]');focusNode.hidden=!liveSnapshot;focusNode.textContent=liveSnapshot?(primaryObservation()?'GPS '+displayTime(primaryObservation().updatedAt,{seconds:true}):freshVehicles().length?'GPS positions only':'Position unavailable'):'';
      }
      function finishTransition(){
        if(animationTimer){clearTimeout(animationTimer);animationTimer=null;}
        animations.forEach(a=>a.cancel());animations=[];
        if(settledHTML)scene.innerHTML=settledHTML;
      }
      function choose(next,animate=true){
        finishTransition();
        target=next;level=next;
        render(next);settledHTML=scene.innerHTML;updateCaption();
        // Deliberate, complete frames: the display has no animated zoom or crossfade.
      }
      function adaptiveLevel(){
        if(stale)return target;
        const eta=currentEta();
        const trip=liveSnapshot?arrivalsFor(liveSnapshot,'62')[0]?.tripId:(elapsed<=12?'demo-first':'demo-next');
        const desired=eta<=Math.max(closeAt,allowance+buffer)?0:eta<=5?1:eta<=8?2:3;
        // Hold a closer view while the same bus approaches, even if its ETA rises.
        if(trip!==autoTrip){autoTrip=trip;autoLevel=desired;}else autoLevel=Math.min(autoLevel,desired);
        return autoLevel;
      }
      function updateDeparture(){
        updateVehicleDetail();
        if(liveSnapshot){
          const a=arrivalsFor(liveSnapshot,'62'),first=a[0],eta=etaMinutes(first);
          stale=liveSnapshot.status!=='ok'||!liveSnapshot.fetchedAt||Date.now()-liveSnapshot.fetchedAt>120000;
          const put=(key,value)=>root.querySelector('[data-'+key+']').textContent=value;
          const range=gpsEstimateRange(first);
          root.querySelector('.countdown').setAttribute('data-estimated',String(!!range));
          put('eta',range?range.label:first?(eta===0?'Due':String(eta)):'—');put('eta-unit',range||first&&eta>0?'min':'');
          put('following',a[1]?'then '+(a[1].source==='gps_estimate'?arrivalLabel(a[1])+' · GPS estimate':etaMinutes(a[1])+' min'+(a[1].predicted?'':' · scheduled')):first?'No following arrival listed':'Arrival unavailable');
          let advice;
          if(liveSnapshot.status==='unconfigured'||stale)advice={headline:'Arrivals unavailable',context:liveSnapshot.source==='gps_estimate'?(liveSnapshot.estimator?.message||'Waiting for fresh GPS estimates'):freshVehicles().length?'Bus positions are still updating':'Waiting for a fresh prediction',state:'stale'};
          else if(!first&&liveSnapshot.source==='gps_estimate')advice={headline:liveSnapshot.estimator?.status==='warming_up'?'Learning bus movement':'No reliable GPS estimate',context:liveSnapshot.estimator?.message||'Waiting for enough fresh observations',state:'stale'};
          else if(!first)advice={headline:'No upcoming 62 listed',context:'Check service alerts before leaving',state:'stale'};
          else advice=departureAdvice(first,{walkMinutes:allowance,bufferMinutes:buffer,following:a[1]});
          const {headline,context,state}=advice;
          put('leave',headline);put('allowance-note',context);
          root.querySelector('[data-departure]').setAttribute('data-state',state);
          const stamp=liveSnapshot.fetchedAt||gpsSnapshot?.fetchedAt;
          put('feed',stamp?'Updated '+displayTime(stamp,{date:true}):'No recent update');
          put('source-note',range?'GPS estimate · experimental':first?.predicted?'LIVE · arrival prediction':first?'SCHEDULED · no live prediction':liveSnapshot.source==='gps_estimate'?'GPS estimates · experimental · waiting for reliable data':freshVehicles().length?'LIVE LOCATIONS · arrival times unavailable':'LIVE DATA UNAVAILABLE');
          for(const n of ['44','31','32']){
            const v=arrivalsFor(liveSnapshot,n)[0],r=gpsEstimateRange(v);
            put('eta'+n,r?r.label+(n==='44'?'':' GPS est.'):v?etaMinutes(v)+(v.predicted?'':' sched.'):'—');
            if(n==='44')root.querySelector('.secondary-unit').textContent=r?'min · GPS est.':'min';
          }
          root.querySelector('[data-extra-routes]').hidden=liveSnapshot.extraStatus!=='ok';
          put('announcement',(range?'GPS estimate '+range.label+' minutes. Experimental. ':'')+headline+'. '+context);return;
        }
        root.querySelector('[data-source-note]').textContent='DEMO · simulated arrivals & vehicles';
        root.querySelector('.countdown').setAttribute('data-estimated','false');
        root.querySelector('.secondary-unit').textContent='min';
        root.querySelector('[data-extra-routes]').hidden=true;
        const eta=currentEta(),next=elapsed<=12?25-elapsed:38-elapsed;
        root.querySelector('[data-eta]').textContent=stale?'—':eta===0?'Due':String(eta);
        root.querySelector('[data-eta-unit]').textContent=stale||eta===0?'':'min';
        root.querySelector('[data-following]').textContent=stale?'Arrival unavailable':'then '+next+' min';
        const now=Date.now(),first={arrivalTime:now+eta*60000,predicted:true},following={arrivalTime:now+next*60000,predicted:true};
        const {headline,context,state}=stale?{headline:'Arrivals unavailable',context:'Last observed positions shown',state:'stale'}:departureAdvice(first,{now,walkMinutes:allowance,bufferMinutes:buffer,following});
        root.querySelector('[data-leave]').textContent=headline;
        root.querySelector('[data-departure]').setAttribute('data-state',state);
        root.querySelector('[data-allowance-note]').textContent=context;
        const age=elapsed-lastObservation;
        root.querySelector('[data-feed]').textContent=stale?'Demo feed paused':'';
        root.querySelector('[data-eta44]').textContent=stale?'—':String(15-elapsed);
        root.querySelector('[data-eta31]').textContent=stale?'—':String(16-elapsed);
        root.querySelector('[data-eta32]').textContent=stale?'—':String(20-elapsed);
        stepButton.textContent=elapsed>=13?'Replay':'+1 min';
        root.querySelector('[data-announcement]').textContent=stale?'Feed unavailable. Last known bus positions.':names[target]+' view. Downtown 62 '+(eta===0?'due.':'in '+eta+' minutes. ')+headline+'.';
      }
      function refresh(animate=true){
        updateDeparture();
        choose(mode==='auto'?adaptiveLevel():Number(mode),animate);
      }
      function pause(){
        if(timer){clearInterval(timer);timer=null;}
        playButton.textContent=elapsed>=13?'Replay approach':'Play approach';
        playButton.setAttribute('aria-pressed','false');
      }
      function resetDemo(){
        elapsed=0;lastObservation=0;ambientStep=0;autoTrip=null;autoLevel=3;stale=false;staleToggle.checked=false;
        refresh();
      }
      function advance(){
        if(elapsed>=13){pause();return;}
        elapsed++;ambientStep++;
        if(!stale)lastObservation=elapsed;
        refresh();
        if(elapsed>=13)pause();
      }
      playButton.addEventListener('click',()=>{
        if(timer){pause();return;}
        if(elapsed>=13)resetDemo();
        playButton.textContent='Pause approach';playButton.setAttribute('aria-pressed','true');
        timer=setInterval(advance,5000);
      });
      stepButton.addEventListener('click',()=>{pause();if(elapsed>=13)resetDemo();else advance();});
      if(kindSelect)kindSelect.addEventListener('change',()=>{demoKind=kindSelect.value;refresh(false);});
      viewSelect.addEventListener('change',()=>{mode=viewSelect.value;refresh();});
      allowanceSelect.addEventListener('change',()=>{allowance=Number(allowanceSelect.value);updateDeparture();});
      closeSelect.addEventListener('change',()=>{closeAt=Number(closeSelect.value);refresh();});
      staleToggle.addEventListener('change',()=>{
        stale=staleToggle.checked;lastObservation=elapsed;
        refresh(false);
      });
      document.addEventListener('visibilitychange',()=>{if(document.hidden)pause();});
      new ResizeObserver(()=>{finishTransition();render(level);settledHTML=scene.innerHTML;updateCaption();}).observe(scene);
      refresh(false);
      return {
        setLive(snapshot){pause();liveSnapshot=snapshot;refresh(false);},
        setVehicles(snapshot){gpsSnapshot=snapshot;if(liveSnapshot)refresh(false);},
        setDemo(){liveSnapshot=null;gpsSnapshot=null;resetDemo();},
        render(){refresh(false);},
        cameraState(){return {tripId:autoTrip,level:autoLevel};},
        restoreCamera(state){if(mode==='auto'&&state?.tripId===autoTrip&&Number.isInteger(state.level)&&state.level>=0&&state.level<=3){autoLevel=Math.min(autoLevel,state.level);refresh(false);}}
      };

    }
