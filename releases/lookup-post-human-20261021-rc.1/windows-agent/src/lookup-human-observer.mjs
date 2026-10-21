import {classifyPostHumanPage} from './lookup-post-human-state.mjs';
const PACKAGE = "com.eg.android.AlipayGphone";
const INPUT = "com.alipay.mobile.antui:id/search_input_box";
const VERIFICATION = ["为保障您的正常访问请进行验证", "请拖动滑块完成拼图", "向右滑动验证"];

function foregroundComponent(focus) {
  // Inactive virtual displays can contribute a literal null focus. Ignore
  // only that exact record; ambiguous/malformed non-null records stay unknown.
  const lines = String(focus || "").split(/\r?\n/).filter((line) => line.includes("mCurrentFocus"))
    .filter((line) => !/^\s*mCurrentFocus\s*=\s*null\s*$/.test(line));
  if (lines.length !== 1) return "";
  const window = lines[0].match(/^\s*mCurrentFocus\s*=\s*Window\{[^\s{}]+(?:\s+u\d+)?\s+([^\s{}/]+\/[^\s{}]+)(?:\s+type=\d+)?\s*\}\s*$/);
  return window?.[1]?.startsWith(PACKAGE + "/") ? window[1] : "";
}

export function classifyHumanVerificationXml(xml, focusBefore, focusAfter) {
  if (!foregroundComponent(focusBefore) || foregroundComponent(focusBefore) !== foregroundComponent(focusAfter)) return "unknown";
  const source = String(xml || "");
  const start = source.indexOf("<hierarchy");
  const end = source.lastIndexOf("</hierarchy>");
  if (start < 0 || end < start || source.length > 1024 * 1024) return "unknown";
  const document = source.slice(start, end + "</hierarchy>".length);
  if (/<!|<\?/.test(document)) return "unknown";
  // Validate the complete (tiny UIAutomator) element/attribute grammar instead
  // of treating a missing string in truncated XML as a successful verification.
  const stack = [];
  const nodes = [];
  let rootSeen = false;
  const tags = document.match(/<[^>]*>/g) || [];
  if (document.replace(/<[^>]*>/g, "").trim()) return "unknown";
  for (const tag of tags) {
    const close = tag.match(/^<\/(hierarchy|node)>$/);
    if (close) { if (stack.pop() !== close[1]) return "unknown"; continue; }
    const open = tag.match(/^<(hierarchy|node)\b([\s\S]*?)(\/?)>$/);
    if (!open || (!stack.length && (open[1] !== "hierarchy" || nodes.length))) return "unknown";
    if (open[1] === "hierarchy") {
      if (rootSeen || stack.length) return "unknown";
      rootSeen = true;
    }
    const attrs = {};
    let invalid = false;
    const remainder = open[2].replace(/\s+([\w:-]+)="([^"<>]*)"/g, (_match, key, value) => {
      if (Object.hasOwn(attrs, key)) invalid = true;
      // Unsupported/numeric entities must not hide a verification marker.
      if (/&(?!(?:amp|quot|apos|lt|gt);)/.test(value)) invalid = true;
      attrs[key] = value.replace(/&quot;/g, '"').replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      return "";
    });
    if (invalid || remainder.trim()) return "unknown";
    if (open[1] === "node") nodes.push(attrs);
    if (!open[3]) stack.push(open[1]);
  }
  if (stack.length || !nodes.length) return "unknown";
  const texts = nodes.flatMap((node) => [node.text || "", node["content-desc"] || ""]);
  const inputs = nodes.filter(node => node['resource-id'] === INPUT && node.package === PACKAGE);
  return classifyPostHumanPage(texts, {
    loginActivity: [focusBefore,focusAfter].every(f=>/\/com\.ali\.user\.mobile\.loginupgrade\.activity\.LoginActivity(?:[\s}]|$)/.test(f)),
    webview:nodes.some(n=>n.class==='android.webkit.WebView'&&n['visible-to-user']!=='false'),
    inputReady:inputs.length===1&&inputs[0].enabled==='true'&&inputs[0]['visible-to-user']!=='false'
  });
}

export function classifyLookupWakefulness(output) {
  const values = [...String(output || '').matchAll(/^\s*mWakefulness=(\w+)\s*$/gm)].map(m => m[1]);
  if (!values.length || new Set(values).size !== 1) return 'unknown';
  if (values[0] === 'Awake') return 'awake';
  return ['Asleep', 'Dozing'].includes(values[0]) ? 'screen_off' : 'unknown';
}

export function createLookupHumanObserver({ request, observe, canObserve, agentId, maxPerPoll = 3, detached = false, onError = () => {}, readPower }) {
  let running = false;
  const inFlight = new Set();
  let stopped = false;
  let cursor = 0;
  return {
    stop() { stopped = true; },
    async poll() {
      if (running || stopped) return;
      running = true;
      try {
        const path = `/api/v1/windows-agents/${encodeURIComponent(agentId)}/lookup-human-verifications`;
        const { probes = [] } = await request(path, { timeoutMs: 5_000 });
        if (!probes.length) return;
        const key = p => p.adbSerial || p.deviceId || p.probeId;
        const available=probes.filter(p=>!inFlight.has(key(p)));
        const capacity=Math.max(0,maxPerPoll-inFlight.size);
        if(!available.length||!capacity)return;
        const start=cursor % available.length;
        const selected=Array.from({length:Math.min(capacity,available.length)},(_,offset)=>available[(start+offset)%available.length]);
        cursor+=selected.length;
        for(const p of selected)inFlight.add(key(p));
        // Each device has its own read and report. A slow phone must not age
        // another phone's lease or delay its completed observation.
        const completion = Promise.allSettled(selected.map(async (probe) => {
          try {
          if (stopped) return;
          const startedAt = Date.now();
          let state = 'unknown', reason = 'device_busy';
          const power = async () => {
            if (!readPower) return 'awake'; // Existing callers remain compatible.
            try { return classifyLookupWakefulness(await readPower(probe)); }
            catch { return 'unknown'; }
          };
          if (canObserve(probe)) {
            const before = await power();
            if (before !== 'awake') {
              state = before === 'screen_off' ? 'screen_off' : 'unknown';
              reason = state === 'screen_off' ? 'screen_off' : 'power_unavailable';
            } else if (canObserve(probe)) {
              try {
                const observed = await observe(probe);
                state = ['present','search_ready','account_limited','login_required','recoverable_page','loading','network_busy'].includes(observed) ? observed : 'unknown';
                reason = state === 'present' ? 'verification_present' : state === 'unknown' ? 'page_unknown' : state;
                if (state !== 'unknown' && canObserve(probe)) {
                  const after = await power();
                  if (after !== 'awake') {
                    state = after === 'screen_off' ? 'screen_off' : 'unknown';
                    reason = state === 'screen_off' ? 'screen_off' : 'power_unavailable';
                  }
                }
              } catch { state = 'unknown'; reason = 'read_failed'; }
            }
          }
          if (stopped) return;
          if (!canObserve(probe)) { state = 'unknown'; reason = 'device_busy'; }
          await request(path, { method: "POST", timeoutMs: 5_000, body: {
            probeId: probe.probeId, state, reason,
            readDurationMs: Math.min(30000, Math.max(0, Date.now() - startedAt))
          } });
          } finally { inFlight.delete(key(probe)); }
        })).then(results=>{
          const failure=results.find(r=>r.status==='rejected');if(failure)throw failure.reason;
        });
        if(detached)completion.catch(onError);else await completion;
      } finally { running = false; }
    }
  };
}
