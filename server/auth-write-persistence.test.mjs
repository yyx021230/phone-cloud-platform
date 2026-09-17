import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");

test("login, logout, password, and administrator user writes use structured auth persistence", () => {
  const routes = [
    sliceRoute('if (req.method === "POST" && url.pathname === "/api/v1/auth/login")', 'if (req.method === "GET" && url.pathname === "/api/v1/auth/me")'),
    sliceRoute('if (req.method === "POST" && url.pathname === "/api/v1/auth/logout")', 'if (req.method === "POST" && url.pathname === "/api/v1/auth/password")'),
    sliceRoute('if (req.method === "POST" && url.pathname === "/api/v1/auth/password")', 'if (req.method === "POST" && url.pathname === "/api/v1/open/sms-code-requests")'),
    sliceRoute('if (req.method === "POST" && url.pathname === "/api/v1/users")', "const userUpdateMatch ="),
    sliceRoute('if (req.method === "PUT" && userUpdateMatch)', 'if (req.method === "GET" && url.pathname === "/api/v1/diagnostics")')
  ];

  for (const route of routes) {
    assert.match(route, /structuredRepos\.persistAuthMutation/);
    assert.doesNotMatch(route, /await saveState\(\)/);
  }
});

function sliceRoute(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `route markers must exist: ${startMarker}`);
  return source.slice(start, end);
}
