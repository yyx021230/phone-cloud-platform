const LIMIT_REASONS = new Set(["access_denied", "device_risk", "frequent_or_abnormal_access"]);
const COOLING_MS = 8 * 60 * 60 * 1000;

function failure(code, message, diagnostic = {}) {
  return Object.assign(new Error(message), { code, diagnostic: { code, ...diagnostic } });
}

function verifiedAccount(result) {
  const saved = result?.savedAccounts;
  if (result?.accountIdentityVerified !== true || !Array.isArray(saved) || !saved.length || saved.length > 12
      || saved.some((row) => !row?.account) || new Set(saved.map((row) => row.account)).size !== saved.length
      || saved.filter((row) => row.current).length !== 1
      || !saved.some((row) => row.current && row.account === result.currentAccount)) {
    throw failure("alipay_account_identity_unverified", "账户身份未确认，未执行查询。");
  }
  return result;
}

// Orchestrate only this task/serial. Persistence ACK precedes any rotation;
// the original task/result/number remain unchanged throughout all attempts.
export async function runLookupWithAccountPolicy({ task, execute, recordLimit, now = Date.now, assertAllowed = () => {} }) {
  if (task.payload?.accountCooldownProtocol !== 1 || task.type === "alipay_name_stop") return execute(task);
  let policy = { ...task.payload, accountCooldowns: [...(task.payload.accountCooldowns || [])] };
  let savedAccounts = task.payload.savedAccounts || [];
  // Positive probe proof is scoped to the exact verified account. A different
  // account or a human recovery must execute the private probe before the
  // original business number. This is internal work, never a client result.
  const readiness=task.payload.preparedLookup;
  let probedAccount=readiness?.verifiedAccount||'';
  const history = [];
  const visited = new Set();
  const decorate = (result) => ({ ...result, currentAccount: policy.knownAccount,
    accountIdentityVerified: true, savedAccounts,
    accountSwitched: Boolean(result.accountSwitched || history.length),
    accountSwitchHistory: [...history, ...(result.accountSwitchHistory || [])],
    accountSwitchCount: history.length + Number(result.accountSwitchCount || 0) });
  const preserveQueryFailure = (error) => {
    const diagnostic = error?.diagnostic || {};
    // A page/transport failure does not undo the last verified account change.
    // Explicitly unknown or contradictory identity must never be promoted.
    if (!error || typeof error !== "object"
        || (diagnostic.code || error.code) === "alipay_account_identity_unverified"
        || diagnostic.accountIdentityVerified !== undefined && diagnostic.accountIdentityVerified !== true
        || diagnostic.currentAccount && diagnostic.currentAccount !== policy.knownAccount) return error;
    try {
      verifiedAccount({ currentAccount: policy.knownAccount,
        accountIdentityVerified: policy.accountIdentityVerified, savedAccounts });
      if (diagnostic.savedAccounts !== undefined) verifiedAccount({ ...diagnostic,
        currentAccount: diagnostic.currentAccount || policy.knownAccount, accountIdentityVerified: true });
    } catch { return error; }
    error.diagnostic = decorate(diagnostic);
    return error;
  };
  const saveRestriction = async (error, preparing = false) => {
    const diagnostic = error?.diagnostic || {};
    const reason = diagnostic.limitReason;
    if (!(diagnostic.limitReached === true || diagnostic.accountRestrictionDetected === true)
        || !LIMIT_REASONS.has(reason) || typeof diagnostic.phoneQueryStarted !== "boolean") throw error;
    // Preparation may have selected an account. Only its actual picker proof
    // can identify a failed preparation; the preceding account is not evidence.
    if (preparing) {
      verifiedAccount(diagnostic);
      if (Array.isArray(diagnostic.accountSwitchHistory)) history.push(...diagnostic.accountSwitchHistory);
      savedAccounts = diagnostic.savedAccounts;
      policy = { ...policy, knownAccount: diagnostic.currentAccount, accountIdentityVerified: true, savedAccounts };
    } else {
      verifiedAccount({ currentAccount: policy.knownAccount,
        accountIdentityVerified: policy.accountIdentityVerified, savedAccounts });
      if (diagnostic.accountIdentityVerified === false
          || diagnostic.currentAccount && diagnostic.currentAccount !== policy.knownAccount) {
        throw failure("alipay_account_identity_unverified", "限制账户与已确认账户不一致，已停止查询。");
      }
    }
    const account = policy.knownAccount;
    if (visited.has(account)) throw failure("alipay_account_identity_unverified", "限制账户重复出现，已停止查询。");
    visited.add(account);
    assertAllowed();
    const ack = await recordLimit({ account, reason, phoneQueryStarted: diagnostic.phoneQueryStarted,
      accountIdentityVerified: true });
    const row = ack?.accountCooldown;
    if (!row || row.account !== account || !Number.isFinite(Date.parse(row.limitedAt))
        || Date.parse(row.cooldownUntil) - Date.parse(row.limitedAt) !== COOLING_MS
        || Date.parse(row.cooldownUntil) <= now()) {
      throw failure("alipay_cooldown_persist_unconfirmed", "冷却记录保存未确认，已停止切号及查询。");
    }
    policy.accountCooldowns = [...policy.accountCooldowns.filter((item) => item.account !== account), row];
  };
  const prepare = async () => {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      assertAllowed();
      const fromAccount = policy.knownAccount;
      let prepared;
      try { prepared = verifiedAccount(await execute({ ...task, type: "alipay_name_start", payload: policy })); }
      catch (error) { await saveRestriction(error, true); continue; }
      savedAccounts = prepared.savedAccounts;
      policy = { ...policy, knownAccount: prepared.currentAccount, accountIdentityVerified: true,
        verifyAccountBeforeQuery: false, savedAccounts };
      if (fromAccount && fromAccount !== prepared.currentAccount) {
        // A different account has no old result page to resume. Re-enter the
        // original number as a query while retaining its task/result identity.
        policy.resumeAfterHumanVerification = false;
        policy.restartAfterHumanVerification = false;
      }
      if (prepared.accountSwitched) history.push({ fromAccount, toAccount: prepared.currentAccount, reason: "cooldown" });
      return prepared;
    }
    throw failure("alipay_account_rotation_bound_reached", "账户检查次数已达安全上限，请检查账户列表。");
  };
  if (task.payload.postHumanCheck === true && ['alipay_name_start','alipay_name_query'].includes(task.type)) {
    assertAllowed();
    try {
      const checked = await execute({...task,payload:{...policy,postHumanCheckOnly:true,postHumanStartup:task.type==='alipay_name_start'}});
      if(checked.postHumanCheckPassed!==true)throw failure('alipay_lookup_result_unconfirmed','人工后页面未确认',{runnerReason:'local_lookup_result_unconfirmed:post_human_protocol'});
      if(checked.postHumanResult===true){verifiedAccount(checked);if(checked.currentAccount!==policy.knownAccount||checked.matchedPhone!==policy.phoneNumber||!checked.realNameTailCharacter)throw failure('alipay_account_identity_unverified','人工后结果身份不一致');return decorate(checked);}
    } catch(error) {
      try {await saveRestriction(error);} catch(failure) {throw preserveQueryFailure(failure);}
      if(readiness)throw failure('alipay_prepared_account_limited','当前账号已冷却，原号码交还平台重新分配。',decorate({...error.diagnostic,code:'alipay_prepared_account_limited',limitReached:true,accountSwitchRequired:true}));
      await prepare();
    }
  }
  if (task.type === "alipay_name_start") return prepare();
  if (task.type !== "alipay_name_query") return verifiedAccount(await execute(task));
  if (!policy.accountIdentityVerified || !policy.knownAccount
      || policy.accountCooldowns.some((row) => row.account === policy.knownAccount && Date.parse(row.cooldownUntil) > now())) {
    if(readiness)throw failure('lookup_readiness_expired','账号就绪凭据已失效，未执行原号码查询。');
    await prepare();
  }
  // A failed query may reset the server's first-query hint. The session's
  // complete verified identity remains valid until an actual account change.
  verifiedAccount({ currentAccount: policy.knownAccount,
    accountIdentityVerified: policy.accountIdentityVerified, savedAccounts });
  for (let attempt = 0; attempt < 12; attempt += 1) {
    assertAllowed();
    try {
      if(readiness&&probedAccount!==policy.knownAccount){
        if(!/^1[3-9]\d{9}$/.test(readiness.probePhone||''))throw failure('lookup_probe_not_configured','内部探测配置缺失');
        const probe=verifiedAccount(await execute({...task,payload:{...policy,phoneNumber:readiness.probePhone,preparedEmptyResult:false,resumeAfterHumanVerification:false,restartAfterHumanVerification:false}}));
        if(probe.currentAccount!==policy.knownAccount||probe.matchedPhone!==readiness.probePhone||!String(probe.realNameTailCharacter||'').trim()||probe.notFound===true)throw failure('lookup_readiness_probe_failed','当前账号首次探测未通过');
        probedAccount=policy.knownAccount;
      }
      const result = await execute({ ...task, payload: {...policy,preparedEmptyResult:Boolean(readiness&&probedAccount===policy.knownAccount)} }, { beforeLookupRecovery: async () => {
        // Restarting this app does not switch accounts. Keep the session's
        // verified identity and let page recovery navigate straight to Search.
        verifiedAccount({ currentAccount: policy.knownAccount,
          accountIdentityVerified: policy.accountIdentityVerified, savedAccounts });
        return policy;
      } });
      verifiedAccount(result);
      if (result.currentAccount !== policy.knownAccount) throw failure("alipay_account_identity_unverified", "查询账户与已确认账户不一致，已停止。");
      return decorate(result);
    } catch (error) {
      try { await saveRestriction(error); }
      catch (failure) { throw preserveQueryFailure(failure); }
      if (readiness) {
        throw failure('alipay_prepared_account_limited', '当前账号已冷却，原号码交还平台重新分配。',
          decorate({...error.diagnostic, code:'alipay_prepared_account_limited', limitReached:true, accountSwitchRequired:true}));
      }
      await prepare();
    }
  }
  throw failure("alipay_account_rotation_bound_reached", "账户检查次数已达安全上限，请检查账户列表。");
}
