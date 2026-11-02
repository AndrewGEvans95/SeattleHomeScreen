export function etaMinutes(a,now=Date.now()) {return a?Math.max(0,Math.ceil((a.arrivalTime-now)/60000)):Infinity;}
// A new fetch must not extend the life of an estimate made from old GPS.
export function gpsEstimateRange(a,now=Date.now()){
  if(a?.source!=='gps_estimate')return null;
  const {arrivalTime,earliestArrivalTime,latestArrivalTime,updatedAt,validUntil}=a;
  if(![arrivalTime,earliestArrivalTime,latestArrivalTime,updatedAt,validUntil].every(Number.isFinite)||updatedAt<=0||updatedAt>now+5000||now>=Math.min(validUntil,updatedAt+90000)||earliestArrivalTime<updatedAt||earliestArrivalTime>arrivalTime||arrivalTime>latestArrivalTime||latestArrivalTime<=now)return null;
  const earliest=Math.max(0,Math.floor((earliestArrivalTime-now)/60000));
  const latest=Math.max(0,Math.ceil((latestArrivalTime-now)/60000));
  return {earliest,latest,label:earliest+'–'+latest};
}
export function arrivalLabel(a,now=Date.now()){
  if(a?.source==='gps_estimate'){const range=gpsEstimateRange(a,now);return range?range.label+' min':'unavailable';}
  const eta=etaMinutes(a,now);return Number.isFinite(eta)?eta===0?'due now':eta+' min':'unavailable';
}
export function arrivalsFor(snapshot,route,now=Date.now()){
  if(snapshot?.status!=='ok'||!snapshot.fetchedAt||now-snapshot.fetchedAt>120000)return [];
  return (snapshot.arrivals||[]).filter(a=>a.route===route&&(a.source==='gps_estimate'?gpsEstimateRange(a,now)!==null:a.arrivalTime>=now-30000)).sort((a,b)=>a.arrivalTime-b.arrivalTime);
}
export function weatherAt(snapshot,index,at,now=Date.now()){
  if(snapshot?.status!=='ok'||!snapshot.fetchedAt||now-snapshot.fetchedAt>20*60000)return {rain:null,temp:null,gust:null};
  // Open-Meteo precipitation is the accumulation in the PRECEDING interval.
  const sample=snapshot.points?.[index]?.samples.find(s=>at>s.end-900000&&at<=s.end);
  if(!sample||[sample.rain,sample.temp,sample.gust].some(v=>v===null||!Number.isFinite(v)))return {rain:null,temp:null,gust:null};
  return sample;
}
export function worldPoint(lon,lat,home){
  const rad=Math.PI/180,scale=6378137*Math.cos(home[1]*rad);
  return [scale*(lon-home[0])*rad,scale*(Math.log(Math.tan(Math.PI/4+home[1]*rad/2))-Math.log(Math.tan(Math.PI/4+lat*rad/2)))];
}
export function ageLabel(timestamp){return timestamp?'Updated '+Math.max(0,Math.floor((Date.now()-timestamp)/60000))+' min ago':'No update';}

// Never derive leave-by guidance from the rounded arrival displayed on screen.
export function departureAdvice(arrival,{now=Date.now(),walkMinutes=2,bufferMinutes=1,following=null}={}){
  const context=walkMinutes+' min to the stop · '+bufferMinutes+' min buffer';
  if(!arrival||!Number.isFinite(arrival.arrivalTime))return {headline:'Arrivals unavailable',context:'Check the next departure',state:'stale'};
  if(arrival.source==='gps_estimate'){
    if(!gpsEstimateRange(arrival,now))return {headline:'GPS estimate unavailable',context:'Waiting for a fresh observation',state:'stale'};
    const remaining=arrival.earliestArrivalTime-now;
    if(remaining<=walkMinutes*60000)return {headline:'Too close to count on',context:'GPS range includes arrival before you could reach the stop',state:'tight'};
    const leaveIn=Math.floor((remaining-(walkMinutes+bufferMinutes)*60000)/60000);
    return {headline:leaveIn<=0?'Aim to leave now':'Aim to leave in '+leaveIn+' min',context:context+' · early end of GPS range',state:'estimate'};
  }
  const eta=etaMinutes(arrival,now),remaining=arrival.arrivalTime-now;
  if(!arrival.predicted)return {headline:'Scheduled in '+eta+' min',context:'No live arrival prediction',state:'scheduled'};
  if(remaining<=walkMinutes*60000)return {headline:remaining<=0?'Due now':'Too close to count on',context:following?(following.source==='gps_estimate'?'Next 62 estimate '+arrivalLabel(following,now):'Next 62 in '+etaMinutes(following,now)+' min'+(following.predicted?'':' · scheduled')):'Bus may arrive before you reach the stop',state:'tight'};
  const leaveIn=Math.floor((remaining-(walkMinutes+bufferMinutes)*60000)/60000);
  return {headline:leaveIn<=0?'Leave now':'Leave in '+leaveIn+' min',context,state:leaveIn<=0?'go':'wait'};
}

export function observationAge(timestamp,now=Date.now()){
  if(!timestamp||timestamp>now+60000)return 'unavailable';
  const seconds=Math.max(0,Math.floor((now-timestamp)/1000));
  return seconds<60?seconds+'s ago':Math.floor(seconds/60)+'m '+seconds%60+'s ago';
}

export function displayTime(timestamp,{seconds=false,date=false}={}){
  if(!timestamp||!Number.isFinite(timestamp))return 'unavailable';
  return new Intl.DateTimeFormat('en-US',{timeZone:'America/Los_Angeles',...(date?{month:'short',day:'numeric'}:{}),hour:'numeric',minute:'2-digit',...(seconds?{second:'2-digit'}:{})}).format(timestamp);
}
