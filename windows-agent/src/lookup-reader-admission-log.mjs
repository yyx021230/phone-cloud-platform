// State-change diagnostics only; never writes account, phone or serial data.
export function createLookupReaderAdmissionLog({log, now=Date.now, intervalMs=60_000}) {
  let lastKey='', lastAt=-Infinity, wasBlocked=false;
  return input=>{
    const mode=['reported','legacy_unreported'].includes(input?.mode)?input.mode:'server_unreported';
    const reason=typeof input?.reason==='string'&&/^[a-z_]{1,100}$/.test(input.reason)?input.reason:'reader_capacity_unreported';
    const blocked=mode!=='reported'||!['lookup_reader_report_valid','lookup_reader_capacity_available','lookup_stop_cleanup','not_managed_lookup'].includes(reason);
    const key=mode+':'+reason,at=now();
    if ((!blocked&&!wasBlocked)||(key===lastKey)||at-lastAt<intervalMs) return;
    const number=value=>Number.isSafeInteger(value)&&value>=0&&value<=100000?value:null;
    log(blocked?'lookup reader admission waiting':'lookup reader admission recovered',{
      mode,reason,used:number(input?.used),limit:number(input?.limit)
    });
    lastKey=key;lastAt=at;wasBlocked=blocked;
  };
}
