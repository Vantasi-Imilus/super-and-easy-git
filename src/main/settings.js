// User settings, persisted next to the task registry.
import { writeJsonAtomic, readJson } from '../engine/util/fsx.js';

const DEFAULTS = {
  gitPath: '',
  proxy: '',
  concurrency: 4,
  mirrorRules: [],
};

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

export class Settings {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULTS };
  }

  async load() {
    const stored = await readJson(this.file, null);
    if (stored && typeof stored === 'object') {
      this.data = this.#sanitize({ ...DEFAULTS, ...stored });
    }
    return this;
  }

  get() {
    return { ...this.data };
  }

  async set(partial) {
    this.data = this.#sanitize({ ...this.data, ...(partial ?? {}) });
    await writeJsonAtomic(this.file, this.data);
    return this.get();
  }

  #sanitize(input) {
    return {
      gitPath: String(input.gitPath ?? '').trim().slice(0, 512),
      proxy: String(input.proxy ?? '').trim().slice(0, 512),
      concurrency: clampInt(input.concurrency, 1, 64, DEFAULTS.concurrency),
      mirrorRules: Array.isArray(input.mirrorRules)
        ? input.mirrorRules
          .map((r) => ({ from: String(r?.from ?? '').trim(), to: String(r?.to ?? '').trim() }))
          .filter((r) => r.from && r.to)
          .slice(0, 32)
        : [],
    };
  }
}
