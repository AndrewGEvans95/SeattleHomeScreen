import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const importer=fileURLToPath(new URL('../scripts/import-gtfs.py',import.meta.url));
const csv=rows=>{
  const columns=Object.keys(rows[0]);
  const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
  return [columns,...rows.map(row=>columns.map(column=>row[column]))].map(row=>row.map(cell).join(',')).join('\n')+'\n';
};
function fixture(){
  const trips=[
    {route_id:'100252',service_id:'weekday',trip_id:'sixty-two',trip_headsign:'Downtown Seattle',direction_id:'1',shape_id:'west'},
    {route_id:'100224',service_id:'weekday',trip_id:'forty-four',trip_headsign:'Ballard',direction_id:'0',shape_id:'west'},
    {route_id:'100252',service_id:'weekday',trip_id:'wrong-direction',trip_headsign:'Sand Point',direction_id:'0',shape_id:'west'},
    {route_id:'100252',service_id:'weekday',trip_id:'no-pickup',trip_headsign:'Downtown Seattle',direction_id:'1',shape_id:'west'}
  ];
  const stops=[
    {stop_id:'before',stop_name:'Before',stop_lat:'47.66',stop_lon:'-122.334'},
    {stop_id:'29530',stop_name:'Home, westbound',stop_lat:'47.66',stop_lon:'-122.340'},
    {stop_id:'after',stop_name:'After',stop_lat:'47.66',stop_lon:'-122.344'}
  ];
  return {
    'routes.txt':[{route_id:'100252',route_short_name:'62'},{route_id:'100224',route_short_name:'44'}],
    'trips.txt':trips,
    'stops.txt':stops,
    'shapes.txt':[
      {shape_id:'west',shape_pt_lat:'47.66',shape_pt_lon:'-122.334',shape_pt_sequence:'1',shape_dist_traveled:'0'},
      {shape_id:'west',shape_pt_lat:'47.66',shape_pt_lon:'-122.344',shape_pt_sequence:'2',shape_dist_traveled:'1'}
    ],
    'stop_times.txt':trips.flatMap(trip=>stops.map((stop,index)=>({trip_id:trip.trip_id,arrival_time:['23:59:00','24:02:00','24:05:00'][index],departure_time:['23:59:10','24:02:10','24:05:10'][index],stop_id:stop.stop_id,stop_sequence:String(index+1),pickup_type:trip.trip_id==='no-pickup'&&index===1?'1':'0',shape_dist_traveled:['0','0.6','1'][index]}))),
    'calendar.txt':[{service_id:'weekday',monday:'1',tuesday:'1',wednesday:'1',thursday:'1',friday:'1',saturday:'0',sunday:'0',start_date:'20261001',end_date:'20261231'}],
    'calendar_dates.txt':[{service_id:'weekday',date:'20261101',exception_type:'2'},{service_id:'weekday',date:'20261102',exception_type:'1'}],
    'feed_info.txt':[{feed_publisher_name:'Test feed',feed_publisher_url:'https://example.test',feed_lang:'en',feed_start_date:'20261101',feed_end_date:'20261201'}]
  };
}
async function run(t,tables=fixture(),{existing=false,args=[]}={}){
  const dir=await mkdtemp(path.join(tmpdir(),'seattle-gtfs-import-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const zip=path.join(dir,'feed.zip'),output=path.join(dir,'index.json');
  const archive=spawnSync('python3',['-c','import json,sys,zipfile; d=json.loads(sys.stdin.readline()); z=zipfile.ZipFile(d["path"],"w",zipfile.ZIP_DEFLATED); [z.writestr(k,v) for k,v in d["files"].items()]; z.close()'],{input:JSON.stringify({path:zip,files:Object.fromEntries(Object.entries(tables).map(([name,rows])=>[name,csv(rows)]))})+'\n',encoding:'utf8',timeout:10000});
  assert.equal(archive.status,0,archive.stderr);
  if(existing)await writeFile(output,'previous-good-index');
  const result=spawnSync('python3',[importer,zip,'--output',output,'--source-url','https://example.test/fixture.zip',...args],{encoding:'utf8',timeout:10000});
  return {...result,zip,output,async data(){return JSON.parse(await readFile(output,'utf8'));}};
}

test('GTFS import selects exact boarding trips and preserves overnight times, calendars and provenance',async t=>{
  const result=await run(t);
  assert.equal(result.status,0,result.stderr);
  const data=await result.data();
  assert.equal(data.schemaVersion,1);
  assert.deepEqual(Object.keys(data.trips).sort(),['forty-four','sixty-two']);
  const trip=data.trips['sixty-two'];
  assert.equal(trip.routeId,'100252');assert.equal(trip.directionId,1);
  assert.equal(trip.serviceId,'weekday');assert.equal(trip.shapeId,'west');
  assert.equal(trip.stops[1].arrival,24*3600+120);
  assert.equal(trip.stops[1].departure,24*3600+130);
  assert.equal(trip.stops[1].pickupAllowed,true);
  assert.deepEqual(trip.stops.map(stop=>stop.id),['before','29530','after']);
  assert.equal(data.stops['29530'].name,'Home, westbound');
  assert.deepEqual(data.calendar.weekday.weekdays,[1,1,1,1,1,0,0]);
  assert.deepEqual(data.exceptions.weekday,{'20261101':2,'20261102':1});
  assert.equal(data.source.feedStartDate,'20261101');assert.equal(data.source.feedEndDate,'20261201');
  assert.equal(data.source.url,'https://example.test/fixture.zip');
  assert(Number.isFinite(Date.parse(data.source.importedAt)));
  assert.equal(data.source.sha256,createHash('sha256').update(await readFile(result.zip)).digest('hex'));
});

test('GTFS import converts arbitrary shape-distance units to meters and can map a simple shape without distances',async t=>{
  for(const useDistances of [true,false]){
    const tables=fixture();
    if(!useDistances){
      for(const row of tables['shapes.txt'])row.shape_dist_traveled='';
      for(const row of tables['stop_times.txt'])row.shape_dist_traveled='';
    }
    const result=await run(t,tables);
    assert.equal(result.status,0,result.stderr);
    const data=await result.data(),length=data.shapes.west.at(-1)[2],home=data.trips['sixty-two'].stops[1].distance;
    assert(length>700&&length<800,'Coordinate distance should be about 749 meters, not the supplied unit length of 1');
    assert(Math.abs(home/length-.6)<.001);
    assert.equal(data.trips['sixty-two'].stops.at(-1).distance,length);
  }
});

test('GTFS import supports calendar_dates-only feeds and a configured boarding stop',async t=>{
  const tables=fixture();
  delete tables['calendar.txt'];delete tables['feed_info.txt'];
  const result=await run(t,tables,{args:['--stop-id','1_after']});
  assert.equal(result.status,0,result.stderr);
  const data=await result.data();
  assert.deepEqual(data.calendar,{});
  assert.equal(data.source.feedStartDate,'20261102');assert.equal(data.source.feedEndDate,'20261102');
  assert.equal(data.trips['no-pickup'].stops[1].pickupAllowed,false);
});

test('GTFS import refuses incomplete or contradictory selected trips without replacing an existing index',async t=>{
  const cases=[
    ['missing arrival',tables=>{tables['stop_times.txt'][0].arrival_time='';},/invalid arrival time/],
    ['nonfinite distance',tables=>{tables['shapes.txt'][1].shape_dist_traveled='NaN';},/Nonfinite/],
    ['duplicate sequence',tables=>{tables['stop_times.txt'][1].stop_sequence='1';},/duplicate stop sequences/],
    ['backward times',tables=>{tables['stop_times.txt'][1].arrival_time='23:00:00';},/times run backward/],
    ['off-shape stop',tables=>{tables['stops.txt'][1].stop_lat='47.8';},/off its declared shape/],
    ['backward distance',tables=>{tables['stop_times.txt'][0].shape_dist_traveled='.6';tables['stops.txt'][0].stop_lon='-122.340';tables['stop_times.txt'][1].shape_dist_traveled='0';tables['stops.txt'][1].stop_lon='-122.334';},/distances run backward/],
    ['missing service',tables=>{delete tables['calendar.txt'];delete tables['calendar_dates.txt'];},/no calendar/],
    ['invalid calendar',tables=>{tables['calendar.txt'][0].end_date='20260230';},/Invalid service end date/],
    ['no boarding target',tables=>{for(const row of tables['stop_times.txt'])if(row.stop_id==='29530')row.pickup_type='2';},/No boarding trips/]
  ];
  for(const [label,change,pattern] of cases){
    await t.test(label,async sub=>{
      const tables=fixture();change(tables);
      const result=await run(sub,tables,{existing:true});
      assert.equal(result.status,1,result.stdout+result.stderr);
      assert.match(result.stderr,pattern);
      assert.equal(await readFile(result.output,'utf8'),'previous-good-index');
    });
  }
});

test('GTFS import rejects ambiguous loops when stop shape distances are absent',async t=>{
  const tables=fixture();
  for(const row of tables['shapes.txt'])row.shape_dist_traveled='';
  tables['shapes.txt'].push({...tables['shapes.txt'][0],shape_pt_sequence:'3'});
  for(const row of tables['stop_times.txt'])row.shape_dist_traveled='';
  const result=await run(t,tables);
  assert.equal(result.status,1);
  assert.match(result.stderr,/ambiguous shape placement/);
});
