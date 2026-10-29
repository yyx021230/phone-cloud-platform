// Authenticated task status alone does not prove that its phone reader stopped.
export function confirmedLookupStop(task, status, result, session) {
  const p=result?.diagnostic?.lookupStopProof;
  return status==='succeeded' && task?.type==='alipay_name_stop'
    && p?.version===1 && p.readerCleanupConfirmed===true
    && typeof task.taskId==='string' && p.taskId===task.taskId
    && typeof session?.sessionId==='string' && p.sessionId===session.sessionId
    && task.payload?.automationSessionId===session.sessionId
    && task.deviceId===session.deviceId
    && p.generation===String(session.managedLookupGeneration||'')
    && String(task.payload?.managedLookup?.generation||'')===p.generation;
}
export function hasConfirmedLookupStop(session, channel) {
  const p=session?.lookupStopConfirmation;
  return p?.version===1 && p.readerCleanupConfirmed===true && typeof p.taskId==='string'
    && p.taskId.length>0 && p.sessionId===session.sessionId && p.sessionId===channel.sessionId
    && p.generation===channel.generation && p.generation===session.managedLookupGeneration;
}
