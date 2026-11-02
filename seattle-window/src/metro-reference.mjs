// This optional adapter is for comparison only. Published TripUpdates are a
// second prediction, never a measured arrival or an input to our GPS estimator.
export const metroReferenceURL='https://s3.amazonaws.com/kcm-alerts-realtime-prod/tripupdates_enhanced.json';
const MAX_AGE=120_000,MAX_HORIZON=90*60_000;
const routes={'100252':{route:'62',direction:1},'100224':{route:'44',direction:0}};
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const rawStop=value=>String(value||'').replace(/^1_/,'');
const fresh=(at,now)=>finite(at)&&at>0&&at<=now&&now-at<=MAX_AGE;
function epoch(value){
  if(typeof value!=='number'&&!(typeof value==='string'&&/^\d+$/.test(value)))return NaN;
  const at=Number(value)*1000;
  return Number.isSafeInteger(at)&&at>0?at:NaN;
}
function serviceDateValid(value){
  if(typeof value!=='string'||!/^\d{8}$/.test(value))return false;
  const date=new Date(Date.UTC(+value.slice(0,4),+value.slice(4,6)-1,+value.slice(6,8)));
  return date.toISOString().slice(0,10).replaceAll('-','')===value;
}
const identity=a=>[a.tripId,a.serviceDate,a.vehicleId,a.stopId].join('|');
function uniqueLatest(records){
  const result=new Map();
  for(const record of records){
    const key=identity(record),prior=result.get(key);
    if(!prior||record.updatedAt>prior.updatedAt)result.set(key,record);
    // Equal timestamps with contradictory predictions are ambiguous.
    else if(record.updatedAt===prior.updatedAt&&record.arrivalTime!==prior.arrivalTime)result.set(key,{...prior,arrivalTime:null});
  }
  return [...result.values()].filter(record=>finite(record.arrivalTime));
}

export function normalizeMetroReference(payload,{now=Date.now(),stopId='1_29530'}={}){
  const providerTime=epoch(payload?.header?.timestamp),targetStop=rawStop(stopId);
  if(!fresh(providerTime,now)||!Array.isArray(payload?.entity)||!targetStop)throw new Error('Metro reference feed is missing or stale.');
  const arrivals=[];
  for(const entity of payload.entity){
    const update=entity?.trip_update,trip=update?.trip,routeId=String(trip?.route_id??''),route=Object.hasOwn(routes,routeId)?routes[routeId]:null;
    if(entity?.is_deleted||!route||trip.direction_id!==route.direction||['CANCELED','DELETED',3,7].includes(trip.schedule_relationship))continue;
    const updatedAt=epoch(update.timestamp),rawTripId=String(trip.trip_id??''),vehicle=String(update.vehicle?.id??''),serviceDate=trip.start_date;
    // Future scheduled updates commonly have no timestamp/vehicle. The feed
    // header cannot supply the missing evidence that this trip is active.
    if(!fresh(updatedAt,now)||!rawTripId||!/^\d{4}$/.test(vehicle)||!serviceDateValid(serviceDate)||!Array.isArray(update.stop_time_update))continue;
    const stops=update.stop_time_update.filter(stop=>String(stop?.stop_id??'')===targetStop);
    // A repeated visit needs a stop-sequence choice we do not make here.
    if(stops.length!==1)continue;
    const stop=stops[0];
    if(['SKIPPED','NO_DATA',1,2].includes(stop.schedule_relationship))continue;
    const arrivalTime=epoch(stop.arrival?.time);
    if(!finite(arrivalTime)||arrivalTime<=now||arrivalTime>now+MAX_HORIZON)continue;
    arrivals.push({route:route.route,routeId,directionId:route.direction,rawTripId,tripId:'1_'+rawTripId,serviceDate,vehicleId:'1_'+vehicle,stopId:'1_'+targetStop,arrivalTime,updatedAt});
  }
  return {source:'Metro TripUpdates reference',providerTime,arrivals:uniqueLatest(arrivals).sort((a,b)=>a.arrivalTime-b.arrivalTime)};
}

function validIdentity(arrival){
  return typeof arrival?.tripId==='string'&&/^1_.+/.test(arrival.tripId)&&typeof arrival.vehicleId==='string'&&/^1_\d{4}$/.test(arrival.vehicleId)&&serviceDateValid(arrival.serviceDate)&&typeof arrival.stopId==='string'&&/^1_.+/.test(arrival.stopId);
}

export function compareGpsToReference(gps,reference,{now=Date.now()}={}){
  const usable=arrival=>validIdentity(arrival)&&fresh(arrival.updatedAt,now)&&finite(arrival.arrivalTime)&&arrival.arrivalTime>now&&arrival.arrivalTime<=now+MAX_HORIZON;
  const own=gps?.status==='ok'&&fresh(gps.fetchedAt,now)&&Array.isArray(gps.arrivals)?uniqueLatest(gps.arrivals.filter(a=>a?.source==='gps_estimate'&&usable(a)&&finite(a.validUntil)&&a.validUntil>now)):[];
  const referenceReady=fresh(reference?.providerTime,now)&&Array.isArray(reference.arrivals);
  const published=referenceReady?uniqueLatest(reference.arrivals.filter(usable)):[];
  const report={
    status:!referenceReady?'reference_unavailable':!own.length?'warming_up':'no_matches',
    label:'Reference disagreement with Metro TripUpdates; not measured arrival accuracy.',
    ownEstimates:own.length,referenceArrivals:published.length,matched:0,unmatchedOwnEstimates:own.length,unmatchedReferenceArrivals:published.length,
    within60Seconds:0,between60And120Seconds:0,over120Seconds:0,earlierThanReference:0,laterThanReference:0,sameAsReference:0
  };
  if(!referenceReady||!own.length)return report;
  const byIdentity=new Map(published.map(a=>[identity(a),a]));
  for(const arrival of own){
    const match=byIdentity.get(identity(arrival));
    if(!match)continue;
    const difference=(arrival.arrivalTime-match.arrivalTime)/1000,absolute=Math.abs(difference);
    report.matched++;
    report[absolute<=60?'within60Seconds':absolute<=120?'between60And120Seconds':'over120Seconds']++;
    report[difference<0?'earlierThanReference':difference>0?'laterThanReference':'sameAsReference']++;
  }
  report.unmatchedOwnEstimates-=report.matched;report.unmatchedReferenceArrivals-=report.matched;
  if(report.matched)report.status='compared';
  return report;
}
