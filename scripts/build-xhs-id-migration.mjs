import fs from "node:fs/promises";

export function normalizeAccountName(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .trim()
    .toLowerCase();
}

function accountAliases(originalName = "", accountName = "") {
  const aliases = new Set();
  const add = (value) => {
    const normalized = normalizeAccountName(value);
    if (normalized) aliases.add(normalized);
  };
  add(originalName);
  add(accountName);
  add(String(accountName || "").replace(/[【\[].*?[】\]]/g, ""));
  const renamed = String(accountName || "").match(/改名\s*[:：]\s*(.+)$/);
  if (renamed) add(renamed[1]);
  return [...aliases];
}

function numericDeviceName(value = "") {
  return String(value || "").trim().match(/^\d+/)?.[0] || "";
}

export function parseAccountTable(source = "") {
  return String(source || "")
    .split(/\r?\n/)
    .map((line, index) => ({ columns: line.split("\t"), tableLine: index + 1 }))
    .filter(({ columns }) => /专业号|员工号/.test(columns[1] || ""))
    .map(({ columns, tableLine }) => {
      const originalName = String(columns[2] || "").trim();
      const xhsId = String(columns[3] || "").replace(/\s+/g, "").trim();
      const accountName = String(columns[4] || "").trim();
      const loginDeviceName = numericDeviceName(columns[11]) || numericDeviceName(columns[10]);
      return {
        tableLine,
        accountType: String(columns[1] || "").trim(),
        originalName,
        accountName,
        xhsId,
        loginDeviceName,
        aliases: accountAliases(originalName, accountName)
      };
    })
    .filter((row) => row.xhsId && row.loginDeviceName && row.aliases.length);
}

export function buildMigration(tableRows = [], platformRows = []) {
  const migrated = [];
  const unresolved = [];
  const ambiguous = [];

  for (const binding of Array.isArray(platformRows) ? platformRows : []) {
    if (!String(binding?.accountName || "").trim()) continue;
    const deviceName = numericDeviceName(binding.deviceName);
    const accountName = normalizeAccountName(binding.accountName);
    const candidates = tableRows.filter((row) => (
      row.loginDeviceName === deviceName && row.aliases.includes(accountName)
    ));
    if (candidates.length === 0) {
      unresolved.push(binding);
      continue;
    }
    if (candidates.length > 1) {
      ambiguous.push({ binding, candidates });
      continue;
    }
    migrated.push({
      deviceId: String(binding.deviceId || ""),
      deviceName: String(binding.deviceName || ""),
      appSlot: String(binding.appSlot || ""),
      accountName: String(binding.accountName || ""),
      xhsId: candidates[0].xhsId,
      tableLine: candidates[0].tableLine
    });
  }

  const rowsById = new Map();
  for (const row of migrated) rowsById.set(row.xhsId, [...(rowsById.get(row.xhsId) || []), row]);
  const duplicateIds = [...rowsById.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([xhsId, rows]) => ({ xhsId, rows }));
  return {
    summary: {
      platformBindings: (Array.isArray(platformRows) ? platformRows : []).filter((row) => String(row?.accountName || "").trim()).length,
      migrated: migrated.length,
      unresolved: unresolved.length,
      ambiguous: ambiguous.length,
      duplicateIds: duplicateIds.length
    },
    migrated,
    unresolved,
    ambiguous,
    duplicateIds
  };
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const tablePath = process.argv[2];
  if (!tablePath) throw new Error("usage: node scripts/build-xhs-id-migration.mjs <account-table.txt>");
  const [tableSource, platformSource] = await Promise.all([fs.readFile(tablePath, "utf8"), readStdin()]);
  const report = buildMigration(parseAccountTable(tableSource), JSON.parse(platformSource));
  console.log(JSON.stringify(report, null, 2));
  if (report.summary.unresolved || report.summary.ambiguous || report.summary.duplicateIds) process.exitCode = 2;
}
