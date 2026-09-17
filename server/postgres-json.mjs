export function sanitizePostgresText(value, maxLength = Number.POSITIVE_INFINITY) {
  const text = String(value ?? "").replaceAll("\u0000", "");
  return Number.isFinite(maxLength) ? text.slice(0, Math.max(0, maxLength)) : text;
}

export function stringifyPostgresJson(value) {
  return JSON.stringify(value, (_key, item) => (
    typeof item === "string" ? item.replaceAll("\u0000", "") : item
  ));
}
