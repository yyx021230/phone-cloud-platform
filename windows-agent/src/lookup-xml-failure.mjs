// XML executor failures must not replace the real exit with its first JSON
// progress event. Keep normal final-result semantics and bounded diagnostics.
export function lookupXmlFailure(error, parseFinal) {
  const output=String(error?.stdout||'');
  const lines=output.split(/\r?\n/).filter(Boolean);
  let hasFinal=false;
  const progress=[];
  for(const line of lines){
    let row;try{row=JSON.parse(line);}catch{continue;}
    if(row?.result || typeof row?.ok==='boolean')hasFinal=true;
    const event=row?.event;
    if(event && /^[a-z][a-z0-9_]{0,99}$/.test(String(event.step||'')) && !/\d{7,}/.test(event.step)){
      progress.push({step:event.step,...(Number.isFinite(event.elapsedMs)&&event.elapsedMs>=0?{elapsedMs:event.elapsedMs}:{})});
      if(progress.length>16)progress.shift();
    }
  }
  if(hasFinal)return parseFinal(output);
  const kind=error?.killed===true?'terminated':Number.isInteger(error?.code)?'nonzero_exit':'no_final_result';
  return {ok:false,error:`lookup_xml_runner_${kind}`,log:[],executionExit:{kind,
    ...(Number.isInteger(error?.code)?{exitCode:error.code}:{}),
    ...(['SIGTERM','SIGKILL','SIGABRT'].includes(error?.signal)?{signal:error.signal}:{}),
    progress, lastStep:progress.at(-1)?.step||null}};
}
