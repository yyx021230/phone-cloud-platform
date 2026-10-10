import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

function functionSource(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start > -1, `${name} must exist`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`could not parse ${name}`);
}

test("numeric search ranks a device-name match ahead of a matching phone number", () => {
  const rankUserDeviceSearch = new Function(`${functionSource("rankUserDeviceSearch")}\nreturn rankUserDeviceSearch;`)();
  const namedDevice = { deviceName: "3号机", deviceId: "adb:serial-a", sims: [{ phoneNumber: "18800000000" }] };
  const phoneMatch = { deviceName: "94号机", deviceId: "adb:serial-b", sims: [{ phoneNumber: "18830000000" }] };

  assert.ok(rankUserDeviceSearch(namedDevice, "3") < rankUserDeviceSearch(phoneMatch, "3"));
});

test("the rendered inventory applies numeric search ranking after filtering", () => {
  assert.match(source, /const numericSearch = \/\^\\d\+\$\/.test\(searchText\)/);
  assert.match(source, /rankUserDeviceSearch\(left\.device, searchText\) - rankUserDeviceSearch\(right\.device, searchText\)/);
});
