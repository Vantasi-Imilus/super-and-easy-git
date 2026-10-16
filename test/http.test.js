import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpDownload, SpeedMeter } from '../src/engine/http/downloader.js';
import { parseContentDisposition } from '../src/engine/http/probe.js';
import { isAbortError } from '../src/engine/proc.js';
import { sha256Buffer } from '../src/engine/util/sha256.js';
import { startHttpServer } from './fixtures/httpserver.js';

async function tmpdir() {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-http-'));
}

test('SpeedMeter computes a sliding-window rate and forgets old samples', () => {
  const meter = new SpeedMeter(3000);
  assert.equal(meter.rate(1000), null, '少于两个样本时无速率');
  meter.add(0, 1000);
  meter.add(1024 * 1024, 2000);
  assert.equal(meter.rate(2000), 1024 * 1024); // 1 MiB over 1s
  meter.add(2 * 1024 * 1024, 5000); // 5s 后：旧样本被挤出 3s 窗口
  const rate = meter.rate(5000);
  assert.ok(rate > 0);
  meter.reset();
  assert.equal(meter.rate(6000), null);
});

test('parseContentDisposition handles plain, quoted and RFC 5987 names', () => {
  assert.equal(parseContentDisposition('attachment; filename="a.bin"'), 'a.bin');
  assert.equal(parseContentDisposition('attachment; filename=plain.zip'), 'plain.zip');
  assert.equal(parseContentDisposition("attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin"), '测试.bin');
  assert.equal(parseContentDisposition(null), null);
  assert.equal(parseContentDisposition('inline'), null);
});

test('segmented download uses multiple range requests and verifies sha256', async () => {
  const srv = await startHttpServer({ size: 6 * 1024 * 1024, drip: { chunkSize: 256 * 1024, delayMs: 20 } });
  const dir = await tmpdir();
  try {
    const events = [];
    const result = await httpDownload({
      url: srv.url(),
      dir,
      concurrency: 4,
      expectedSha256: sha256Buffer(srv.content),
    }, (e) => events.push(e));

    assert.equal(result.bytes, srv.content.length);
    assert.equal(result.skipped, false);
    const onDisk = await fsp.readFile(result.file);
    assert.equal(sha256Buffer(onDisk), sha256Buffer(srv.content));
    assert.ok(srv.stats.rangeRequests >= 4, `应发出多个 Range 请求（实际 ${srv.stats.rangeRequests}）`);

    const snaps = events.filter((e) => e.type === 'progress').map((e) => e.snapshot);
    const last = snaps[snaps.length - 1];
    assert.equal(last.percent, 1);
    assert.ok(snaps.some((s) => s.segments && s.segments.length === 4), '应报告 4 个分片');
    assert.ok(snaps.some((s) => s.bytesPerSec > 0), '应报告下载速度');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('interrupted download resumes from the persisted offsets', async () => {
  const srv = await startHttpServer({ size: 8 * 1024 * 1024, drip: { chunkSize: 256 * 1024, delayMs: 25 } });
  const dir = await tmpdir();
  const controller = new AbortController();
  try {
    let aborted = false;
    let sawPartFiles = false;
    const first = httpDownload({
      url: srv.url(),
      dir,
      concurrency: 4,
      signal: controller.signal,
    }, (e) => {
      if (!aborted && e.type === 'progress' && e.snapshot.bytes > 512 * 1024) {
        aborted = true;
        controller.abort();
      }
    });
    try {
      await first;
    } catch (err) {
      assert.ok(isAbortError(err), `中断应产生 AbortError，实际：${err.message}`);
    }
    assert.equal(aborted, true, '应在传输过程中成功中断');

    const entries = await fsp.readdir(dir);
    sawPartFiles = entries.some((f) => f.endsWith('.part')) && entries.some((f) => f.endsWith('.dlmeta.json'));
    assert.ok(sawPartFiles, `中断后应保留 .part 与元数据：${entries.join(', ')}`);

    const servedBefore = srv.stats.bytesServed;
    assert.ok(servedBefore < srv.content.length, '中断时不应已传输完整文件');

    const result = await httpDownload({ url: srv.url(), dir, concurrency: 4 }, () => {});
    const onDisk = await fsp.readFile(result.file);
    assert.equal(sha256Buffer(onDisk), sha256Buffer(srv.content), '续传后的文件应与源一致');

    const servedTotal = srv.stats.bytesServed;
    assert.ok(
      servedTotal < srv.content.length * 2,
      `续传应复用已下载的数据（两次共传输 ${servedTotal} 字节，文件 ${srv.content.length} 字节）`,
    );

    const leftovers = (await fsp.readdir(dir)).filter((f) => f.endsWith('.part') || f.endsWith('.dlmeta.json'));
    assert.deepEqual(leftovers, [], '完成后不应残留临时文件');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('falls back to a single stream when the server ignores Range', async () => {
  const srv = await startHttpServer({ size: 2 * 1024 * 1024, lyingRange: true });
  const dir = await tmpdir();
  try {
    const events = [];
    const result = await httpDownload({ url: srv.url(), dir, concurrency: 4 }, (e) => events.push(e));
    const onDisk = await fsp.readFile(result.file);
    assert.equal(sha256Buffer(onDisk), sha256Buffer(srv.content));
    assert.ok(events.some((e) => e.type === 'log' && /回退为单连接/.test(e.text)), '应记录回退日志');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('no-range server is detected during the probe', async () => {
  const srv = await startHttpServer({ size: 1024 * 1024, supportRange: false });
  const dir = await tmpdir();
  try {
    const events = [];
    const result = await httpDownload({ url: srv.url(), dir, concurrency: 4 }, (e) => events.push(e));
    const onDisk = await fsp.readFile(result.file);
    assert.equal(sha256Buffer(onDisk), sha256Buffer(srv.content));
    assert.ok(events.some((e) => e.type === 'log' && /支持分段\/续传：否/.test(e.text)));
    assert.equal(srv.stats.rangeRequests, 0);
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('hostile Content-Disposition filenames never escape the target directory', async () => {
  const srv = await startHttpServer({
    size: 1024 * 512,
    disposition: 'attachment; filename="../../../evil.bin"',
  });
  const dir = await tmpdir();
  try {
    const result = await httpDownload({ url: srv.url(), dir, concurrency: 2 }, () => {});
    assert.equal(path.dirname(result.file), dir, '文件必须落在目标目录内');
    assert.equal(path.basename(result.file), 'evil.bin');
    const outside = path.resolve(dir, '..', '..', '..', 'evil.bin');
    await assert.rejects(fsp.access(outside), '不应在目标目录之外写出文件');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('unicode Content-Disposition filename is preserved', async () => {
  const srv = await startHttpServer({
    size: 512 * 1024,
    disposition: "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.bin",
  });
  const dir = await tmpdir();
  try {
    const result = await httpDownload({ url: srv.url(), dir, concurrency: 2 }, () => {});
    assert.equal(path.basename(result.file), '测试.bin');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('follows redirects and names the file after the final URL', async () => {
  const srv = await startHttpServer({ size: 1024 * 512 });
  const dir = await tmpdir();
  try {
    const result = await httpDownload({ url: srv.url('/redirect'), dir, concurrency: 2 }, () => {});
    assert.equal(path.basename(result.file), 'file.bin');
    const onDisk = await fsp.readFile(result.file);
    assert.equal(sha256Buffer(onDisk), sha256Buffer(srv.content));
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('http errors are surfaced with a Chinese description', async () => {
  const srv = await startHttpServer({ size: 1024, status: 404 });
  const dir = await tmpdir();
  try {
    await assert.rejects(
      httpDownload({ url: srv.url(), dir }, () => {}),
      /资源不存在（HTTP 404）/,
    );
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('sha256 mismatch fails loudly', async () => {
  const srv = await startHttpServer({ size: 1024 * 1024 });
  const dir = await tmpdir();
  try {
    await assert.rejects(
      httpDownload({ url: srv.url(), dir, concurrency: 2, expectedSha256: 'ab'.repeat(32) }, () => {}),
      /sha256 校验失败/,
    );
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('a complete file is skipped unless overwrite is requested', async () => {
  const srv = await startHttpServer({ size: 1024 * 1024 });
  const dir = await tmpdir();
  try {
    const first = await httpDownload({ url: srv.url(), dir, concurrency: 2 }, () => {});
    assert.equal(first.skipped, false);
    const servedAfterFirst = srv.stats.bytesServed;
    const second = await httpDownload({ url: srv.url(), dir, concurrency: 2 }, () => {});
    assert.equal(second.skipped, true);
    assert.equal(srv.stats.bytesServed, servedAfterFirst, '跳过时不应再传输数据');
  } finally {
    await srv.close();
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
