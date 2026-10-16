import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { publishBigFile, MANIFEST_BRANCH, MANIFEST_PATH } from '../src/engine/bigfile/split.js';
import { pullBigFile, computeChunkOffsets } from '../src/engine/bigfile/pull.js';
import { isAbortError } from '../src/engine/proc.js';
import { sha256Buffer, sha256File } from '../src/engine/util/sha256.js';
import { deterministicBytes, git } from './fixtures/mkfixture.js';

async function setup() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-big-'));
  const remote = path.join(root, 'remote.git');
  await git(['init', '--bare', '--quiet', remote], root);
  return {
    root,
    remote,
    url: pathToFileURL(remote).href,
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}

async function readRemoteManifest(remote) {
  const res = await git(['show', `refs/heads/${MANIFEST_BRANCH}:${MANIFEST_PATH}`], remote);
  return JSON.parse(res.stdout);
}

const CHUNK = 1024 * 1024; // 1 MiB per chunk keeps the tests fast

test('computeChunkOffsets lays chunks out contiguously', () => {
  const offsets = computeChunkOffsets([
    { index: 0, size: 10 },
    { index: 1, size: 5 },
    { index: 2, size: 1 },
  ]);
  assert.deepEqual(offsets.map((c) => c.offset), [0, 10, 15]);
});

test('publish + pull roundtrip rebuilds the file byte for byte', async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'source.bin');
    const content = deterministicBytes(11, 12 * 1024 * 1024 + 12345); // not chunk-aligned
    await fsp.writeFile(source, content);

    const published = await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 4,
      chunkSize: CHUNK,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});
    assert.equal(published.chunks, 13);
    assert.equal(published.size, content.length);
    assert.equal(published.sha256, sha256Buffer(content));
    assert.equal(published.branches.length, 5); // manifest + 4 shards

    // The remote now carries the manifest and the shard branches.
    const branches = (await git(['branch', '--list'], env.remote)).stdout;
    assert.match(branches, /dl\/manifest/);
    assert.match(branches, /dl\/shard-0/);
    assert.match(branches, /dl\/shard-3/);

    const manifest = await readRemoteManifest(env.remote);
    assert.equal(manifest.file, 'source.bin');
    assert.equal(manifest.chunkSize, CHUNK);
    assert.deepEqual(manifest.chunks.map((c) => c.branch).sort(), [...manifest.chunks.map((c) => c.branch)].sort());

    const out = path.join(env.root, 'pulled.bin');
    const result = await pullBigFile({
      repoUrl: env.url,
      file: 'source.bin',
      out,
      concurrency: 4,
      workdir: path.join(env.root, 'pull-cache'),
    }, () => {});
    assert.equal(result.bytes, content.length);
    assert.equal(result.sha256, sha256Buffer(content));
    assert.equal(await sha256File(out), sha256Buffer(content), '拉取结果应与源文件逐字节一致');
  } finally {
    await env.cleanup();
  }
});

test('pull resumes from persisted chunk progress', async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'source.bin');
    const content = deterministicBytes(23, 12 * CHUNK);
    await fsp.writeFile(source, content);
    await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 4,
      chunkSize: CHUNK,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});
    const manifest = await readRemoteManifest(env.remote);
    const chunks = computeChunkOffsets(manifest.chunks);

    // Simulate an interrupted pull: part file pre-sized, first 3 chunks already
    // written and recorded in the metadata.
    const out = path.join(env.root, 'pulled.bin');
    const partPath = `${out}.part`;
    const metaPath = `${out}.dlmeta.json`;
    await fsp.writeFile(partPath, content); // identical layout: a "partial" file
    await fsp.writeFile(metaPath, JSON.stringify({
      version: 1,
      repoUrl: env.url,
      file: manifest.file,
      size: manifest.size,
      sha256: manifest.sha256,
      done: [0, 1, 2],
    }));

    const events = [];
    const result = await pullBigFile({
      repoUrl: env.url,
      file: 'source.bin',
      out,
      concurrency: 4,
      workdir: path.join(env.root, 'pull-cache'),
    }, (e) => events.push(e));

    assert.ok(
      events.some((e) => e.type === 'log' && /断点续传：已完成 3\/12 个分片/.test(e.text)),
      `应报告跳过已完成的分片：${JSON.stringify(events.filter((e) => e.type === 'log').map((e) => e.text))}`,
    );
    assert.equal(result.sha256, sha256Buffer(content));
    assert.equal(await sha256File(out), sha256Buffer(content));
    const leftovers = (await fsp.readdir(path.dirname(out))).filter((f) => f.endsWith('.part') || f.endsWith('.dlmeta.json'));
    assert.deepEqual(leftovers, [], '完成后不应残留临时文件');
    assert.ok(chunks.length === 12);
  } finally {
    await env.cleanup();
  }
});

test('an aborted pull keeps partial state and resumes cleanly', async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'source.bin');
    const content = deterministicBytes(31, 8 * CHUNK);
    await fsp.writeFile(source, content);
    await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 4,
      chunkSize: CHUNK,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});

    const out = path.join(env.root, 'pulled.bin');
    const controller = new AbortController();
    let aborted = false;
    const first = pullBigFile({
      repoUrl: env.url,
      file: 'source.bin',
      out,
      concurrency: 2,
      workdir: path.join(env.root, 'pull-cache'),
      signal: controller.signal,
    }, (event) => {
      // Deterministic interruption point: the read phase is about to start.
      if (!aborted && event.type === 'phase' && event.phase === 'verify') {
        aborted = true;
        controller.abort();
      }
    });
    try {
      await first;
      assert.fail('应因中止而失败');
    } catch (err) {
      assert.ok(isAbortError(err), `应产生 AbortError，实际：${err.message}`);
    }
    assert.equal(aborted, true);

    const entries = await fsp.readdir(path.dirname(out));
    assert.ok(entries.some((f) => f.endsWith('.part')), `应保留 .part：${entries.join(', ')}`);
    assert.ok(entries.some((f) => f.endsWith('.dlmeta.json')), '应保留断点元数据');

    const result = await pullBigFile({
      repoUrl: env.url,
      file: 'source.bin',
      out,
      concurrency: 4,
      workdir: path.join(env.root, 'pull-cache'),
    }, () => {});
    assert.equal(result.sha256, sha256Buffer(content));
    assert.equal(await sha256File(out), sha256Buffer(content));
  } finally {
    await env.cleanup();
  }
});

test('a tampered manifest is detected by chunk verification', async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'source.bin');
    const content = deterministicBytes(41, 4 * CHUNK);
    await fsp.writeFile(source, content);
    await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 2,
      chunkSize: CHUNK,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});

    // Rewrite the manifest on the remote with a wrong sha256 for chunk 1,
    // exactly like a corrupted/tampered transport would look.
    const manifest = await readRemoteManifest(env.remote);
    manifest.chunks[1].sha256 = 'ab'.repeat(32);
    const json = JSON.stringify(manifest, null, 2);
    const work = path.join(env.root, 'tamper');
    await fsp.mkdir(work, { recursive: true });
    await git(['init', '--quiet'], work);
    await git(['remote', 'add', 'origin', env.url], work);
    const blob = (await git(['hash-object', '-w', '--stdin'], work, { input: json })).stdout.trim();
    const tree = (await git(['mktree'], work, { input: `100644 blob ${blob}\tmanifest.json\n` })).stdout.trim();
    await git(['config', 'user.email', 't@example.test'], work);
    await git(['config', 'user.name', 'Tamper'], work);
    const commit = (await git(['commit-tree', tree, '-m', 'tampered'], work)).stdout.trim();
    await git(['push', '--force', 'origin', `${commit}:refs/heads/${MANIFEST_BRANCH}`], work);

    await assert.rejects(
      pullBigFile({
        repoUrl: env.url,
        file: 'source.bin',
        out: path.join(env.root, 'pulled.bin'),
        concurrency: 2,
        workdir: path.join(env.root, 'pull-cache'),
      }, () => {}),
      /分片 1 内容校验失败/,
    );
  } finally {
    await env.cleanup();
  }
});

test('pull refuses a manifest for a different file name', async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'source.bin');
    await fsp.writeFile(source, deterministicBytes(5, CHUNK));
    await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 1,
      chunkSize: CHUNK,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});
    await assert.rejects(
      pullBigFile({
        repoUrl: env.url,
        file: 'other.bin',
        out: path.join(env.root, 'out.bin'),
        workdir: path.join(env.root, 'pull-cache'),
      }, () => {}),
      /远端发布的文件是 source\.bin/,
    );
  } finally {
    await env.cleanup();
  }
});

// Full-size acceptance test (M5): run with GITDL_BIG=1 npm test
test('1 GiB roundtrip', { skip: process.env.GITDL_BIG !== '1' }, async () => {
  const env = await setup();
  try {
    const source = path.join(env.root, 'huge.bin');
    const size = 1024 * 1024 * 1024;
    const handle = await fsp.open(source, 'w');
    try {
      const piece = deterministicBytes(99, 8 * 1024 * 1024);
      for (let written = 0; written < size; written += piece.length) {
        const remaining = Math.min(piece.length, size - written);
        await handle.write(piece, 0, remaining);
      }
    } finally {
      await handle.close();
    }

    const published = await publishBigFile({
      file: source,
      repoUrl: env.url,
      shards: 8,
      chunkSize: 32 * 1024 * 1024,
      workdir: path.join(env.root, 'push-work'),
    }, () => {});
    assert.equal(published.chunks, 32);
    assert.equal(published.size, size);

    const out = path.join(env.root, 'pulled.bin');
    const result = await pullBigFile({
      repoUrl: env.url,
      file: 'huge.bin',
      out,
      concurrency: 8,
      workdir: path.join(env.root, 'pull-cache'),
    }, () => {});
    assert.equal(result.bytes, size);
    assert.equal(await sha256File(out), published.sha256);
  } finally {
    await env.cleanup();
  }
});
