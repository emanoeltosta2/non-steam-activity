const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const ts = require('typescript');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '../frontend/index.tsx'), 'utf8');
function section(start, end) {
  return source.slice(source.indexOf(start), source.indexOf(end));
}
const implementation = ts.transpileModule([
  section('function numericSourceAppId(', 'function toShortcutRunGameId('),
  section('function parseBackendResponse', 'async function callBackend'),
  section('async function refreshLuaToolsAppIds(', 'async function cachedShortcutExists('),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;

for (const [label, response, expected] of [
  ['one Lua game (raw backend CSV)', '4001350', [4001350]],
  ['one Lua game (numeric RPC response)', 4001350, [4001350]],
  ['multiple Lua games', '4001350,1238840', [4001350, 1238840]],
  ['JSON array', '[4001350,1238840]', [4001350, 1238840]],
  ['quoted CSV', '"4001350"', [4001350]],
  ['empty installation', '', []],
  ['invalid IDs', '0,-1,abc,4294967295', []],
]) {
  test(label, async () => {
    const result = await vm.runInNewContext(`
      const MAX_STEAM_APP_ID = 0x7fffffff;
      const luaToolsAppIds = new Set();
      let cachedAppIdsCount, refreshAppIdsInFlight;
      async function callBackend() { return parseBackendResponse(response); }
      ${implementation}
      refreshLuaToolsAppIds().then(count => ({ count, ids: [...luaToolsAppIds] }));
    `, { response, console: { info() {} } });
    assert.equal(result.count, expected.length);
    assert.deepEqual(Array.from(result.ids), expected);
  });
}
