// Pure inventory of this fixed fixture's actual constructor call expressions.
// Never imports/evaluates the integration entry, SQL, runner or PG module.
import { fixture } from "../wecom-v2-claim-bundle-20261102/fixture.mjs";
function calls(source) {
  const result=[],pattern=/\b(made|fixture)\s*\(/g;let match;
  while((match=pattern.exec(source))){
    let depth=1,quote=null,escaped=false,i=pattern.lastIndex;
    for(;i<source.length&&depth;i++){
      const c=source[i];if(quote){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c===quote)quote=null;}
      else if(["'",'"',"`"].includes(c))quote=c;else if(c==="(")depth++;else if(c===")")depth--;
    }
    if(depth||quote)throw Error("fixture_constructor_unclosed");
    result.push(source.slice(match.index,i).replace(/\s+/g,""));pattern.lastIndex=i;
  }return result;
}
function domains(source) {
  return [...source.matchAll(/for\s*\(\s*const\s+(\w+)\s+of\s+(\[[^\]]*\])/g)].map(m=>({key:m[1],values:JSON.parse(m[2])}));
}
export function collectSyntheticSeeds(source) {
  if(typeof source!=="string")throw Error("fixture_source_required");
  const loops=domains(source),domain=first=>{
    const found=loops.filter(d=>d.values[0]===first);if(found.length!==1)throw Error("fixture_domain_unconfirmed");return found[0].values;
  };
  const out=[],add=(suffix,options={})=>{out.push({...fixture({suffix,serial:`fixture-${suffix}`,...options}),extra:options.extra===true});};
  const seen=calls(source);let helpers=0;
  for(const expression of seen){
    const literal=/^made\(("[^"\\]+")\)$/.exec(expression);
    if(literal){add(JSON.parse(literal[1]));continue;}
    switch(expression){
      case 'fixture({suffix,serial:`fixture-${suffix}`})':helpers++;break;
      case 'fixture({suffix:`basic-${slot}`,serial:`fixture-basic-${slot}`,slot})':for(const slot of domain("main"))add(`basic-${slot}`,{slot});break;
      case 'fixture({suffix:"physical-two",serial:f.context.binding.serial,slot:"clone"})':add("physical-two",{serial:"fixture-physical-one",slot:"clone",extra:true});break;
      case 'fixture({suffix:"case-alias",serial:"Fixture-case"})':add("case-alias",{serial:"Fixture-case"});break;
      case 'made(`write-${i}`)':if(!source.includes('for(let i=1;i<=5;i++)'))throw Error("fixture_numeric_domain_changed");for(let i=1;i<=5;i++)add(`write-${i}`);break;
      case 'made(`sql-write-${i+1}`)':if(!source.includes('for(let i=0;i<5;i++)'))throw Error("fixture_numeric_domain_changed");for(let i=0;i<5;i++)add(`sql-write-${i+1}`);break;
      case 'made(name)':
        if(!source.includes('const name=mutate?"client-context":mode==="after_commit"?"commit-after":"commit-before"'))throw Error("fixture_fault_domain_changed");
        for(const name of ["commit-after","commit-before","client-context"])add(name);break;
      case 'made(`regress-${kind}`)':for(const kind of domain("queued"))add(`regress-${kind}`);break;
      case 'made(table.endsWith("jobs")?"job-first":"task-first")':for(const table of domain("phone_cloud_windows_tasks"))add(table.endsWith("jobs")?"job-first":"task-first");break;
      case 'made(`${f.context.originalJobId}-other`)':for(const table of domain("phone_cloud_windows_tasks")){const f=fixture({suffix:table.endsWith("jobs")?"job-first":"task-first"});add(`${f.context.originalJobId}-other`);}break;
      case 'made(`reconcile-missing-${kind}`)':for(const kind of domain("anchor"))add(`reconcile-missing-${kind}`);break;
      // Accepted solely so the regression test can analyze the exact old form
      // and prove its real collision against the prior mapping-missing group.
      case 'made(`missing-${kind}`)':for(const kind of domain("anchor"))add(`missing-${kind}`);break;
      default:throw Error(`fixture_constructor_not_in_fixed_inventory:${expression}`);
    }
  }
  if(helpers!==1)throw Error("fixture_made_helper_changed");
  return {constructorCalls:seen.length,records:out};
}
export function assertUniqueSeedNames(records) {
  const sets=new Map();
  function put(kind,value){let set=sets.get(kind);if(!set){set=new Set();sets.set(kind,set);}if(set.has(value))throw Error(`duplicate_${kind}:${value}`);set.add(value);}
  for(const f of records){
    if(!f.extra){put("device",f.input.device.deviceId.toLowerCase());put("physical",f.context.binding.serial.toLowerCase());}
    for(const [kind,value] of Object.entries({task:f.input.task.taskId,job:f.input.job.jobId,business:f.context.originalLockId,
      obligation:f.context.binding.obligationId,execution:f.context.binding.executionId,claim:f.context.claimOperationId}))put(kind,value);
  }return Object.fromEntries([...sets].map(([key,value])=>[key,value.size]));
}
