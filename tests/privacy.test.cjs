const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
const source = readFileSync(join(__dirname, '../frontend/index.tsx'), 'utf8');
const parsed = ts.createSourceFile('index.tsx', source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX);
const names = new Set(['canPublishActivity', 'requirePublicActivity', 'stopMonitor',
  'launchLuaToolsApp', 'clearPresenceWhenMonitorFinishes', 'launchFromSteamUrlShortcut',
  'installLuaToolsRunGameHook', 'scheduleLuaToolsMonitor', 'syncLuaToolsApp']);
const implementation = ts.transpileModule(parsed.statements.filter(s => ts.isFunctionDeclaration(s) && names.has(s.name?.text))
  .map(s => s.getText(parsed)).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
function harness({ privateGame = false, ready = true, missing = false } = {}) {
  const state = { privateGame, ready, timers: [], runs: [], stops: [], callbacks: [], syncs: 0 };
  const monitor = { sourceAppId: 4001350, runGameId: '11177325188675010560', signalToken: 'test' };
  const context = vm.createContext({ console: { info() {}, warn() {} },
    appStore: missing ? undefined : {
      BIsAppPrivate: () => state.privateGame,
      m_privateAppsObserver: {
        getCurrentResult: () => ({ isSuccess: state.ready, data: new Set(state.privateGame ? [4001350] : []) }),
        subscribe: cb => { state.callbacks.push(cb); return () => { state.callbacks = state.callbacks.filter(x => x !== cb); }; },
      },
    },
    window: { setTimeout: (cb, delay) => { state.timers.push({ cb, delay }); } },
    getApps: () => ({ RunGame: (...args) => state.runs.push(args), TerminateApp: async (...args) => state.stops.push(args) }),
    numericSourceAppId: Number, normalizeInput: game => typeof game === 'number' ? { appId: game } : game,
    STEAM_URL_RUN_GAME_ID_OR_JUMPLIST: 404, shortcutLaunchesInFlight: new Set(),
    originalSteamRunGame: (...args) => state.runs.push(args),
    getLuaToolsLauncher: async () => { state.syncs++; throw Error('should not reach launcher'); },
    callBackend: async () => { throw Error('RPC offline'); },
    monitor,
  });
  vm.runInContext(`let activeMonitor; ${implementation}`, context);
  return { state, context, monitor, run: code => vm.runInContext(code, context) };
}
test('privacy fails closed until Steam has a successful private-app query', () => {
  for (const options of [{ privateGame: true }, { ready: false }, { missing: true }]) {
    assert.equal(harness(options).run('canPublishActivity(4001350)'), false);
  }
  assert.equal(harness().run('canPublishActivity(4001350)'), true);
});
test('private game never reaches shortcut creation or helper launch', async () => {
  const h = harness({ privateGame: true });
  await assert.rejects(h.run('syncLuaToolsApp(4001350)'), /Atividade omitida/);
  await assert.rejects(h.run('launchLuaToolsApp(4001350)'), /Atividade omitida/);
  assert.equal(h.state.syncs, 0);
  assert.equal(h.state.runs.length, 0);
});
test('desktop shortcut still starts private game exactly once without helper', async () => {
  const h = harness({ privateGame: true });
  await h.run('launchFromSteamUrlShortcut(4001350, "steam://rungameid/4001350")');
  assert.equal(h.state.runs.length, 1);
  assert.equal(h.state.runs[0][0], '4001350');
  assert.equal(h.state.syncs, 0);
});
test('privacy change during launch delay blocks helper', async () => {
  const h = harness();
  h.run('syncLuaToolsApp = async () => monitor');
  const launching = h.run('launchLuaToolsApp(4001350)');
  await new Promise(resolve => setImmediate(resolve));
  h.state.privateGame = true;
  h.state.timers.shift().cb();
  await assert.rejects(launching, /Atividade omitida/);
  assert.equal(h.state.runs.length, 0);
});
test('public game starts helper and live privacy change stops only that helper', async () => {
  const h = harness();
  h.run('syncLuaToolsApp = async () => monitor');
  const launching = h.run('launchLuaToolsApp(4001350)');
  await new Promise(resolve => setImmediate(resolve));
  h.state.timers.shift().cb();
  await launching;
  assert.equal(h.state.runs[0][0], h.monitor.runGameId);
  h.state.privateGame = true;
  h.state.callbacks.forEach(cb => cb());
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.state.stops.length, 1);
  assert.equal(h.state.stops[0][0], h.monitor.runGameId);
});
test('privacy polling survives backend failure and never terminates real game', async () => {
  const h = harness();
  const watching = h.run('activeMonitor = monitor; clearPresenceWhenMonitorFinishes(monitor)');
  h.state.timers.shift().cb();
  await new Promise(resolve => setImmediate(resolve));
  h.state.privateGame = true;
  h.state.timers.shift().cb();
  await watching;
  assert.equal(h.state.stops[0][0], h.monitor.runGameId);
  assert.equal(h.state.callbacks.length, 0);
});
test('stale monitor completion cannot terminate a replacement session', async () => {
  const h = harness();
  const watching = h.run('activeMonitor = monitor; clearPresenceWhenMonitorFinishes(monitor)');
  h.run('activeMonitor = { ...monitor, signalToken: "replacement" }');
  h.state.timers.shift().cb();
  await watching;
  assert.equal(h.state.stops.length, 0);
  assert.equal(h.state.callbacks.length, 0);
});
