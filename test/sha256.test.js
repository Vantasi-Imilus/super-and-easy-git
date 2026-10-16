import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Hasher, sha256Buffer, sha256File } from '../src/engine/util/sha256.js';
import { deterministicBytes } from './fixtures/mkfixture.js';

test('sha256Buffer matches the known answer', () => {
  assert.equal(sha256Buffer(Buffer.from('abc')), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('Hasher streams to the same digest as a one-shot hash', () => {
  const parts = [deterministicBytes(1, 1000), deterministicBytes(2, 5000), deterministicBytes(3, 1)];
  const total = Buffer.concat(parts);
  const hasher = new Hasher();
  for (const p of parts) hasher.update(p);
  assert.equal(hasher.digestHex(), sha256Buffer(total));
  assert.equal(hasher.size, total.length);
});

test('sha256File hashes file contents and reports abort', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-sha-'));
  const file = path.join(dir, 'blob.bin');
  const content = deterministicBytes(42, 300000);
  await fsp.writeFile(file, content);
  assert.equal(await sha256File(file), sha256Buffer(content));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(sha256File(file, { signal: controller.signal }));
  await fsp.rm(dir, { recursive: true, force: true });
});
