import {vehicleType} from '../public/fleet.js';
export const vehicleFeedURL='https://s3.amazonaws.com/kcm-alerts-realtime-prod/vehiclepositions_enhanced.json';
// Route and direction IDs checked against Metro GTFS retrieved 2026-10-13.
// Revalidate when a future service change changes these identifiers.
const routes={100252:{route:'62',direction:1,headsign:'Downtown Seattle Fremont'},100224:{route:'44',direction:0,headsign:'Ballard Wallingford'},100184:{route:'31',direction:0,headsign:'Central Magnolia Fremont'},100193:{route:'32',direction:0,headsign:'Seattle Center Fremont'}};
const finite=x=>typeof x==='number'&&Number.isFinite(x);
export function normalizeVehicles(payload,{now=Date.now()}={}){
  const stamp=Number(payload.header?.timestamp)*1000;
  if(!Number.isFinite(stamp)||Math.abs(now-stamp)>120000||!Array.isArray(payload.entity))throw new Error('Vehicle feed missing or stale');
  const vehicles=new Map();
  for(const e of payload.entity){
    const v=e.vehicle,t=v?.trip,r=routes[t?.route_id],p=v?.position,id=String(v?.vehicle?.id??''),at=Number(v?.timestamp)*1000;
    if(e.is_deleted||!r||t.direction_id!==r.direction||['CANCELED','DELETED',3,7].includes(t.schedule_relationship)||!/^\d{4}$/.test(id))continue;
    if(!finite(at)||at<=0||now-at>120000||at>now+60000||!finite(p?.latitude)||!finite(p?.longitude)||p.latitude<47||p.latitude>48.5||p.longitude< -123.5||p.longitude> -121.5)continue;
    if(!t.trip_id||vehicles.get(id)?.location.updatedAt>=at)continue;
    vehicles.set(id,{
      route:r.route,tripId:'1_'+t.trip_id,rawTripId:String(t.trip_id),vehicleId:'1_'+id,fleetNumber:id,headsign:r.headsign,
      routeId:String(t.route_id),directionId:t.direction_id,
      serviceDate:/^\d{8}$/.test(t.start_date||'')?t.start_date:null,startTime:t.start_time||null,
      stopSequence:Number.isInteger(v.current_stop_sequence)&&v.current_stop_sequence>0?v.current_stop_sequence:null,
      stopId:v.stop_id==null?null:String(v.stop_id),currentStatus:v.current_status??null,
      scheduleRelationship:t.schedule_relationship??'SCHEDULED',
      speed:finite(p.speed)&&p.speed>=0?p.speed:null,bearing:finite(p.bearing)&&p.bearing>=0&&p.bearing<360?p.bearing:null,
      location:{lat:p.latitude,lon:p.longitude,updatedAt:at},type:vehicleType(id)
    });
  }
  return {vehicles:[...vehicles.values()],providerTime:stamp,source:'King County Metro',attribution:'Transit scheduling, geographic, and real-time data provided by permission of King County'};
}
