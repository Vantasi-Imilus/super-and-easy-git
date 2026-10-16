// Bridges the pure-Node engines to the Electron world: owns running tasks,
// forwards engine events to the renderer, persists task records, and raises
// completion notifications.
import { Notification } from 'electron';
import path from 'node:path';
import { downloadRepo } from '../engine/single-repo.js';
import { downloadBatch } from '../engine/batch.js';
import { httpDownload } from '../engine/http/downloader.js';
import { publishBigFile } from '../engine/bigfile/split.js';
import { pullBigFile } from '../engine/bigfile/pull.js';
import { isAbortError } from '../engine/proc.js';
import { applyMirrorRules } from '../engine/util/mirror.js';

let sequence = 0;
function nextId() {
  sequence += 1;
  return `task-${Date.now().toString(36)}-${sequence}`;
}

export class EngineHost {
  constructor({ store, settings, broadcast }) {
    this.store = store;
    this.settings = settings;
    this.broadcast = broadcast;
    this.running = new Map(); // id -> { controller, mode, opts, record }
  }

  list() {
    return this.store.list();
  }

  // Returns the full task record; events stream through `broadcast`.
  start(mode, rawOpts) {
    const opts = this.#normalizeOpts(mode, rawOpts);
    const id = nextId();
    const record = {
      id,
      mode,
      title: this.#title(mode, opts),
      subtitle: this.#subtitle(mode, opts),
      state: 'running',
      error: null,
      createdAt: new Date().toISOString(),
      startedAt: Date.now(),
      finishedAt: null,
      elapsedMs: null,
      result: null,
      progress: null,
      progressText: null,
      connections: null,
      opts,
    };
    this.store.upsert(record);
    this.#emitTask(record);
    this.#run(record).catch((err) => {
      // #run handles its own errors; this is a safety net.
      this.#fail(record, err);
    });
    return this.#public(record);
  }

  pause(id) {
    const running = this.running.get(id);
    const record = this.store.get(id);
    if (!running || !record) return this.#public(record);
    record.paused = true;
    running.controller.abort();
    return this.#public(record);
  }

  resume(id) {
    const record = this.store.get(id);
    if (!record) throw new Error(`任务不存在：${id}`);
    if (this.running.has(id)) return this.#public(record);
    record.state = 'running';
    record.error = null;
    record.paused = false;
    record.startedAt = Date.now();
    record.progress = null;
    record.progressText = null;
    this.store.upsert(record);
    this.#emitTask(record);
    this.#run(record).catch((err) => this.#fail(record, err));
    return this.#public(record);
  }

  cancel(id) {
    const running = this.running.get(id);
    const record = this.store.get(id);
    if (!record) return null;
    record.cancelled = true;
    running?.controller.abort();
    record.state = 'cancelled';
    record.finishedAt = Date.now();
    this.store.upsert(record);
    this.#emitTask(record);
    return this.#public(record);
  }

  remove(id) {
    const running = this.running.get(id);
    running?.controller.abort();
    this.store.remove(id);
    return { id, removed: true };
  }

  // ---------------------------------------------------------------------------
  #normalizeOpts(mode, rawOpts) {
    const opts = { ...(rawOpts ?? {}) };
    const settings = this.settings.get();
    if (!opts.gitPath) opts.gitPath = settings.gitPath || undefined;
    if (opts.proxy === undefined) opts.proxy = settings.proxy || null;
    if (!opts.concurrency && !opts.jobs) {
      opts.concurrency = settings.concurrency || 4;
      opts.jobs = settings.concurrency || 4;
    }
    if (opts.url && !opts.allowLocal) opts.url = applyMirrorRules(opts.url, settings.mirrorRules);
    if (Array.isArray(opts.urls)) {
      opts.urls = opts.urls.map((u) => applyMirrorRules(u, settings.mirrorRules));
    }
    return opts;
  }

  #title(mode, opts) {
    if (mode === 'batch') return `批量下载（${opts.urls.length} 个仓库）`;
    if (mode === 'bigfile-push') return `发布 ${path.basename(opts.file ?? '')}`;
    if (mode === 'bigfile-pull') return `拉取 ${opts.file ?? ''}`;
    if (mode === 'http') return `HTTP 下载 ${this.#shortUrl(opts.url)}`;
    return `克隆 ${this.#shortUrl(opts.url)}`;
  }

  #subtitle(mode, opts) {
    if (mode === 'batch') return opts.baseDir ?? '';
    if (mode === 'http') return opts.dir ?? '';
    if (mode === 'bigfile-push') return opts.repoUrl ?? '';
    if (mode === 'bigfile-pull') return opts.out ?? '';
    return opts.dir ?? opts.baseDir ?? '';
  }

  #shortUrl(url) {
    const text = String(url ?? '');
    return text.length > 60 ? `${text.slice(0, 57)}…` : text;
  }

  #public(record) {
    if (!record) return null;
    const { opts, ...rest } = record;
    return {
      ...rest,
      optsSummary: {
        depth: opts?.depth ?? null,
        filter: opts?.filter ?? null,
        jobs: opts?.jobs ?? null,
        concurrency: opts?.concurrency ?? null,
        dir: opts?.dir ?? opts?.out ?? opts?.baseDir ?? null,
      },
    };
  }

  #emitTask(record) {
    this.broadcast({ type: 'task', task: this.#public(record) });
  }

  #emitEvent(id, payload) {
    this.broadcast({ ...payload, taskId: id });
  }

  #complete(record, result) {
    record.state = 'done';
    record.result = result;
    record.finishedAt = Date.now();
    record.elapsedMs = record.finishedAt - (record.startedAt ?? record.finishedAt);
    record.progress = 1;
    record.progressText = '完成';
    this.store.upsert(record);
    this.#emitTask(record);
    this.#notify(record);
  }

  #fail(record, err) {
    if (record.cancelled) return;
    if (record.paused || isAbortError(err)) {
      record.state = 'paused';
      record.progressText = '已暂停';
      record.error = null;
    } else {
      record.state = 'failed';
      record.error = err?.message ?? String(err);
      record.finishedAt = Date.now();
    }
    this.store.upsert(record);
    this.#emitTask(record);
  }

  #notify(record) {
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title: '下载完成', body: record.title }).show();
    } catch {
      /* notifications are best-effort */
    }
  }

  async #run(record) {
    const { id, mode, opts } = record;
    const controller = new AbortController();
    this.running.set(id, { controller, mode, opts, record });
    const signal = controller.signal;

    const forward = (prefix) => (event) => {
      const payload = prefix ? prefix(event) : event;
      if (!payload) return;
      if (payload.type === 'progress') {
        record.progress = payload.snapshot?.percent ?? payload.percent ?? record.progress;
        record.progressText = payload.text ?? record.progressText;
        record.connections = payload.snapshot?.connections ?? payload.connections ?? record.connections;
        this.#emitEvent(id, payload);
      } else if (payload.type === 'log') {
        this.#emitEvent(id, payload);
      } else if (payload.type === 'task' || payload.type === 'aggregate') {
        this.#emitEvent(id, payload);
      } else if (payload.type === 'phase') {
        record.progressText = payload.text;
        this.#emitEvent(id, payload);
      } else if (payload.type === 'fallback') {
        this.#emitEvent(id, { type: 'log', level: 'warn', text: payload.text });
      } else if (payload.type === 'plan' || payload.type === 'worker') {
        this.#emitEvent(id, payload);
      }
    };

    try {
      let result;
      if (mode === 'single') {
        const { url, baseDir, ...rest } = opts;
        result = await downloadRepo({ url, baseDir, ...rest, signal }, forward(null));
      } else if (mode === 'batch') {
        const { urls, baseDir, concurrency, repoOptions = {}, retries } = opts;
        result = await downloadBatch({
          urls,
          baseDir,
          concurrency,
          retries,
          repoOptions: { ...repoOptions, signal },
          signal,
        }, forward(null));
      } else if (mode === 'http') {
        result = await httpDownload({ ...opts, signal }, forward(null));
      } else if (mode === 'bigfile-push') {
        result = await publishBigFile({ ...opts, signal }, forward(null));
      } else if (mode === 'bigfile-pull') {
        result = await pullBigFile({ ...opts, signal }, forward(null));
      } else {
        throw new Error(`未知模式：${mode}`);
      }
      if (controller.signal.aborted) {
        // Aborted right at the finish line: treat as paused, not done.
        this.#fail(record, Object.assign(new Error('已暂停'), { name: 'AbortError' }));
      } else {
        this.#complete(record, result);
      }
    } catch (err) {
      this.#fail(record, err);
    } finally {
      this.running.delete(id);
      record.paused = false;
    }
  }
}
