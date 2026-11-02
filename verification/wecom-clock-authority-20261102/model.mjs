// OFFLINE interval model only. No clock adapters, OS calls, I/O or product import.
// Every accepted profile is explicitly a synthetic assumption, not attestation.
const SCALE=1_000_000n;
const MAX=2n**63n-1n;
const exact=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
const fail=code=>{throw Error(`offline_clock_${code}`);};
const count=(v,max=MAX)=>typeof v==='bigint'&&v>=0n&&v<=max;
const ceil=(a,b)=>(a+b-1n)/b;
const floor0=v=>v<0n?0n:v;
const ids=['hostId','bootId','processEpoch','timeDomain','sourceId'];
const sampleKeys=['sequence','domain','bootBeforeUs','bootAfterUs','workUs','wallBeforeUs','wallAfterUs'];
const APIs=Object.freeze({
  linux:{boot:'clock_gettime(CLOCK_BOOTTIME)',work:'clock_gettime(CLOCK_MONOTONIC)',wall:'clock_gettime(CLOCK_REALTIME)'},
  windows:{boot:'GetTickCount64',work:'QueryUnbiasedInterruptTimePrecise',wall:'GetSystemTimePreciseAsFileTime'}
});
const allowedBudgets=new Set([3_000_000n,20_000_000n,120_000_000n,230_000_000n,245_000_000n,300_000_000n]);

function elapsed(a,b,errorPpm){
  const lower=floor0(b.lo-a.hi),upper=b.hi-a.lo;
  if(upper<0n)fail('counter_regression');
  return Object.freeze({lowerUs:lower*SCALE/(SCALE+errorPpm),upperUs:ceil(upper*SCALE,SCALE-errorPpm)});
}

export class OfflineClockModel {
  #profile;#last=null;#failure='';#stamps=new WeakMap();
  constructor(profile){
    if(!exact(profile,['scope','os','apis','environment','bootErrorUs','workErrorUs','wallErrorUs','rateErrorPpm','maxSampleSpanUs','maxMonitorGapUs'])
      ||profile.scope!=='synthetic-offline-assumptions-only')fail('profile_unbounded');
    const api=APIs[profile.os];
    if(!api||!exact(profile.apis,['boot','work','wall'])||Object.keys(api).some(k=>profile.apis[k]!==api[k]))fail('source_not_selected');
    // Uncharacterized hypervisors can freeze all guest clocks together. No
    // continuity boolean or harmless-looking sample can establish real age.
    if(!['fixture-physical-os-semantics','fixture-pause-counting-hypervisor'].includes(profile.environment))fail('vm_pause_uncharacterized');
    for(const key of ['bootErrorUs','workErrorUs','wallErrorUs','maxSampleSpanUs','maxMonitorGapUs'])if(!count(profile[key],60_000_000n))fail('profile_unbounded');
    if(!count(profile.rateErrorPpm,10_000n)||!profile.maxSampleSpanUs||!profile.maxMonitorGapUs)fail('profile_unbounded');
    this.#profile=structuredClone(profile);
  }
  #live(){if(this.#failure)fail(this.#failure);}
  #delta(a,b,key){return elapsed(a[key],b[key],this.#profile.rateErrorPpm);}
  observe(sample){
    this.#live();
    try{
      if(!exact(sample,sampleKeys)||!Number.isSafeInteger(sample.sequence)||sample.sequence<1
        ||!exact(sample.domain,ids)||ids.some(k=>typeof sample.domain[k]!=='string'||!sample.domain[k]))fail('sample_invalid');
      for(const key of sampleKeys.filter(k=>k.endsWith('Us')))if(!count(sample[key]))fail('sample_invalid');
      if(sample.bootAfterUs<sample.bootBeforeUs||sample.wallAfterUs<sample.wallBeforeUs)fail('counter_regression');
      const p=this.#profile;
      const point={domain:{...sample.domain},sequence:sample.sequence,
        raw:{bootBeforeUs:sample.bootBeforeUs,bootAfterUs:sample.bootAfterUs,workUs:sample.workUs},
        boot:{lo:sample.bootBeforeUs-p.bootErrorUs,hi:sample.bootAfterUs+p.bootErrorUs},
        work:{lo:sample.workUs-p.workErrorUs,hi:sample.workUs+p.workErrorUs},
        wall:{lo:sample.wallBeforeUs-p.wallErrorUs,hi:sample.wallAfterUs+p.wallErrorUs}};
      if(point.boot.hi-point.boot.lo>p.maxSampleSpanUs||point.wall.hi-point.wall.lo>p.maxSampleSpanUs)fail('sample_span_unbounded');
      const old=this.#last;
      if(old){
        if(ids.some(k=>point.domain[k]!==old.domain[k]))fail('domain_changed');
        if(point.sequence!==old.sequence+1)fail('sample_sequence_changed');
        if(Object.keys(point.raw).some(k=>point.raw[k]<old.raw[k]))fail('counter_regression');
        const b=this.#delta(old,point,'boot'),w=this.#delta(old,point,'work'),r=this.#delta(old,point,'wall');
        // Linux monotonic / Windows unbiased working time exclude OS sleep.
        // A strictly positive interval gap is observed pause, not a true flag.
        if(b.lowerUs>w.upperUs)fail('os_pause_observed');
        if(w.lowerUs>b.upperUs)fail('paired_clocks_inconsistent');
        if(b.lowerUs>r.upperUs||r.lowerUs>b.upperUs)fail('local_wall_discontinuity');
        if(b.upperUs>p.maxMonitorGapUs)fail('monitor_gap_unknown');
      }
      this.#last=point;
      const stamp=Object.freeze({fixtureOnly:true,sequence:point.sequence});
      this.#stamps.set(stamp,point);return stamp;
    }catch(error){this.#failure=/^offline_clock_([a-z0-9_]+)$/.exec(error.message)?.[1]||'sample_invalid';throw error;}
  }
  age(anchor){
    this.#live();const point=this.#stamps.get(anchor);
    if(!point||!this.#last)fail('foreign_stamp');
    return this.#delta(point,this.#last,'boot');
  }
  proofWithinThreeSeconds(challenge){return this.age(challenge).upperUs<=3_000_000n;}
  remainingLowerBound(budgetUs,issued){
    if(!allowedBudgets.has(budgetUs))fail('budget_changed');
    return floor0(budgetUs-this.age(issued).upperUs);
  }
  receiveLeaseLowerBound(serverRemainingUs,requestSent){
    if(!count(serverRemainingUs,300_000_000n))fail('remaining_invalid');
    // Includes this machine's paired read uncertainty and rate error. The
    // entire RTT upper bound is SUBTRACTED; no cross-host timestamps.
    return floor0(serverRemainingUs-this.age(requestSent).upperUs);
  }
}

// Numerical assumptions for tests, NOT bounds measured on Linux or Windows.
export function syntheticProfile(os='linux',changes={}){
  return {scope:'synthetic-offline-assumptions-only',os,apis:{...APIs[os]},
    environment:'fixture-physical-os-semantics',
    bootErrorUs:os==='windows'?20_000n:100n,
    workErrorUs:os==='windows'?20_000n:100n,wallErrorUs:20_000n,
    rateErrorPpm:100n,maxSampleSpanUs:100_000n,maxMonitorGapUs:500_000n,...changes};
}
export const fixtureSample=({sequence=1,bootUs=1_000_000n,workUs=bootUs,wallUs=1_790_000_000_000_000n+bootUs,
  domain={hostId:'fixture-host',bootId:'fixture-boot',processEpoch:'fixture-epoch',timeDomain:'fixture-time-domain',sourceId:'fixture-paired-sources-v1'},spanUs=0n}={})=>({
  sequence,domain:{...domain},bootBeforeUs:bootUs,bootAfterUs:bootUs+spanUs,workUs,
  wallBeforeUs:wallUs,wallAfterUs:wallUs+spanUs});

// Separate IN-MEMORY + JSON restore model for non-rearm semantics, not a real
// persistence implementation. Raw clock observations, not poison flags, cause
// all outstanding tickets to become maintenance. There is no clear/rearm API.
export class OfflineTaskBudgets {
  #clock;#current=null;#tasks=new Map();
  constructor(profile,{restored=[]}={}){
    this.#clock=new OfflineClockModel(profile);
    for(const row of restored){
      if(!exact(row,['taskId','budgetUs','status'])||typeof row.taskId!=='string'
        ||!/^fixture-[a-z0-9-]{1,80}$/.test(row.taskId)||this.#tasks.has(row.taskId)
        ||typeof row.budgetUs!=='string'||!/^\d{1,12}$/.test(row.budgetUs)
        ||!allowedBudgets.has(BigInt(row.budgetUs)))fail('restore_invalid');
      // Even a caller reusing the old epoch string cannot restore an opaque
      // in-process stamp. An old task is NOT given a new elapsed-time origin.
      this.#tasks.set(row.taskId,{budgetUs:BigInt(row.budgetUs),anchor:null,status:'maintenance'});
    }
  }
  observe(sample){
    try{this.#current=this.#clock.observe(sample);return this.#current;}
    catch(error){for(const row of this.#tasks.values())row.status='maintenance';this.#current=null;throw error;}
  }
  issue(taskId,budgetUs){
    if(this.#tasks.has(taskId))fail('old_task_no_rearm');
    if(!/^fixture-[a-z0-9-]{1,80}$/.test(taskId)||!allowedBudgets.has(budgetUs)||!this.#current)fail('task_budget_unavailable');
    this.#clock.age(this.#current);
    this.#tasks.set(taskId,{budgetUs,anchor:this.#current,status:'active'});
  }
  permits(taskId){
    const row=this.#tasks.get(taskId);
    if(!row||row.status!=='active'||!row.anchor)return false;
    return this.#clock.remainingLowerBound(row.budgetUs,row.anchor)>0n;
  }
  statuses(){return [...this.#tasks].map(([taskId,row])=>({taskId,status:row.status}));}
  snapshot(){return [...this.#tasks].map(([taskId,row])=>({taskId,status:row.status,budgetUs:String(row.budgetUs)}));}
}
