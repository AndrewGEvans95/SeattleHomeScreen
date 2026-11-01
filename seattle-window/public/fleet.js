// A deliberately partial roster. Unknown fleet numbers stay unknown.
// King County Metro Route Facilities Guidelines, April 2018, Appendix B,
// printed AP-3–AP-5 (PDF pages 80–82), retrieved 2026-10-13.
export const fleetSource='https://cdn.kingcounty.gov/-/media/king-county/depts/metro/documents/about/data-and-reports/2018/trf_guidelines_final_2020.pdf';
const ranges=[
  [4300,4409,'standard',40,'New Flyer XT40'],
  [4500,4569,'articulated',60,'New Flyer XT60'],
  [7001,7199,'standard',40,'Orion VII hybrid'],
  [7200,7259,'standard',40,'New Flyer 40-foot hybrid'],
  [6800,6800,'articulated',60,'New Flyer DE60LF'],
  [6813,6999,'articulated',60,'New Flyer DE60LF'],
  [6200,6219,'articulated',60,'New Flyer XDE60'],
  [8000,8084,'articulated',60,'New Flyer XDE60']
];
export function vehicleType(id){
  const raw=String(id??'');
  const number=/^(?:1_)?\d{4}$/.test(raw)?Number(raw.replace(/^1_/,'')):NaN;
  const r=ranges.find(([a,b])=>number>=a&&number<=b);
  return r?{kind:r[2],label:r[2]==='articulated'?'Articulated':'Standard',nominalFeet:r[3],model:r[4],basis:'fleet-roster',sourceDate:'2018-04'}:{kind:'unknown',label:'Type unknown',nominalFeet:null,model:null,basis:'unverified'};
}

// Data marks, not heading arrows: side silhouettes deliberately face the same
// way. GPS feeds may omit bearing, so their placement conveys position only.
export function busSilhouette(kind,{ink='var(--ink)',paper='var(--paper)',muted='var(--muted-ink)'}={}){
  if(kind==='unknown')return '<circle cx="0" cy="0" r="4.6" fill="'+paper+'" stroke="'+ink+'" stroke-width="1.8"/>';
  const articulated=kind==='articulated',left=articulated?-30:-20,right=articulated?30:20;
  const box=(x,w)=>'<rect x="'+x+'" y="-8" width="'+w+'" height="15" rx="2.5" fill="'+paper+'" stroke="'+ink+'" stroke-width="1.6"/>';
  let s='<g stroke-linejoin="round">';
  if(articulated){s+=box(left,22)+box(-2,32)+'<rect x="-8" y="-7" width="6" height="13" fill="'+paper+'" stroke="'+muted+'" stroke-width=".8"/>';for(const x of [-7,-5,-3])s+='<path d="M'+x+' -6v11" stroke="'+ink+'" stroke-width=".9"/>';}
  else s+=box(left,right-left);
  for(let x=left+4;x<right-7;x+=7){if(articulated&&x>-14&&x<0)continue;s+='<rect x="'+x+'" y="-5" width="5" height="5" rx=".6" fill="'+ink+'"/>';}
  s+='<path d="M'+(right-5)+' -5v8m-2-8h4" fill="none" stroke="'+ink+'" stroke-width="1"/>';
  const wheels=articulated?[left+6,-13,right-7]:[left+6,right-7];
  for(const x of wheels)s+='<circle cx="'+x+'" cy="7" r="2.6" fill="'+ink+'"/>';
  return s+'</g>';
}
