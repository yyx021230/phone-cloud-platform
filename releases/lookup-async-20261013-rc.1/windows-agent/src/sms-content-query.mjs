export function quoteAdbRemoteShellArgument(value) {
  const text = String(value ?? "");
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function buildSmsContentQueryArgs(columns, where = "") {
  const projection = Array.isArray(columns)
    ? columns.map((column) => String(column || "").trim()).filter(Boolean)
    : [];
  if (!projection.length) throw new Error("sms_content_projection_required");

  const args = [
    "shell",
    "content",
    "query",
    "--uri",
    "content://sms",
    "--projection",
    projection.join(":")
  ];
  const selection = String(where || "").trim();
  if (selection) args.push("--where", quoteAdbRemoteShellArgument(selection));
  return args;
}
