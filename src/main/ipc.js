// IPC surface. Every handler runs in the main process; the renderer reaches
// them exclusively through the contextBridge API in src/preload.cjs. All
// payloads are validated here because the renderer must be treated as
// untrusted input.
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { detectGit } from '../engine/git-detect.js';
import { parseMirrorRules, formatMirrorRules } from '../engine/util/mirror.js';

const MODES = new Set(['single', 'batch', 'http', 'bigfile-pull', 'bigfile-push']);

function asString(value, max = 4096) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function asInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function asBool(value) {
  return value === true || value === 'true';
}

function sanitizeOpts(mode, raw) {
  if (!raw || typeof raw !== 'object') throw new Error('参数无效');
  const opts = {};
  const filter = asString(raw.filter, 64);
  if (filter && filter !== 'none') opts.filter = filter;
  if (raw.depth !== undefined && raw.depth !== '') opts.depth = asInt(raw.depth, 0, 1000000, 0);
  if (raw.jobs !== undefined) opts.jobs = asInt(raw.jobs, 1, 64, 4);
  if (raw.concurrency !== undefined) opts.concurrency = asInt(raw.concurrency, 1, 64, 4);
  if (raw.shards !== undefined) opts.shards = asInt(raw.shards, 1, 1024, 8);
  if (raw.chunkSize !== undefined) opts.chunkSize = asInt(raw.chunkSize, 1024 * 1024, 512 * 1024 * 1024, 32 * 1024 * 1024);
  if (raw.branches !== undefined) opts.branches = raw.branches === 'default' ? 'default' : 'all';
  if (raw.includeTags !== undefined) opts.includeTags = asBool(raw.includeTags);
  if (raw.recursiveSubmodules !== undefined) opts.recursiveSubmodules = asBool(raw.recursiveSubmodules);
  if (raw.overwrite !== undefined) opts.overwrite = asBool(raw.overwrite);
  opts.gitPath = asString(raw.gitPath, 512) || undefined;
  opts.proxy = asString(raw.proxy, 512) || null;

  if (mode === 'batch') {
    const urls = Array.isArray(raw.urls)
      ? raw.urls.map((u) => asString(u, 2048)).filter(Boolean)
      : asString(raw.urls, 1024 * 1024).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    if (urls.length === 0) throw new Error('请至少提供一个仓库地址');
    if (urls.length > 2000) throw new Error('一次最多 2000 个仓库');
    opts.urls = urls.slice(0, 2000);
    opts.baseDir = asString(raw.baseDir, 1024) || process.cwd();
    opts.concurrency = asInt(raw.concurrency, 1, 32, 3);
    opts.retries = asInt(raw.retries, 0, 10, 2);
    opts.repoOptions = {
      depth: opts.depth ?? 0,
      filter: opts.filter ?? null,
      jobs: asInt(raw.jobs, 1, 64, 4),
      includeTags: opts.includeTags !== false,
      recursiveSubmodules: opts.recursiveSubmodules === true,
    };
    return opts;
  }
  if (mode === 'single') {
    opts.url = asString(raw.url, 2048);
    if (!opts.url) throw new Error('请填写仓库地址');
    opts.baseDir = asString(raw.baseDir, 1024) || process.cwd();
    if (asString(raw.dir, 1024)) opts.dir = asString(raw.dir, 1024);
    const ref = asString(raw.checkoutRef, 256);
    if (ref) opts.checkoutRef = ref;
    opts.depth = opts.depth ?? 0;
    opts.jobs = opts.jobs ?? 4;
    opts.branches = opts.branches ?? 'all';
    opts.includeTags = opts.includeTags !== false;
    return opts;
  }
  if (mode === 'http') {
    opts.url = asString(raw.url, 2048);
    if (!opts.url) throw new Error('请填写下载地址');
    opts.dir = asString(raw.dir, 1024) || app.getPath('downloads');
    opts.concurrency = opts.concurrency ?? 4;
    const sha = asString(raw.expectedSha256, 64).toLowerCase();
    if (sha) {
      if (!/^[0-9a-f]{64}$/.test(sha)) throw new Error('sha256 需为 64 位十六进制');
      opts.expectedSha256 = sha;
    }
    if (asString(raw.filename, 256)) opts.filename = asString(raw.filename, 256);
    return opts;
  }
  if (mode === 'bigfile-pull') {
    opts.repoUrl = asString(raw.repoUrl, 2048);
    opts.file = asString(raw.file, 256);
    opts.out = asString(raw.out, 1024);
    if (!opts.repoUrl || !opts.file || !opts.out) throw new Error('仓库地址、文件名与输出路径均不能为空');
    opts.concurrency = opts.concurrency ?? 8;
    return opts;
  }
  if (mode === 'bigfile-push') {
    opts.file = asString(raw.file, 1024);
    opts.repoUrl = asString(raw.repoUrl, 2048);
    if (!opts.file || !opts.repoUrl) throw new Error('本地文件与目标仓库均不能为空');
    opts.shards = opts.shards ?? 8;
    opts.chunkSize = opts.chunkSize ?? 32 * 1024 * 1024;
    return opts;
  }
  throw new Error(`未知模式：${mode}`);
}

export function registerIpc({ host, settings }) {
  ipcMain.handle('ipc:ping', () => 'pong');
  ipcMain.handle('app:info', () => ({
    app: app.getName(),
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));

  ipcMain.handle('git:detect', async (_event, gitPath) => {
    const usePath = asString(gitPath, 512) || settings.get().gitPath || 'git';
    const det = await detectGit(usePath);
    return {
      ok: det.ok,
      version: det.version ?? null,
      path: det.path ?? usePath,
      error: det.error ?? null,
      capabilities: det.capabilities ?? null,
    };
  });

  ipcMain.handle('task:list', () => host.list());
  ipcMain.handle('task:start', (_event, mode, opts) => {
    if (!MODES.has(mode)) throw new Error(`未知模式：${mode}`);
    return host.start(mode, sanitizeOpts(mode, opts));
  });
  ipcMain.handle('task:pause', (_event, id) => host.pause(asString(id, 128)));
  ipcMain.handle('task:resume', (_event, id) => host.resume(asString(id, 128)));
  ipcMain.handle('task:retry', (_event, id) => host.resume(asString(id, 128)));
  ipcMain.handle('task:cancel', (_event, id) => host.cancel(asString(id, 128)));
  ipcMain.handle('task:remove', (_event, id) => host.remove(asString(id, 128)));

  ipcMain.handle('settings:get', () => {
    const data = settings.get();
    return { ...data, mirrorRulesText: formatMirrorRules(data.mirrorRules) };
  });
  ipcMain.handle('settings:set', (_event, partial) => {
    const next = { ...(partial ?? {}) };
    if (typeof next.mirrorRulesText === 'string') {
      next.mirrorRules = parseMirrorRules(next.mirrorRulesText);
      delete next.mirrorRulesText;
    }
    return settings.set(next);
  });

  ipcMain.handle('dialog:pickDirectory', async (event, title) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: asString(title, 128) || '选择目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('dialog:pickFile', async (event, title) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showOpenDialog(win, {
      title: asString(title, 128) || '选择文件',
      properties: ['openFile'],
    });
    return res.canceled ? null : res.filePaths[0];
  });
  ipcMain.handle('dialog:pickSaveFile', async (event, defaultPath) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const res = await dialog.showSaveDialog(win, {
      title: '选择保存位置',
      defaultPath: asString(defaultPath, 1024) || undefined,
    });
    return res.canceled ? null : res.filePath;
  });
  ipcMain.handle('shell:reveal', (_event, target) => {
    const file = asString(target, 1024);
    if (file) shell.showItemInFolder(file);
    return true;
  });
}
