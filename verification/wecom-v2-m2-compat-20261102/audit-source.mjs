// Pure source slicing for the fixed M2 fixture. No evaluation/import of tests.
import {createHash} from "node:crypto";
const sha=v=>createHash("sha256").update(v).digest("hex");
export const addedSetup='\n  await db.query(await fs.readFile(path.join(project, "deploy/sql/wecom-cleanup-v2-claim.sql"), "utf8"));';
export function auditBodies(original,compat){
  if(compat.split(addedSetup).length!==2||compat.replace(addedSetup,"")!==original)throw Error("m2_copy_changed_beyond_setup");
  function calls(source){const found=[];const pattern=/\btest\s*\(/g;let m;
    while((m=pattern.exec(source))){let i=pattern.lastIndex,depth=1,quote=null,escaped=false,comment=null;
      for(;i<source.length&&depth;i++){const c=source[i],n=source[i+1];
        if(comment==="line"){if(c==="\n")comment=null;continue;}if(comment==="block"){if(c==="*"&&n==="/"){comment=null;i++;}continue;}
        if(quote){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c===quote)quote=null;continue;}
        if(c==="/"&&n==="/"){comment="line";i++;}else if(c==="/"&&n==="*"){comment="block";i++;}else if(["'",'"',"`"].includes(c))quote=c;else if(c==="(")depth++;else if(c===")")depth--;
      }if(depth||quote)throw Error("m2_test_call_unclosed");found.push(source.slice(m.index,i));pattern.lastIndex=i;
    }return found;
  }
  const a=calls(original),b=calls(compat);if(a.length!==11||b.length!==11||a.some((x,i)=>x!==b[i]))throw Error("m2_test_body_changed");
  const names=["basic","same-id-concurrency","different-id-concurrency","trigger-rollback","sql-constraints","row-lock-isolation","commit-after","commit-before","init-after"];
  const bodies=names.map((name,index)=>({name,testCallSha256:sha(a[index])}));
  for(const name of["op-epoch","op-malformed","init-epoch","init-malformed"])bodies.push({name,testCallSha256:sha(a[9])});bodies.push({name:"restart",testCallSha256:sha(a[10])});
  const start=original.indexOf("async function proxyCase("),end=original.indexOf('\ntest("actual PG: COMMIT success',start);if(start<0||end<0)throw Error("m2_shared_proxy_body_missing");
  return {originalSha256:sha(original),compatSha256:sha(compat),exactOriginalPlusOneSetupLine:true,uniqueTestDeclarations:11,expandedTestCases:14,bodies,sharedProxyCaseSha256:sha(original.slice(start,end))};
}
