import { definePlugin, findModuleExport, Millennium } from '@steambrew/client';
import React, { useEffect, useState } from 'react';

type LuaToolsGame = { appId?: number | string; appid?: number | string; name?: string };
type LuaToolsLauncher = {
  appid: number; name: string; executable: string; directory: string;
  helperExecutable: string; helperDirectory: string;
};
type ShortcutResult = {
  appId: number; runGameId: string; name: string; sourceAppId: number; reused?: boolean;
  signalToken?: string;
};
type LuaToolsActivityApi = {
  isLuaToolsApp(appId: number | string): Promise<boolean>;
  syncLuaToolsApp(game: LuaToolsGame | number | string): Promise<ShortcutResult>;
  launchLuaToolsApp(game: LuaToolsGame | number | string): Promise<ShortcutResult>;
  installLuaToolsRunGameHook(): boolean;
};

declare global { var LuaToolsSteamActivity: LuaToolsActivityApi | undefined }

const LEGACY_CACHE_KEY = 'LuaToolsSteamActivity.shortcuts.v2';
const SHARED_CACHE_KEY = 'LuaToolsSteamActivity.sharedShortcut.v3';
const STEAM_URL_RUN_GAME_ID_OR_JUMPLIST = 404;
const MAX_STEAM_APP_ID = 0x7fffffff;
const UINT32_SIZE = 4294967296n;
const SHORTCUT_LOW_BITS = 33554432n;
type SharedShortcutCache = { appId: number; runGameId: string };
type CollectionStore = { SetAppsAsHidden?: (appIds: number[], hidden: boolean) => void };
type SteamUrlStore = {
  BuildCachedLibraryAssetURL(appId: number, filename: string, cacheVersion: number): string;
  BuildLegacyCachedLibraryAssetURL(appId: number, filename: string, cacheVersion: number): string;
  BuildLibraryAssetURL(appId: number, filename: string, modifiedTime: number): string;
};
type SteamRunGame = (appId: string, launchOptions: string, param2: number, launchSource: number) => unknown;

const luaToolsAppIds = new Set<number>();
const knownShortcutIds = new Set<string>();
let runGameHookInstalled = false;
let sessionShortcutAppId = 0;
let collectionStoreCache: CollectionStore | undefined;
let refreshAppIdsInFlight: Promise<number> | undefined;
let cachedAppIdsCount: number | undefined;
let originalSteamRunGame: SteamRunGame | undefined;
const recentLaunches = new Map<number, number>();
const steamUrlRegistrations = new Map<number, unknown>();
const shortcutLaunchesInFlight = new Set<number>();
let activeMonitor: ShortcutResult | undefined;

function canPublishActivity(sourceAppId: number): boolean {
  try {
    const store = (globalThis as any).appStore;
    // Steam initializes the private-app set empty, before the account query
    // resolves. An empty set alone must never be interpreted as public.
    const privacy = store?.m_privateAppsObserver?.getCurrentResult?.();
    return privacy?.isSuccess === true
      && typeof privacy.data?.has === 'function'
      && privacy.data.has(sourceAppId) === false
      && typeof store?.BIsAppPrivate === 'function'
      && store.BIsAppPrivate(sourceAppId) === false;
  } catch {
    return false;
  }
}

function requirePublicActivity(sourceAppId: number) {
  if (!canPublishActivity(sourceAppId)) {
    throw new Error('Atividade omitida: jogo privado ou privacidade ainda indisponível.');
  }
}

async function stopMonitor(result: ShortcutResult) {
  if (activeMonitor !== result) return;
  await getApps().TerminateApp(result.runGameId, true);
  if (activeMonitor === result) activeMonitor = undefined;
}

function getApps(): any {
  const apps = (globalThis as any).SteamClient?.Apps;
  if (!apps?.AddShortcut || !apps?.RunGame) throw new Error('SteamClient.Apps ainda não está disponível.');
  return apps;
}

function numericSourceAppId(value: number | string | undefined): number {
  const appId = Number(value);
  return Number.isInteger(appId) && appId > 0 && appId <= MAX_STEAM_APP_ID ? appId : 0;
}

function toShortcutRunGameId(appId: number): string {
  const unsignedAppId = BigInt.asUintN(32, BigInt(Math.trunc(appId)));
  return String(unsignedAppId * UINT32_SIZE + SHORTCUT_LOW_BITS);
}

function rememberShortcut(appId: number, runGameId = toShortcutRunGameId(appId)) {
  knownShortcutIds.add(String(appId));
  knownShortcutIds.add(runGameId);
}

function parseBackendResponse<T>(response: unknown): T {
  if (typeof response !== 'string') return response as T;
  try { return JSON.parse(response) as T; } catch { return response as T; }
}

async function callBackend<T>(method: string, params: Record<string, unknown>): Promise<T> {
  if (!(Millennium as any)?.callServerMethod) throw new Error('A API de backend do Millennium não está disponível.');
  return parseBackendResponse<T>(await Millennium.callServerMethod(method, params));
}

function normalizeInput(game: LuaToolsGame | number | string): LuaToolsGame {
  if (typeof game === 'number' || typeof game === 'string') return { appId: game };
  return { ...game, appId: game.appId || game.appid };
}

function readSharedCache(): SharedShortcutCache | undefined {
  try {
    const raw = window.localStorage.getItem(SHARED_CACHE_KEY);
    if (!raw) return undefined;
    const value = JSON.parse(raw) as SharedShortcutCache;
    return Number.isInteger(value?.appId) && value.appId > 0 ? value : undefined;
  } catch { return undefined; }
}

function writeSharedCache(cache: SharedShortcutCache) {
  try { window.localStorage.setItem(SHARED_CACHE_KEY, JSON.stringify(cache)); } catch { /* restricted webview */ }
}

function clearSharedCache() {
  try { window.localStorage.removeItem(SHARED_CACHE_KEY); } catch { /* restricted webview */ }
}

function removeLegacyShortcuts() {
  try {
    const raw = window.localStorage.getItem(LEGACY_CACHE_KEY);
    const cache = raw ? JSON.parse(raw) : {};
    const apps = (globalThis as any).SteamClient?.Apps;
    Object.values(cache || {}).forEach((entry: any) => {
      const appId = Number(entry?.appId);
      if (Number.isInteger(appId) && appId > 0) apps?.RemoveShortcut?.(appId);
    });
    window.localStorage.removeItem(LEGACY_CACHE_KEY);
  } catch (error) {
    console.warn('[Lua Tools Activity] Não foi possível limpar os atalhos antigos:', error);
  }
}

async function getLuaToolsLauncher(sourceAppId: number): Promise<LuaToolsLauncher> {
  const response = await callBackend<LuaToolsLauncher | string>('get_lua_tools_executable', { appid: sourceAppId });
  const launcher = typeof response === 'string' ? (() => {
    const [appid, name, executable, directory, helperExecutable, helperDirectory] = response.split('\t');
    return { appid: Number(appid), name, executable, directory, helperExecutable, helperDirectory };
  })() : response;
  if (!launcher?.directory || !launcher.helperExecutable || !launcher.helperDirectory) {
    throw new Error(`Monitor do AppID ${sourceAppId} não encontrado.`);
  }
  return launcher;
}

async function isLuaToolsApp(appId: number | string): Promise<boolean> {
  const sourceAppId = numericSourceAppId(appId);
  if (!sourceAppId) return false;
  const response = await callBackend<boolean>('has_lua_tools_app', { appid: sourceAppId });
  return response === true || (response as unknown) === 'true';
}

async function refreshLuaToolsAppIds(): Promise<number> {
  if (cachedAppIdsCount !== undefined) return cachedAppIdsCount;
  if (refreshAppIdsInFlight) return refreshAppIdsInFlight;
  refreshAppIdsInFlight = (async () => {
    // A CSV containing one AppID is also valid JSON, so callBackend parses
    // it as a number. Accept that scalar as well as CSV and array responses.
    const response = await callBackend<number[] | number | string>('get_lua_tools_appids', {});
    const appIds = Array.isArray(response)
      ? response.map((value) => numericSourceAppId(value)).filter(Boolean)
      : typeof response === 'string'
        ? response.split(',').map((value) => numericSourceAppId(value)).filter(Boolean)
        : typeof response === 'number'
          ? [numericSourceAppId(response)].filter(Boolean)
          : [];
    luaToolsAppIds.clear();
    appIds.forEach((appId) => luaToolsAppIds.add(appId));
    cachedAppIdsCount = appIds.length;
    console.info(`[Lua Tools Activity] Lista atualizada: ${appIds.length} AppIDs Lua Tools`);
    return appIds.length;
  })();

  try {
    return await refreshAppIdsInFlight;
  } finally {
    refreshAppIdsInFlight = undefined;
  }
}

async function cachedShortcutExists(appId: number): Promise<boolean> {
  if (sessionShortcutAppId === appId) return true;
  const response = await callBackend<boolean>('has_steam_shortcut', { appid: appId });
  return response === true || (response as unknown) === 'true';
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const separator = result.indexOf('base64,');
      if (separator < 0) reject(new Error('Formato de imagem inválido.'));
      else resolve(result.slice(separator + 7));
    };
    reader.onerror = () => reject(reader.error || new Error('Falha ao ler a imagem.'));
    reader.readAsDataURL(blob);
  });
}

async function fetchLibraryAsset(urls: string[]): Promise<{ base64: string; imageType: 'jpg' | 'png' }> {
  let lastError: unknown;
  for (const url of urls.filter(Boolean)) {
    try {
      const response = await fetch(url, { cache: 'force-cache' });
      if (!response.ok) continue;
      const blob = await response.blob();
      if (!blob.type.startsWith('image/')) continue;
      const imageType: 'jpg' | 'png' = blob.type.includes('png') || url.toLowerCase().includes('.png')
        ? 'png'
        : 'jpg';
      return { base64: await blobToBase64(blob), imageType };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error('Arte não encontrada no cache local nem no CDN do Steam.');
}

async function syncShortcutArtwork(sourceAppId: number, shortcutAppId: number) {
  const apps = getApps();
  if (typeof apps.SetCustomArtworkForApp !== 'function') {
    throw new Error('A API de arte personalizada do Steam não está disponível.');
  }

  const globalWindow = globalThis as any;
  const urlStore = globalWindow.urlStore as SteamUrlStore | undefined;
  const overview = globalWindow.appStore?.GetAppOverviewByAppID?.(sourceAppId);
  const details = globalWindow.appDetailsStore?.GetAppDetails?.(sourceAppId);
  if (!urlStore) throw new Error('O gerador de URLs de arte do Steam não está disponível.');

  const libraryAssets = details?.libraryAssets || {};
  const cacheVersion = Number(overview?.local_cache_version || 0);
  const modifiedTime = Number(overview?.rt_store_asset_mtime || 0);
  const assets = [
    { type: 0, filename: overview?.library_capsule_filename || 'library_600x900.jpg', legacy: 'library_600x900.jpg' },
    { type: 1, filename: libraryAssets.strHeroImage || 'library_hero.jpg', legacy: 'library_hero.jpg' },
    { type: 2, filename: libraryAssets.strLogoImage || 'logo.png', legacy: 'logo.png' },
    { type: 3, filename: libraryAssets.strHeaderImage || overview?.header_filename || 'header.jpg', legacy: 'header.jpg' },
  ];

  for (const asset of assets) {
    const image = await fetchLibraryAsset([
      urlStore.BuildCachedLibraryAssetURL(sourceAppId, asset.filename, cacheVersion),
      urlStore.BuildLegacyCachedLibraryAssetURL(sourceAppId, asset.legacy, cacheVersion),
      urlStore.BuildLibraryAssetURL(sourceAppId, asset.filename, modifiedTime),
    ]);
    await apps.SetCustomArtworkForApp(shortcutAppId, image.base64, image.imageType, asset.type);
    apps.ReportLibraryAssetCacheMiss?.(shortcutAppId, asset.type);
  }
  console.info(`[Lua Tools Activity] 4 artes locais confirmadas antes de iniciar ${sourceAppId}`);
}

function quotedArgument(value: string): string {
  return `"${value.replace(/^"|"$/g, '').replace(/"/g, '\\"')}"`;
}

function createSignalToken(): string {
  const random = Math.random().toString(16).slice(2);
  return `${Date.now()}-${random}`;
}

function hideMonitorShortcut(appId: number) {
  const attempt = () => {
    try {
      collectionStoreCache ||= findModuleExport(
        (value: any) => typeof value?.SetAppsAsHidden === 'function',
      ) as CollectionStore | undefined;
      collectionStoreCache?.SetAppsAsHidden?.([appId], true);
    } catch {
      // A Steam leva algum tempo para registrar atalhos recém-criados.
    }
  };

  attempt();
  [500, 1500, 3000].forEach((delay) => window.setTimeout(attempt, delay));
}

function configureMonitorShortcut(appId: number, gameName: string, launcher: LuaToolsLauncher): string {
  const apps = getApps();
  const signalToken = createSignalToken();
  const launchOptions = [
    `--root ${quotedArgument(launcher.directory)}`,
    `--exe ${quotedArgument(launcher.executable)}`,
    `--signal ${signalToken}`,
    '--timeout 45',
  ].join(' ');
  apps.SetShortcutName?.(appId, gameName);
  apps.SetShortcutExe?.(appId, launcher.helperExecutable);
  apps.SetShortcutStartDir?.(appId, launcher.helperDirectory);
  apps.SetShortcutLaunchOptions?.(appId, launchOptions);
  return signalToken;
}

async function syncLuaToolsApp(game: LuaToolsGame | number | string): Promise<ShortcutResult> {
  const input = normalizeInput(game);
  const sourceAppId = numericSourceAppId(input.appId);
  if (!sourceAppId) throw new Error('AppID do Lua Tools inválido.');
  requirePublicActivity(sourceAppId);
  const launcher = await getLuaToolsLauncher(sourceAppId);
  requirePublicActivity(sourceAppId);
  const name = String(input.name || launcher.name || `Steam App ${sourceAppId}`);
  let cache = readSharedCache();
  let reused = false;
  let created = false;

  if (cache && await cachedShortcutExists(cache.appId)) {
    reused = true;
  } else {
    if (cache?.appId) getApps().RemoveShortcut?.(cache.appId);
    clearSharedCache();
    const appId = Number(await getApps().AddShortcut(
      'Lua Tools Activity Monitor', launcher.helperExecutable, launcher.helperDirectory, '',
    ));
    cache = { appId, runGameId: toShortcutRunGameId(appId) };
    created = true;
    sessionShortcutAppId = appId;
    writeSharedCache(cache);
  }

  requirePublicActivity(sourceAppId);
  const signalToken = configureMonitorShortcut(cache.appId, name, launcher);
  if (created) hideMonitorShortcut(cache.appId);
  try {
    await syncShortcutArtwork(sourceAppId, cache.appId);
  } catch (error) {
    console.warn('[Lua Tools Activity] Não foi possível aplicar as artes oficiais:', error);
  }
  rememberShortcut(cache.appId, cache.runGameId);
  return { ...cache, name, sourceAppId, reused, signalToken };
}

async function clearPresenceWhenMonitorFinishes(result: ShortcutResult) {
  if (!result.signalToken) return;
  const deadline = Date.now() + 12 * 60 * 60 * 1000;

  // Subscribe to the same query observer Steam uses for private-app changes.
  // Polling below also protects against a replaced/unavailable observer.
  let unsubscribe: (() => void) | undefined;
  try {
    unsubscribe = (globalThis as any).appStore?.m_privateAppsObserver?.subscribe?.(() => {
      if (!canPublishActivity(result.sourceAppId)) {
        void stopMonitor(result).catch((error) => console.warn('[Lua Tools Activity] Falha ao encerrar monitor:', error));
      }
    });
  } catch { /* Polling remains active. */ }
  try {
  while (Date.now() < deadline && activeMonitor === result) {
    await new Promise((resolve) => window.setTimeout(resolve, 150));
    if (activeMonitor !== result) return;
    try {
      if (!canPublishActivity(result.sourceAppId)) {
        await stopMonitor(result);
        return;
      }
      const finished = await callBackend<boolean>('monitor_finished', { token: result.signalToken });
      if (activeMonitor !== result) return;
      if (finished === true || (finished as unknown) === 'true') {
        await stopMonitor(result);
        console.info('[Lua Tools Activity] monitor auxiliar encerrado de forma forçada');
        return;
      }
    } catch { /* Keep enforcing privacy even if the backend is unavailable. */ }
  }
  } finally { unsubscribe?.(); }
}

async function launchLuaToolsApp(game: LuaToolsGame | number | string): Promise<ShortcutResult> {
  requirePublicActivity(numericSourceAppId(normalizeInput(game).appId));
  if (typeof getApps().TerminateApp !== 'function') {
    throw new Error('A Steam não disponibilizou o encerramento seguro do monitor.');
  }
  const result = await syncLuaToolsApp(game);
  await new Promise((resolve) => window.setTimeout(resolve, 300));
  requirePublicActivity(result.sourceAppId);
  getApps().RunGame(result.runGameId, '', -1, STEAM_URL_RUN_GAME_ID_OR_JUMPLIST);
  activeMonitor = result;
  void clearPresenceWhenMonitorFinishes(result);
  return result;
}

function scheduleLuaToolsMonitor(rawAppId: number | string, origin: string) {
  const sourceAppId = numericSourceAppId(rawAppId);
  if (!sourceAppId || knownShortcutIds.has(String(rawAppId))) return;

  const start = () => {
    if (!luaToolsAppIds.has(sourceAppId) || !canPublishActivity(sourceAppId)) return;

    const now = Date.now();
    const previous = recentLaunches.get(sourceAppId) || 0;
    if (now - previous < 2000) return;
    recentLaunches.set(sourceAppId, now);

    console.info(`[Lua Tools Activity] AppID ${sourceAppId}: lançamento detectado via ${origin}`);
    window.setTimeout(() => {
      void launchLuaToolsApp({ appId: sourceAppId }).catch((error) => {
        console.warn('[Lua Tools Activity] Monitor de atividade não iniciado:', error);
      });
    }, 250);
  };

  if (cachedAppIdsCount === undefined) {
    void refreshLuaToolsAppIds().then(start).catch((error) => {
      console.warn('[Lua Tools Activity] Lista indisponível:', error);
    });
    return;
  }

  start();
}

async function waitForMonitorStart(result: ShortcutResult, timeoutMs = 6000): Promise<boolean> {
  if (!result.signalToken) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => window.setTimeout(resolve, 100));
    const started = await callBackend<boolean>('monitor_started', { token: result.signalToken });
    if (started === true || (started as unknown) === 'true') return true;
  }
  return false;
}

async function launchFromSteamUrlShortcut(sourceAppId: number, url: string) {
  if (shortcutLaunchesInFlight.has(sourceAppId)) return;
  shortcutLaunchesInFlight.add(sourceAppId);

  try {
    if (!canPublishActivity(sourceAppId)) {
      originalSteamRunGame?.(String(sourceAppId), '', -1, STEAM_URL_RUN_GAME_ID_OR_JUMPLIST);
      return;
    }
    console.info(`[Lua Tools Activity] AppID ${sourceAppId}: atalho Steam interceptado (${url})`);
    const monitor = await launchLuaToolsApp({ appId: sourceAppId });
    if (!await waitForMonitorStart(monitor)) {
      throw new Error('A Steam não confirmou a inicialização do monitor.');
    }
    // The process has started; allow Steam to finish recording its action
    // before handing the real game back to the native launcher.
    await new Promise((resolve) => window.setTimeout(resolve, 250));
    originalSteamRunGame?.(String(sourceAppId), '', -1, STEAM_URL_RUN_GAME_ID_OR_JUMPLIST);
  } catch (error) {
    console.warn('[Lua Tools Activity] Status do atalho indisponível; abrindo o jogo normalmente:', error);
    originalSteamRunGame?.(String(sourceAppId), '', -1, STEAM_URL_RUN_GAME_ID_OR_JUMPLIST);
  } finally {
    window.setTimeout(() => shortcutLaunchesInFlight.delete(sourceAppId), 5000);
  }
}

function installSteamUrlShortcutHandlers(): number {
  const steamUrl = (globalThis as any).SteamClient?.URL;
  if (!originalSteamRunGame || typeof steamUrl?.RegisterForRunSteamURL !== 'function') return 0;

  luaToolsAppIds.forEach((appId) => {
    if (steamUrlRegistrations.has(appId)) return;
    const registration = steamUrl.RegisterForRunSteamURL(
      `rungameid/${appId}`,
      (_mode: number, url: string) => { void launchFromSteamUrlShortcut(appId, url); },
    );
    steamUrlRegistrations.set(appId, registration);
  });

  return steamUrlRegistrations.size;
}

function installLuaToolsRunGameHook(): boolean {
  const apps = (globalThis as any).SteamClient?.Apps;
  if (runGameHookInstalled || !apps?.RunGame) return runGameHookInstalled;
  removeLegacyShortcuts();
  const shared = readSharedCache();
  if (shared) {
    rememberShortcut(shared.appId, shared.runGameId);
  }
  const originalRunGame = apps.RunGame.bind(apps) as SteamRunGame;
  originalSteamRunGame = originalRunGame;

  apps.RunGame = function patchedRunGame(appId: string, launchOptions: string, param2: number, launchSource: number) {
    const sourceAppId = numericSourceAppId(appId);
    // Preserve Steam's original launch immediately. The monitor starts later
    // and never launches or replaces the game executable.
    const originalResult = originalRunGame(appId, launchOptions, param2, launchSource);
    if (sourceAppId) scheduleLuaToolsMonitor(sourceAppId, 'biblioteca');
    return originalResult;
  };

  runGameHookInstalled = true;
  console.info('[Lua Tools Activity] monitor da biblioteca instalado');
  void refreshLuaToolsAppIds()
    .then(() => console.info(
      `[Lua Tools Activity] ${installSteamUrlShortcutHandlers()} atalhos Steam registrados`,
    ))
    .catch((error) => console.warn('[Lua Tools Activity] Lista indisponível:', error));
  return true;
}

function installWhenReady(attempt = 0) {
  if (installLuaToolsRunGameHook()) return;
  if (attempt < 30) window.setTimeout(() => installWhenReady(attempt + 1), 1000);
}

const exposedApi: LuaToolsActivityApi = {
  isLuaToolsApp, syncLuaToolsApp, launchLuaToolsApp, installLuaToolsRunGameHook,
};
(globalThis as any).LuaToolsSteamActivity = exposedApi;
Millennium.exposeObj(exposedApi);
installWhenReady();

function PluginContent() {
  const [status, setStatus] = useState('Preparando o monitor…');
  useEffect(() => {
    void refreshLuaToolsAppIds()
      .then((count) => setStatus(`${count} jogos Lua detectados. O lançamento original da Steam será preservado.`))
      .catch((error) => setStatus(`Erro: ${error instanceof Error ? error.message : String(error)}`));
  }, []);
  return (
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontWeight: 600 }}>Non-Steam Activity</div>
      <div style={{ opacity: 0.8, lineHeight: 1.4 }}>
        Mantém o lançamento original da Steam e usa um único monitor oculto para publicar o nome do jogo.
      </div>
      <div style={{ opacity: 0.8 }}>{status}</div>
    </div>
  );
}

export default definePlugin(() => ({
  title: 'Non-Steam Activity', icon: <span>NS</span>, content: <PluginContent />,
}));
