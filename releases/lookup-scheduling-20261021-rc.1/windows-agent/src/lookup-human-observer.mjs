const PACKAGE = "com.eg.android.AlipayGphone";
const INPUT = "com.alipay.mobile.antui:id/search_input_box";
const VERIFICATION = ["为保障您的正常访问请进行验证", "请拖动滑块完成拼图", "向右滑动验证"];

function foregroundIsAlipay(focus) {
  // Inactive virtual displays can contribute a literal null focus. Ignore
  // only that exact record; ambiguous/malformed non-null records stay unknown.
  const lines = String(focus || "").split(/\r?\n/).filter((line) => line.includes("mCurrentFocus"))
    .filter((line) => !/^\s*mCurrentFocus\s*=\s*null\s*$/.test(line));
  if (lines.length !== 1) return false;
  const window = lines[0].match(/^\s*mCurrentFocus\s*=\s*Window\{[^\s{}]+(?:\s+u\d+)?\s+([^\s{}/]+)\/[^\s{}]+(?:\s+type=\d+)?\s*\}\s*$/);
  return window?.[1] === PACKAGE;
}

export function classifyHumanVerificationXml(xml, focusBefore, focusAfter) {
  if (!foregroundIsAlipay(focusBefore) || !foregroundIsAlipay(focusAfter)) return "unknown";
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
  if (texts.some((text) => VERIFICATION.some((marker) => text.includes(marker)))) return "present";
  if (nodes.some((node) => node.class === "android.webkit.WebView" && node["visible-to-user"] !== "false")) return "unknown";
  if (texts.some((text) => ["访问被拒绝", "您的设备可能存在风险", "操作频繁或访问异常", "您请求次数过于频繁", "待会来试试", "反馈码:", "短信验证码登录"].some((marker) => text.includes(marker)))) return "unknown";
  const inputs = nodes.filter((node) => node["resource-id"] === INPUT && node.package === PACKAGE);
  return inputs.length === 1 && inputs[0].enabled === "true" && inputs[0]["visible-to-user"] !== "false"
    ? "search_ready" : "unknown";
}

export function createLookupHumanObserver({ request, observe, canObserve, agentId, maxPerPoll = 3, detached = false, onError = () => {} }) {
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
          let state = "unknown";
          if (canObserve(probe)) {
            try { state = await observe(probe); } catch { /* Failed reads are never clear. */ }
          }
          if (stopped) return;
          await request(path, { method: "POST", timeoutMs: 5_000, body: {
            probeId: probe.probeId,
            state: ["present", "search_ready"].includes(state) ? state : "unknown"
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
