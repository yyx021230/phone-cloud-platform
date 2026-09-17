// Shared by SMS ingestion and order matching. Do not infer Douyin from a
// generic ByteDance/TikTok label or an incidental mention in another SMS.
export function normalizePlatform(value = "") {
  const text = String(value || "").normalize("NFKC").trim();
  if (/xhs|redbook|xiaohongshu|小红书/i.test(text)) return "小红书";
  if (/^(抖音|douyin)$/i.test(text)) return "抖音";
  return text || "未知平台";
}

export function detectPlatform(body = "", sender = "") {
  const content = String(body || "").normalize("NFKC");
  const address = String(sender || "").normalize("NFKC").trim();
  const xhs = /小红书|xhs|redbook|xiaohongshu/i.test(`${address} ${content}`);
  const douyin = /^(?:抖音|douyin|【\s*(?:抖音|douyin)\s*】|\[\s*(?:抖音|douyin)\s*\])$/i.test(address)
    || /(?:【\s*(?:抖音|douyin)\s*】|\[\s*(?:抖音|douyin)\s*\])/i.test(content);
  if (xhs && douyin) return "未知平台";
  if (xhs) return "小红书";
  if (douyin) return "抖音";
  return address || "未知平台";
}

export function resolveSmsPlatform(message = {}) {
  const explicit = normalizePlatform(message.platform);
  // Numeric platforms are legacy sender-number fallbacks, not brand labels.
  if (explicit !== "未知平台" && !/^\+?[\d\s-]+$/.test(explicit)) return explicit;
  const detected = detectPlatform(message.body, message.address || message.sender || "");
  return detected === "未知平台" ? explicit : detected;
}
