// Streaming sha256 helpers (no full-file buffering).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

export class Hasher {
  constructor() {
    this._hash = createHash('sha256');
    this._size = 0;
  }

  update(chunk) {
    this._hash.update(chunk);
    this._size += chunk.length;
    return this;
  }

  get size() {
    return this._size;
  }

  digestHex() {
    return this._hash.digest('hex');
  }
}

export function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

export function sha256File(file, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('操作已取消'));
      return;
    }
    const hash = createHash('sha256');
    const stream = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 });
    const onAbort = () => stream.destroy(new Error('操作已取消'));
    signal?.addEventListener('abort', onAbort, { once: true });
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', (err) => {
      signal?.removeEventListener('abort', onAbort);
      reject(err);
    });
    stream.on('end', () => {
      signal?.removeEventListener('abort', onAbort);
      resolve(hash.digest('hex'));
    });
  });
}
