// Persistent task registry. Tasks survive restarts; anything that was running
// when the app died comes back as "interrupted" and can be resumed, because
// every engine mode is written to be restart-safe.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic, readJson } from '../engine/util/fsx.js';
import { makeThrottled } from '../engine/util/throttle.js';

const STORE_VERSION = 1;

export class TaskStore {
  constructor(file) {
    this.file = file;
    this.tasks = new Map(); // id -> record
    this.persist = makeThrottled(() => this.flush(), 500);
  }

  async load() {
    const data = await readJson(this.file, null);
    if (data?.version === STORE_VERSION && Array.isArray(data.tasks)) {
      for (const task of data.tasks) {
        if (task.state === 'running' || task.state === 'paused') task.state = 'interrupted';
        this.tasks.set(task.id, task);
      }
    }
    return this;
  }

  upsert(record) {
    this.tasks.set(record.id, { ...record, updatedAt: new Date().toISOString() });
    this.persist();
  }

  get(id) {
    return this.tasks.get(id) ?? null;
  }

  remove(id) {
    this.tasks.delete(id);
    this.persist();
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async flush() {
    await fsp.mkdir(path.dirname(this.file), { recursive: true });
    await writeJsonAtomic(this.file, { version: STORE_VERSION, tasks: this.list() });
  }
}
