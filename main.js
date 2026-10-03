const { app, BrowserWindow, Menu, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { Auth, tokenUtils } = require('msmc');
const { autoUpdater } = require('electron-updater');
const { Client: MCLCClient } = require('minecraft-launcher-core');

Menu.setApplicationMenu(null);

const userDataPath = app.getPath('userData');
const accountsPath = path.join(userDataPath, 'nexus-accounts.json');
const settingsPath = path.join(userDataPath, 'nexus-settings.json');
const profilesPath = path.join(userDataPath, 'nexus-profiles.json');
const profilesDir = path.join(userDataPath, 'profiles');

const authManager = new Auth('select_account');

function loadAccountsFile() {
  return readJsonSafe(accountsPath, { activeUuid: null, accounts: [] });
}

function saveAccountsFile(data) {
  try {
    writeJsonSafe(accountsPath, data);
  } catch (e) {
    console.error('Failed to save accounts file:', e);
  }
}

function publicAccount(acc) {
  return {
    uuid: acc.uuid,
    name: acc.name,
    skinUrl: `https://mc-heads.net/avatar/${acc.uuid}/64?t=${Date.now()}`
  };
}

function upsertAccount(mclcToken) {
  const data = loadAccountsFile();
  const idx = data.accounts.findIndex(a => a.uuid === mclcToken.uuid);
  const entry = { uuid: mclcToken.uuid, name: mclcToken.name, token: mclcToken };
  if (idx >= 0) {
    data.accounts[idx] = entry;
  } else {
    data.accounts.push(entry);
  }
  data.activeUuid = mclcToken.uuid;
  saveAccountsFile(data);
  return data;
}

const defaultSettings = {
  ramMB: 4096,
  resolutionWidth: 1920,
  resolutionHeight: 1080,
  javaPath: '',
  fullscreen: false,
  lastPlayedProfileId: null,
  selectedLoader: null,
  selectedMcVersion: null,
  selectedLoaderVersion: null
};

function loadSettings() {
  return { ...defaultSettings, ...readJsonSafe(settingsPath, {}) };
}

function saveSettingsFile(settings) {
  try {
    writeJsonSafe(settingsPath, settings);
  } catch (e) {
    console.error('Failed to save settings file:', e);
  }
}

function detectJava() {
  const candidates = [];
  if (process.env.JAVA_HOME) {
    candidates.push(path.join(process.env.JAVA_HOME, 'bin', 'javaw.exe'));
  }
  const roots = [
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Microsoft'
  ];
  for (const root of roots) {
    try {
      if (fs.existsSync(root)) {
        for (const dir of fs.readdirSync(root)) {
          candidates.push(path.join(root, dir, 'bin', 'javaw.exe'));
        }
      }
    } catch (e) {}
  }
  return candidates.find(p => fs.existsSync(p)) || '';
}

function writeJsonSafe(filePath, data) {
  const tmpPath = filePath + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Corrupt JSON file, backing it up instead of discarding it:', filePath, e);
    try {
      fs.copyFileSync(filePath, filePath + '.corrupt-' + Date.now());
    } catch (copyErr) {
      console.error('Could not back up corrupt file:', copyErr);
    }
    return fallback;
  }
}

function loadProfiles() {
  return readJsonSafe(profilesPath, []);
}

function saveProfiles(list) {
  try {
    writeJsonSafe(profilesPath, list);
  } catch (e) {
    console.error('Failed to save profiles file:', e);
  }
}

function folderForType(type) {
  if (type === 'resourcepack') return 'resourcepacks';
  if (type === 'shader') return 'shaderpacks';
  if (type === 'modpack') return 'modpacks';
  return 'mods';
}

const MODRINTH_HEADERS = { 'User-Agent': 'NexusClient/1.0 (contact: nexus-client@localhost)' };

async function modrinthSearch(query, type, loader, mcVersion, categories, offset, limit) {
  const facets = [[`project_type:${type}`]];
  if ((type === 'mod' || type === 'modpack') && loader && loader !== 'vanilla') facets.push([`categories:${loader}`]);
  if (mcVersion) facets.push([`versions:${mcVersion}`]);
  if (categories && categories.length) facets.push(categories.map(c => `categories:${c}`));
  const index = query && query.trim() ? 'relevance' : 'downloads';
  const url = 'https://api.modrinth.com/v2/search?query=' + encodeURIComponent(query || '') +
    '&index=' + index +
    '&limit=' + limit +
    '&offset=' + offset +
    '&facets=' + encodeURIComponent(JSON.stringify(facets));
  const res = await fetch(url, { headers: MODRINTH_HEADERS });
  if (!res.ok) throw new Error('Modrinth search failed: ' + res.status);
  const data = await res.json();
  return {
    results: data.hits.map(h => ({
      projectId: h.project_id,
      name: h.title,
      author: h.author,
      description: h.description,
      downloads: h.downloads,
      iconUrl: h.icon_url || null,
      type
    })),
    totalHits: data.total_hits
  };
}

let categoryCache = null;

async function fetchModrinthCategories() {
  if (categoryCache) return categoryCache;
  const res = await fetch('https://api.modrinth.com/v2/tag/category', { headers: MODRINTH_HEADERS });
  if (!res.ok) throw new Error('Modrinth categories failed: ' + res.status);
  categoryCache = await res.json();
  return categoryCache;
}

async function modrinthListVersions(projectId, loader, mcVersion, type) {
  let url = 'https://api.modrinth.com/v2/project/' + encodeURIComponent(projectId) + '/version?game_versions=' +
    encodeURIComponent(JSON.stringify([mcVersion]));
  if ((type === 'mod' || type === 'modpack') && loader && loader !== 'vanilla') {
    url += '&loaders=' + encodeURIComponent(JSON.stringify([loader]));
  }
  const res = await fetch(url, { headers: MODRINTH_HEADERS });
  if (!res.ok) throw new Error('Modrinth version lookup failed: ' + res.status);
  const versions = await res.json();
  versions.sort((a, b) => new Date(b.date_published) - new Date(a.date_published));
  return versions;
}

async function modrinthPickVersion(projectId, loader, mcVersion, type) {
  const versions = await modrinthListVersions(projectId, loader, mcVersion, type);
  return versions.length ? versions[0] : null;
}

async function installItemInternal(profileId, projectId, name, author, type, iconUrl) {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false, error: 'Profile not found.' };

  if (profile.loader === 'vanilla' && (type === 'mod' || type === 'modpack')) {
    return { success: false, error: "Vanilla profiles can't use mods or modpacks." };
  }

  const dir = path.join(profilesDir, profileId, folderForType(type));
  fs.mkdirSync(dir, { recursive: true });

  const version = await modrinthPickVersion(projectId, profile.loader, profile.mcVersion, type);
  if (!version) {
    return { success: false, error: 'No version of this project supports ' + profile.loader + ' ' + profile.mcVersion + '.' };
  }
  const file = version.files.find(f => f.primary) || version.files[0];
  if (!file) return { success: false, error: 'This version has no downloadable file.' };

  const dest = path.join(dir, file.filename);
  const dl = await fetch(file.url);
  if (!dl.ok) return { success: false, error: 'Download failed: ' + dl.status };
  fs.writeFileSync(dest, Buffer.from(await dl.arrayBuffer()));

  const item = {
    id: Date.now().toString() + Math.random().toString(36).slice(2, 7),
    projectId, versionId: version.id, name, author, type,
    fileName: file.filename, versionNumber: version.version_number,
    enabled: true, platform: 'modrinth', iconUrl: iconUrl || null
  };
  profile.items.push(item);
  saveProfiles(profiles);
  return { success: true, item };
}

function setItemFileEnabled(profileId, item, enabled) {
  const dir = path.join(profilesDir, profileId, folderForType(item.type));
  const enabledPath = path.join(dir, item.fileName);
  const disabledPath = enabledPath + '.disabled';
  try {
    if (enabled && fs.existsSync(disabledPath)) fs.renameSync(disabledPath, enabledPath);
    if (!enabled && fs.existsSync(enabledPath)) fs.renameSync(enabledPath, disabledPath);
  } catch (e) {
    console.error('Failed to toggle mod file:', e);
  }
}

function removeItemFile(profileId, item) {
  const dir = path.join(profilesDir, profileId, folderForType(item.type));
  const enabledPath = path.join(dir, item.fileName);
  const disabledPath = enabledPath + '.disabled';
  try {
    if (fs.existsSync(enabledPath)) fs.unlinkSync(enabledPath);
    if (fs.existsSync(disabledPath)) fs.unlinkSync(disabledPath);
  } catch (e) {
    console.error('Failed to remove mod file:', e);
  }
}

function compareVersions(a, b) {

  const pa = a.split('.').map(n => parseInt(n) || 0);
  const pb = b.split('.').map(n => parseInt(n) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

let vanillaCache = null;
let fabricCache = null;
let forgeCache = null;
let neoforgeCache = null;

async function fetchVanillaVersions() {
  if (vanillaCache) return vanillaCache;
  const res = await fetch('https://launchermeta.mojang.com/mc/game/version_manifest_v2.json');
  const manifest = await res.json();
  vanillaCache = manifest.versions
    .filter(v => v.type === 'release' || v.type === 'snapshot')
    .map(v => ({ id: v.id, type: v.type }));
  return vanillaCache;
}

async function fetchFabricVersions() {
  if (fabricCache) return fabricCache;
  const res = await fetch('https://meta.fabricmc.net/v2/versions/game');
  const games = await res.json();
  fabricCache = games.map(g => ({ id: g.version, type: g.stable ? 'release' : 'snapshot' }));
  return fabricCache;
}

async function fetchForgeVersions() {
  if (forgeCache) return forgeCache;
  const res = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json');
  const data = await res.json();
  const map = {};
  for (const key of Object.keys(data.promos)) {
    const isRecommended = key.endsWith('-recommended');
    const isLatest = key.endsWith('-latest');
    if (!isRecommended && !isLatest) continue;
    const mcVersion = key.replace('-recommended', '').replace('-latest', '');
    if (!map[mcVersion] || isRecommended) {
      map[mcVersion] = data.promos[key];
    }
  }
  forgeCache = Object.keys(map)
    .map(mc => ({ id: mc, type: 'release', loaderVersion: map[mc] }))
    .sort((a, b) => compareVersions(b.id, a.id));
  return forgeCache;
}

async function fetchNeoForgeVersions() {
  if (neoforgeCache) return neoforgeCache;
  const res = await fetch('https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml');
  const xml = await res.text();
  const versions = [...xml.matchAll(/<version>(.*?)<\/version>/g)].map(m => m[1]);
  const grouped = {};
  for (const v of versions) {
    if (v.includes('-beta')) continue;
    const parts = v.split('.');
    if (parts.length < 2) continue;
    const prefix = parts[0] + '.' + parts[1];
    if (!grouped[prefix]) grouped[prefix] = [];
    grouped[prefix].push(v);
  }
  const result = [];
  for (const prefix of Object.keys(grouped)) {
    const [major, minor] = prefix.split('.');
    const mcVersion = minor === '0' ? `1.${major}` : `1.${major}.${minor}`;
    const sorted = grouped[prefix].slice().sort(compareVersions);
    result.push({ id: mcVersion, type: 'release', loaderVersion: sorted[sorted.length - 1] });
  }
  neoforgeCache = result.sort((a, b) => compareVersions(b.id, a.id));
  return neoforgeCache;
}

let mainWindowRef = null;

function logConsole(profileId, line) {
  console.log('[' + profileId + '] ' + line);
  if (mainWindowRef && !mainWindowRef.isDestroyed() && profileId) {
    mainWindowRef.webContents.send('console-log', { profileId, time: Date.now(), text: String(line) });
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 920,
    minHeight: 620,
    backgroundColor: '#07060b',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindowRef = win;
  win.loadFile('index.html');
}

autoUpdater.on('update-downloaded', (info) => {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send('update-ready', { version: info.version });
  }
});

autoUpdater.on('error', (err) => {
  console.error('Auto-update error:', err);
});

ipcMain.handle('install-update', () => {
  autoUpdater.quitAndInstall();
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error('Auto-update check failed:', err);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

ipcMain.handle('login-microsoft', async () => {
  try {
    const xboxManager = await authManager.launch('electron', { width: 520, height: 650 });
    const mc = await xboxManager.getMinecraft();

    if (!mc || !mc.profile) {
      return { success: false, error: 'This account does not own Minecraft.' };
    }

    const mclc = mc.mclc(true);
    const data = upsertAccount(mclc);
    return {
      success: true,
      active: publicAccount({ uuid: mclc.uuid, name: mclc.name }),
      accounts: data.accounts.map(publicAccount)
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: (err && err.message) ? err.message : 'Login failed.' };
  }
});

ipcMain.handle('check-login', async () => {
  const data = loadAccountsFile();
  if (!data.activeUuid) return { success: false };

  const stored = data.accounts.find(a => a.uuid === data.activeUuid);
  if (!stored) return { success: false };

  try {
    let mc = tokenUtils.fromMclcToken(authManager, stored.token);
    mc = await mc.refresh(false);
    const mclc = mc.mclc(true);
    const updated = upsertAccount(mclc);
    return {
      success: true,
      active: publicAccount({ uuid: mclc.uuid, name: mclc.name }),
      accounts: updated.accounts.map(publicAccount)
    };
  } catch (err) {
    console.error('Session expired:', err);
    return { success: false, accounts: data.accounts.map(publicAccount) };
  }
});

ipcMain.handle('get-accounts', () => {
  const data = loadAccountsFile();
  return {
    activeUuid: data.activeUuid,
    accounts: data.accounts.map(publicAccount)
  };
});

ipcMain.handle('switch-account', async (event, uuid) => {
  const data = loadAccountsFile();
  const stored = data.accounts.find(a => a.uuid === uuid);
  if (!stored) return { success: false, error: 'Account not found.' };

  try {
    let mc = tokenUtils.fromMclcToken(authManager, stored.token);
    mc = await mc.refresh(false);
    const mclc = mc.mclc(true);
    const updated = upsertAccount(mclc);
    return {
      success: true,
      active: publicAccount({ uuid: mclc.uuid, name: mclc.name }),
      accounts: updated.accounts.map(publicAccount)
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'This session expired. Please sign in again.' };
  }
});

ipcMain.handle('remove-account', (event, uuid) => {
  const data = loadAccountsFile();
  data.accounts = data.accounts.filter(a => a.uuid !== uuid);
  if (data.activeUuid === uuid) {
    data.activeUuid = data.accounts.length ? data.accounts[0].uuid : null;
  }
  saveAccountsFile(data);
  return {
    activeUuid: data.activeUuid,
    accounts: data.accounts.map(publicAccount)
  };
});

ipcMain.handle('get-settings', () => {
  return {
    settings: loadSettings(),
    totalRamMB: Math.round(os.totalmem() / (1024 * 1024)),
    freeRamMB: Math.round(os.freemem() / (1024 * 1024))
  };
});

ipcMain.handle('save-settings', (event, settings) => {
  const merged = { ...loadSettings(), ...settings };
  saveSettingsFile(merged);
  return { success: true, settings: merged };
});

ipcMain.handle('detect-java', () => {
  return { path: detectJava() };
});

ipcMain.handle('browse-java', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Select javaw.exe',
    filters: [{ name: 'Java executable', extensions: ['exe'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { path: '' };
  return { path: result.filePaths[0] };
});

ipcMain.handle('get-loader-versions', async (event, loader) => {
  try {
    if (loader === 'vanilla') return { success: true, versions: await fetchVanillaVersions() };
    if (loader === 'fabric') return { success: true, versions: await fetchFabricVersions() };
    if (loader === 'forge') return { success: true, versions: await fetchForgeVersions() };
    if (loader === 'neoforge') return { success: true, versions: await fetchNeoForgeVersions() };
    return { success: false, error: 'Unknown loader.' };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'Could not fetch versions. Check your internet connection.' };
  }
});

ipcMain.handle('get-profiles', () => {
  return loadProfiles();
});

ipcMain.handle('create-profile', async (event, { name, loader, mcVersion, icon }) => {
  const profiles = loadProfiles();
  const profile = {
    id: Date.now().toString(),
    name: name.slice(0, 32),
    loader,
    mcVersion,
    icon: icon || null,
    items: [],
    createdAt: new Date().toISOString()
  };
  profiles.push(profile);
  saveProfiles(profiles);
  return profile;
});

ipcMain.handle('pick-profile-icon', async () => {
  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Choose profile icon',
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile']
  });
  if (result.canceled || !result.filePaths.length) return { dataUrl: null };
  try {
    const filePath = result.filePaths[0];
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    const buf = fs.readFileSync(filePath);
    if (buf.length > 3 * 1024 * 1024) {
      return { dataUrl: null, error: 'Image is too large (max 3 MB).' };
    }
    return { dataUrl: 'data:image/' + mime + ';base64,' + buf.toString('base64') };
  } catch (err) {
    console.error(err);
    return { dataUrl: null, error: 'Could not read that image.' };
  }
});

ipcMain.handle('rename-profile', (event, { profileId, name }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false };
  profile.name = name.slice(0, 32);
  saveProfiles(profiles);
  return { success: true };
});

ipcMain.handle('delete-profile', (event, profileId) => {
  const profiles = loadProfiles().filter(p => p.id !== profileId);
  saveProfiles(profiles);
  try {
    fs.rmSync(path.join(profilesDir, profileId), { recursive: true, force: true });
  } catch (e) {
    console.error('Failed to remove profile folder:', e);
  }
  return { success: true };
});

ipcMain.handle('toggle-item', (event, { profileId, itemId }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false };
  const item = profile.items.find(i => i.id === itemId);
  if (!item) return { success: false };
  item.enabled = !item.enabled;
  setItemFileEnabled(profileId, item, item.enabled);
  saveProfiles(profiles);
  return { success: true };
});

async function modrinthGetVersionById(versionId) {
  const res = await fetch('https://api.modrinth.com/v2/version/' + encodeURIComponent(versionId), { headers: MODRINTH_HEADERS });
  if (!res.ok) throw new Error('Modrinth version lookup failed: ' + res.status);
  return res.json();
}

ipcMain.handle('get-item-versions', async (event, { profileId, itemId }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false, error: 'Profile not found.' };
  const item = profile.items.find(i => i.id === itemId);
  if (!item) return { success: false, error: 'Item not found.' };

  try {
    const versions = await modrinthListVersions(item.projectId, profile.loader, profile.mcVersion, item.type);
    return {
      success: true,
      currentVersionId: item.versionId,
      loaderLabel: profile.loader,
      mcVersion: profile.mcVersion,
      versions: versions.map(v => ({
        id: v.id,
        versionNumber: v.version_number,
        versionType: v.version_type,
        datePublished: v.date_published,
        changelog: v.changelog || ''
      }))
    };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'Could not reach Modrinth. Check your internet connection.' };
  }
});

ipcMain.handle('set-item-version', async (event, { profileId, itemId, versionId }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false, error: 'Profile not found.' };
  const item = profile.items.find(i => i.id === itemId);
  if (!item) return { success: false, error: 'Item not found.' };

  try {
    const version = await modrinthGetVersionById(versionId);
    const file = version.files.find(f => f.primary) || version.files[0];
    if (!file) return { success: false, error: 'That version has no downloadable file.' };

    const dl = await fetch(file.url);
    if (!dl.ok) return { success: false, error: 'Download failed: ' + dl.status };
    const buf = Buffer.from(await dl.arrayBuffer());

    removeItemFile(profileId, item);

    const dir = path.join(profilesDir, profileId, folderForType(item.type));
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, file.filename);
    fs.writeFileSync(dest, buf);
    if (!item.enabled) fs.renameSync(dest, dest + '.disabled');

    item.versionId = version.id;
    item.versionNumber = version.version_number;
    item.fileName = file.filename;
    saveProfiles(profiles);
    logConsole(profileId, '[version] ' + item.name + ' switched to ' + version.version_number);
    return { success: true, item };
  } catch (err) {
    console.error(err);
    logConsole(profileId, '[version] ' + item.name + ': ' + (err && err.message ? err.message : String(err)));
    return { success: false, error: 'Could not change version. Check your internet connection.' };
  }
});

ipcMain.handle('remove-item', (event, { profileId, itemId }) => {
  const profiles = loadProfiles();
  const profile = profiles.find(p => p.id === profileId);
  if (!profile) return { success: false };
  const item = profile.items.find(i => i.id === itemId);
  if (item) removeItemFile(profileId, item);
  profile.items = profile.items.filter(i => i.id !== itemId);
  saveProfiles(profiles);
  return { success: true };
});

ipcMain.handle('search-content', async (event, { profileId, query, type, loader, mcVersion, categories, offset, limit }) => {
  try {
    const { results, totalHits } = await modrinthSearch(query, type, loader, mcVersion, categories || [], offset || 0, limit || 100);
    return { success: true, results, totalHits };
  } catch (err) {
    console.error(err);
    logConsole(profileId, '[search] ' + (err && err.message ? err.message : String(err)));
    return { success: false, error: 'Could not reach Modrinth. Check your internet connection.' };
  }
});

ipcMain.handle('get-categories', async (event, projectType) => {
  try {
    const all = await fetchModrinthCategories();
    const filtered = all.filter(c => c.project_type === projectType && c.header === 'categories');
    return { success: true, categories: filtered.map(c => ({ name: c.name, icon: c.icon || null })) };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'Could not load categories.' };
  }
});

ipcMain.handle('install-item', async (event, { profileId, projectId, name, author, type, iconUrl }) => {
  try {
    const res = await installItemInternal(profileId, projectId, name, author, type, iconUrl);
    if (!res.success) logConsole(profileId, '[install] ' + name + ': ' + res.error);
    return res;
  } catch (err) {
    console.error(err);
    logConsole(profileId, '[install] ' + name + ': ' + (err && err.message ? err.message : String(err)));
    return { success: false, error: 'Install failed. Check your internet connection.' };
  }
});

ipcMain.handle('list-profile-dir', (event, { profileId, relPath }) => {
  const base = path.resolve(path.join(profilesDir, profileId));
  const target = path.resolve(path.join(base, relPath || ''));

  if (target !== base && !target.startsWith(base + path.sep)) {
    return { success: false, error: 'Invalid path.' };
  }

  try {
    fs.mkdirSync(target, { recursive: true });
    const entries = fs.readdirSync(target, { withFileTypes: true });
    const items = entries
      .map(e => {
        const full = path.join(target, e.name);
        let st;
        try {
          st = fs.statSync(full);
        } catch (err) {
          return null;
        }
        let itemCount = null;
        if (e.isDirectory()) {
          try {
            itemCount = fs.readdirSync(full).length;
          } catch (err) {
            itemCount = 0;
          }
        }
        return {
          name: e.name,
          isDir: e.isDirectory(),
          size: e.isDirectory() ? null : st.size,
          itemCount,
          created: st.birthtime.getTime(),
          modified: st.mtime.getTime()
        };
      })
      .filter(Boolean)
      .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));

    return { success: true, items };
  } catch (err) {
    console.error(err);
    return { success: false, error: 'Could not read that folder.' };
  }
});

async function getFreshActiveToken() {
  const data = loadAccountsFile();
  if (!data.activeUuid) return null;
  const stored = data.accounts.find(a => a.uuid === data.activeUuid);
  if (!stored) return null;
  let mc = tokenUtils.fromMclcToken(authManager, stored.token);
  mc = await mc.refresh(false);
  const mclc = mc.mclc(true);
  upsertAccount(mclc);
  return mclc;
}

async function ensureFabricProfile(root, mcVersion) {
  const res = await fetch('https://meta.fabricmc.net/v2/versions/loader/' + encodeURIComponent(mcVersion), { headers: MODRINTH_HEADERS });
  if (!res.ok) throw new Error('Could not fetch Fabric loader list: ' + res.status);
  const list = await res.json();
  if (!list.length) throw new Error('Fabric has no loader builds for ' + mcVersion + '.');
  const stable = list.find(e => e.loader.stable) || list[0];
  const loaderVersion = stable.loader.version;
  const customId = 'fabric-loader-' + loaderVersion + '-' + mcVersion;
  const versDir = path.join(root, 'versions', customId);
  fs.mkdirSync(versDir, { recursive: true });
  const jsonPath = path.join(versDir, customId + '.json');
  if (!fs.existsSync(jsonPath)) {
    const profRes = await fetch(
      'https://meta.fabricmc.net/v2/versions/loader/' + encodeURIComponent(mcVersion) + '/' + encodeURIComponent(loaderVersion) + '/profile/json',
      { headers: MODRINTH_HEADERS }
    );
    if (!profRes.ok) throw new Error('Could not fetch Fabric profile data: ' + profRes.status);
    fs.writeFileSync(jsonPath, await profRes.text());
  }
  return customId;
}

async function ensureLoaderInstaller(root, loader, mcVersion) {
  const list = loader === 'forge' ? await fetchForgeVersions() : await fetchNeoForgeVersions();
  const entry = list.find(v => v.id === mcVersion);
  if (!entry || !entry.loaderVersion) throw new Error('No ' + loader + ' build found for Minecraft ' + mcVersion + '.');

  const dir = path.join(root, 'installers');
  fs.mkdirSync(dir, { recursive: true });

  let url, filename;
  if (loader === 'forge') {
    filename = 'forge-' + mcVersion + '-' + entry.loaderVersion + '-installer.jar';
    url = 'https://maven.minecraftforge.net/net/minecraftforge/forge/' + mcVersion + '-' + entry.loaderVersion + '/' + filename;
  } else {
    filename = 'neoforge-' + entry.loaderVersion + '-installer.jar';
    url = 'https://maven.neoforged.net/releases/net/neoforged/neoforge/' + entry.loaderVersion + '/' + filename;
  }

  const dest = path.join(dir, filename);
  if (!fs.existsSync(dest)) {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Could not download the ' + loader + ' installer: ' + res.status);
    fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
  }
  return dest;
}

function getJavaInfo(javaPath) {
  try {
    const { spawnSync } = require('child_process');
    const res = spawnSync(javaPath || 'java', ['-version'], { encoding: 'utf-8' });
    const text = (res.stderr || '') + (res.stdout || '');

    let is64 = null;
    if (/64-Bit/i.test(text)) is64 = true;
    else if (/32-Bit/i.test(text)) is64 = false;

    let major = null;
    const m = text.match(/version "(\d+)(?:\.(\d+))?/);
    if (m) {
      const first = parseInt(m[1], 10);
      // Old scheme: "1.8.0_251" means Java 8 -> major is the second number.
      // New scheme: "21.0.3" means Java 21 -> major is the first number.
      major = first === 1 ? parseInt(m[2] || '0', 10) : first;
    }

    return { is64, major, raw: text };
  } catch (e) {
    return { is64: null, major: null, raw: '' };
  }
}

const MIN_JAVA_MAJOR = 21;

async function buildLaunchOptions(profile, settings, authorization, resolvedJavaPath, java64) {
  const root = path.join(profilesDir, profile.id);
  fs.mkdirSync(root, { recursive: true });

  const systemTotalMB = Math.round(os.totalmem() / (1024 * 1024));
  const JAVA_32BIT_HEAP_CAP_MB = 1536;
  const effectiveCap = java64 === true ? Math.max(1024, systemTotalMB - 1024) : JAVA_32BIT_HEAP_CAP_MB;
  const safeMax = Math.min(settings.ramMB, effectiveCap);
  const safeMin = Math.min(1024, safeMax);

  const opts = {
    authorization,
    root,
    version: { number: profile.mcVersion, type: 'release' },
    memory: {
      max: safeMax + 'M',
      min: safeMin + 'M'
    },
    window: settings.fullscreen
      ? { fullscreen: true }
      : { width: settings.resolutionWidth, height: settings.resolutionHeight }
  };

  if (resolvedJavaPath) opts.javaPath = resolvedJavaPath;

  if (profile.loader === 'fabric') {
    opts.version.custom = await ensureFabricProfile(root, profile.mcVersion);
  } else if (profile.loader === 'forge' || profile.loader === 'neoforge') {
    opts.forge = await ensureLoaderInstaller(root, profile.loader, profile.mcVersion);
  }

  return opts;
}

const launchingProfiles = new Set();

ipcMain.handle('launch-game', async (event, { profileId }) => {
  if (launchingProfiles.has(profileId)) {
    return { success: false, error: 'This profile is already launching. Check the Logs tab for progress.' };
  }
  launchingProfiles.add(profileId);

  let profileName = profileId;
  try {
    const profiles = loadProfiles();
    const profile = profiles.find(p => p.id === profileId);
    if (!profile) return { success: false, error: 'Profile not found.' };
    profileName = profile.name;

    const authorization = await getFreshActiveToken();
    if (!authorization) return { success: false, error: 'Sign in with Microsoft first.' };

    const settings = loadSettings();
    logConsole(profileId, '[launch] Preparing ' + profile.name + ' (' + profile.loader + ' ' + profile.mcVersion + ')...');

    let resolvedJavaPath = settings.javaPath;
    if (!resolvedJavaPath) {
      resolvedJavaPath = detectJava();
      if (resolvedJavaPath) {
        logConsole(profileId, '[launch] Using detected Java: ' + resolvedJavaPath);
      } else {
        logConsole(profileId, '[launch] No Java auto-detected. Falling back to "java" on PATH — if this fails, set a Java path in Settings.');
      }
    }

    const javaInfo = getJavaInfo(resolvedJavaPath);

    if (javaInfo.major !== null && javaInfo.major < MIN_JAVA_MAJOR) {
      const msg = 'This Java (version ' + javaInfo.major + ') is too old for modern Minecraft, which needs Java ' + MIN_JAVA_MAJOR + ' or newer. Install a current JDK from https://adoptium.net, then set its path in Settings.';
      logConsole(profileId, '[launch] ' + msg);
      launchingProfiles.delete(profileId);
      return { success: false, error: msg };
    }

    if (javaInfo.is64 === false) {
      logConsole(profileId, '[launch] This Java is 32-bit, which cannot use large amounts of RAM. Memory will be capped to 1536MB. For more RAM, install 64-bit Java from https://adoptium.net and set its path in Settings.');
    } else if (javaInfo.is64 === null) {
      logConsole(profileId, '[launch] Could not determine if this Java is 32-bit or 64-bit, so memory is being capped to 1536MB to be safe. If you know it\'s 64-bit, this cap can be loosened later.');
    }

    const opts = await buildLaunchOptions(profile, settings, authorization, resolvedJavaPath, javaInfo.is64);
    const launcher = new MCLCClient();

    launcher.on('debug', (e) => logConsole(profileId, '[debug] ' + e));
    launcher.on('data', (e) => logConsole(profileId, String(e).trim()));
    launcher.on('progress', (e) => {
      if (e && e.type) logConsole(profileId, '[download] ' + e.type + ' ' + e.task + '/' + e.total);
    });
    launcher.on('close', (code) => {
      logConsole(profileId, '[launch] Minecraft closed (exit code ' + code + ').');
      launchingProfiles.delete(profileId);
    });

    await launcher.launch(opts);
    logConsole(profileId, '[launch] Launch command sent. Minecraft should open shortly.');
    return { success: true };
  } catch (err) {
    console.error(err);
    logConsole(profileId, '[launch] ' + (err && err.message ? err.message : String(err)));
    launchingProfiles.delete(profileId);
    return { success: false, error: (err && err.message) ? err.message : 'Launch failed.' };
  }
});

ipcMain.handle('get-selected-version', () => {
  const s = loadSettings();
  return {
    loader: s.selectedLoader,
    mcVersion: s.selectedMcVersion,
    loaderVersion: s.selectedLoaderVersion
  };
});

ipcMain.handle('set-selected-version', (event, sel) => {
  const s = loadSettings();
  s.selectedLoader = sel.loader;
  s.selectedMcVersion = sel.mcVersion;
  s.selectedLoaderVersion = sel.loaderVersion || null;
  saveSettingsFile(s);
  return { success: true };
});
