import crypto from "node:crypto";

export function signedHeaders(secret, clientId, method, pathname, rawBody = "") {
  const timestamp = String(Date.now()); // 毫秒
  const nonce = crypto.randomUUID();
  const digest = crypto.createHash("sha256").update(rawBody, "utf8").digest("hex");
  const canonical = [method.toUpperCase(), pathname, timestamp, nonce, digest].join("\n");
  return {
    "Content-Type": "application/json",
    "X-Client-Id": clientId,
    "X-Timestamp": timestamp,
    "X-Nonce": nonce,
    "X-Signature": crypto.createHmac("sha256", secret).update(canonical).digest("hex")
  };
}
