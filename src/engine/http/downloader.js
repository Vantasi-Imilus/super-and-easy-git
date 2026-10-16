// Mode 4: HTTP segmented downloader (aria2/IDM style).
//
// State machine: probe -> plan -> download -> verify/done.
//  - Segmented: the file is split into `concurrency` contiguous range
//    requests; each segment's contiguous `done` offset is persisted so an
//    interrupted download resumes where it left off.
//  - Fallback: a server that answers a ranged request with 200 ignores Range,
//    so the whole job restarts as a single stream.
//  - Resume validation: the stored ETag/Last-Modified/size must still match the
//    live resource, otherwise the partial file is discarded.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { requestFollowing, makeDispatcher, HttpError } from './client.js';
import { probeUrl } from './probe.js';
import { assertSafeHttpUrl, sanitizeFileName, joinInside } from '../util/urlsafe.js';
import { readJson, writeJsonAtomic, ensureDir, fileSize, exists, rmrf } from '../util/fsx.js';
import { makeThrottled } from '../util/throttle.js';
import { isAbortError } from '../proc.js';
import { sha256File } from '../util/sha256.js';
import { SpeedMeter } from '../util/speed.js';

export { SpeedMeter } from '../util/speed.js';

const META_VERSION = 1;
const MIN_SEGMENTED_SIZE = 512 * 1024;
const SEGMENT_RETRIES = 3;
const SINGLE_RETRIES = 3;

class RangeUnsupportedError extends Error {
  constructor() {
    super('服务器忽略 Range 请求');
    this.name = 'RangeUnsupportedError';
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function planSegments(size, concurrency) {
  const n = Math.max(1, Math.min(concurrency, Math.ceil(size / MIN_SEGMENTED_SIZE)));
  const base = Math.floor(size / n);
  const segments = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = i === n - 1 ? size : start + base;
    segments.push({ start, end, done: 0 });
    start = end;
  }
  return segments;
}

export async function httpDownload(opts, onEvent = () => {}) {
  const {
    url: rawUrl,
    dir,
    filename: filenameOverride = null,
    concurrency = 4,
    proxy = null,
    expectedSha256 = null,
    overwrite = false,
    signal,
  } = opts;

  const url = assertSafeHttpUrl(rawUrl);
  const targetDir = path.resolve(dir ?? process.cwd());
  await ensureDir(targetDir);
  const dispatcher = makeDispatcher(proxy);
  const emitLog = (level, text) => onEvent({ type: 'log', level, text });

  emitLog('info', '探测服务器能力…');
  const probe = await probeUrl(url, { dispatcher, signal });
  const finalUrl = probe.finalUrl;
  const filename = sanitizeFileName(filenameOverride ?? probe.filename, 'download');
  const finalPath = joinInside(targetDir, filename);
  const partPath = `${finalPath}.part`;
  const metaPath = `${finalPath}.dlmeta.json`;
  const total = probe.size;

  if (total != null) {
    emitLog('info', `文件大小 ${(total / 1024 / 1024).toFixed(2)} MiB，支持分段/续传：${probe.acceptRanges ? '是' : '否'}`);
  } else {
    emitLog('warn', '服务器未提供可靠的文件大小，将以单连接下载');
  }

  // A finished file is left alone unless the caller explicitly overwrites.
  if (exists(finalPath) && !overwrite) {
    const existingSize = await fileSize(finalPath);
    if (total == null || existingSize === total) {
      if (expectedSha256) {
        const got = await sha256File(finalPath, { signal });
        if (got === expectedSha256.toLowerCase()) {
          emitLog('info', `文件已存在且 sha256 校验通过：${finalPath}`);
          return { file: finalPath, bytes: existingSize, sha256: got, skipped: true, elapsedMs: 0 };
        }
        throw new Error(`目标文件已存在且 sha256 不匹配：${finalPath}（删除后重试，或启用覆盖）`);
      }
      emitLog('info', `文件已存在且大小一致，跳过下载：${finalPath}`);
      return { file: finalPath, bytes: existingSize, sha256: null, skipped: true, elapsedMs: 0 };
    }
  }

  // ---- resume state --------------------------------------------------------
  const partSizeBefore = await fileSize(partPath);
  let meta = await readJson(metaPath, null);
  const resumeValid = Boolean(
    meta
    && partSizeBefore != null
    && meta.version === META_VERSION
    && meta.url === finalUrl
    && meta.size === probe.size
    && (meta.etag ? meta.etag === probe.etag : true)
    && (meta.lastModified ? meta.lastModified === probe.lastModified : true),
  );
  if (meta && !resumeValid) {
    emitLog('warn', '断点数据与远端文件不匹配（ETag/大小已变化），重新下载');
    await rmrf(partPath).catch(() => {});
    await rmrf(metaPath).catch(() => {});
    meta = null;
  }
  if (!meta && partSizeBefore != null) {
    await rmrf(partPath).catch(() => {});
  }

  const meter = new SpeedMeter();
  const startedAt = Date.now();
  const useSegments = Boolean(total && probe.acceptRanges && total >= MIN_SEGMENTED_SIZE && concurrency > 1);
  let segments = useSegments ? planSegments(total, concurrency) : null;
  let singleDone = 0;
  let connections = 0;

  if (segments && resumeValid && Array.isArray(meta.segments)) {
    for (const stored of meta.segments) {
      const seg = segments.find((s) => s.start === stored.start && s.end === stored.end);
      if (!seg) continue;
      const available = Math.max(0, Math.min(partSizeBefore ?? 0, total) - seg.start);
      seg.done = Math.max(0, Math.min(stored.done, seg.end - seg.start, available));
    }
    const resumed = segments.reduce((n, s) => n + s.done, 0);
    if (resumed > 0) emitLog('info', `断点续传：已完成 ${(resumed / 1024 / 1024).toFixed(2)} MiB，继续剩余部分`);
  } else if (!segments && resumeValid && meta.mode === 'single' && total) {
    singleDone = Math.max(0, Math.min(meta.bytesDone ?? 0, total, partSizeBefore ?? 0));
    if (singleDone > 0) emitLog('info', `断点续传：已完成 ${(singleDone / 1024 / 1024).toFixed(2)} MiB`);
  }

  const bytesDone = () => (segments ? segments.reduce((n, s) => n + s.done, 0) : singleDone);

  const emitProgress = makeThrottled(() => {
    const done = bytesDone();
    onEvent({
      type: 'progress',
      snapshot: {
        bytes: done,
        total,
        percent: total ? Math.min(1, done / total) : null,
        bytesPerSec: meter.rate(),
        connections,
        segments: segments ? segments.map((s, i) => ({ index: i, done: s.done, length: s.end - s.start })) : null,
      },
    });
  }, 120);

  const emitLogThrottled = makeThrottled((level, text) => emitLog(level, text), 2000);

  if (!exists(partPath)) await fsp.writeFile(partPath, '');
  let partHandle = await fsp.open(partPath, 'r+');

  const persistMeta = async () => {
    await writeJsonAtomic(metaPath, {
      version: META_VERSION,
      url: finalUrl,
      etag: probe.etag,
      lastModified: probe.lastModified,
      size: probe.size,
      filename,
      mode: segments ? 'segmented' : 'single',
      segments: segments ? segments.map((s) => ({ start: s.start, end: s.end, done: s.done })) : null,
      bytesDone: segments ? null : singleDone,
      updatedAt: new Date().toISOString(),
    });
  };

  // ---- download ------------------------------------------------------------
  let failure = null;
  try {
    if (segments) await runSegmented();
    else await runSingle();
  } catch (err) {
    failure = err;
    await persistMeta().catch(() => {});
  } finally {
    await partHandle.close().catch(() => {});
    partHandle = null;
  }
  if (failure) throw failure;

  // ---- verify + finalize ---------------------------------------------------
  const actualSize = await fileSize(partPath);
  if (total != null && actualSize !== total) {
    throw new Error(`下载不完整：期望 ${total} 字节，实际 ${actualSize} 字节（可重试续传）`);
  }
  let sha256 = null;
  if (expectedSha256) {
    sha256 = await sha256File(partPath, { signal });
    if (sha256 !== expectedSha256.toLowerCase()) {
      throw new Error(`sha256 校验失败：期望 ${expectedSha256.toLowerCase()}，实际 ${sha256}`);
    }
    emitLog('info', 'sha256 校验通过');
  }
  if (exists(finalPath)) {
    if (!overwrite) throw new Error(`目标文件已存在：${finalPath}（启用覆盖或更换文件名）`);
    await rmrf(finalPath);
  }
  await fsp.rename(partPath, finalPath);
  await rmrf(metaPath).catch(() => {});
  connections = 0;
  onEvent({
    type: 'progress',
    snapshot: { bytes: actualSize, total: actualSize, percent: 1, bytesPerSec: null, connections: 0, segments: null },
  });
  emitLog('info', `已保存：${finalPath}`);
  return { file: finalPath, bytes: actualSize, sha256, skipped: false, elapsedMs: Date.now() - startedAt };

  // ---------------------------------------------------------------------------
  async function downloadSegment(seg, index) {
    for (let attempt = 0; attempt <= SEGMENT_RETRIES; attempt++) {
      if (seg.done >= seg.end - seg.start) return;
      const start = seg.start + seg.done;
      const end = seg.end - 1;
      try {
        const { res } = await requestFollowing(finalUrl, {
          headers: { range: `bytes=${start}-${end}` },
          dispatcher,
          signal,
        });
        if (res.statusCode === 200) {
          await res.body.dump().catch(() => {});
          throw new RangeUnsupportedError();
        }
        if (res.statusCode !== 206) {
          await res.body.dump().catch(() => {});
          throw new HttpError(`分片请求失败（HTTP ${res.statusCode}）`, { status: res.statusCode });
        }
        const contentRange = String(res.headers['content-range'] ?? '');
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(contentRange);
        if (m && Number(m[1]) !== start) {
          await res.body.dump().catch(() => {});
          throw new HttpError(`服务器返回的分片起点不符（期望 ${start}，实际 ${m[1]}）`);
        }
        for await (const chunk of res.body) {
          await partHandle.write(chunk, 0, chunk.length, seg.start + seg.done);
          seg.done += chunk.length;
          meter.add(bytesDone());
          emitProgress();
        }
        await persistMeta();
        return;
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw err;
        if (err instanceof RangeUnsupportedError) throw err;
        if (attempt === SEGMENT_RETRIES) throw err;
        const delay = 500 * 2 ** attempt;
        emitLogThrottled('warn', `分片 ${index + 1} 下载出错（${err.message}），${delay}ms 后重试`);
        await sleep(delay, signal);
        meter.reset();
      }
    }
  }

  async function runSegmented() {
    let cursor = 0;
    const workerCount = Math.min(concurrency, segments.length);
    connections = Math.min(workerCount, segments.filter((s) => s.done < s.end - s.start).length);
    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= segments.length) return;
        await downloadSegment(segments[index], index);
      }
    };
    try {
      await Promise.all(Array.from({ length: workerCount }, worker));
    } catch (err) {
      if (err instanceof RangeUnsupportedError && !signal?.aborted) {
        emitLog('warn', '服务器实际不支持 Range，回退为单连接下载');
        segments = null;
        singleDone = 0;
        await partHandle.truncate(0);
        meter.reset();
        await runSingle();
        return;
      }
      throw err;
    }
    connections = 0;
  }

  async function runSingle() {
    connections = 1;
    for (let attempt = 0; attempt <= SINGLE_RETRIES; attempt++) {
      try {
        await singleAttempt();
        return;
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw err;
        if (attempt === SINGLE_RETRIES) throw err;
        const delay = 1000 * 2 ** attempt;
        emitLogThrottled('warn', `下载出错（${err.message}），${delay}ms 后重试`);
        await sleep(delay, signal);
        meter.reset();
      }
    }
  }

  async function singleAttempt() {
    const canResume = probe.acceptRanges && singleDone > 0 && (total == null || singleDone < total);
    const headers = canResume ? { range: `bytes=${singleDone}-` } : {};
    const { res } = await requestFollowing(finalUrl, { headers, dispatcher, signal });
    if (res.statusCode === 206) {
      const m = /^bytes (\d+)-/.exec(String(res.headers['content-range'] ?? ''));
      if (m && Number(m[1]) !== singleDone) {
        await res.body.dump().catch(() => {});
        singleDone = 0;
        await partHandle.truncate(0);
        throw new HttpError('服务器返回的起点与断点不符，已重新开始');
      }
    } else if (res.statusCode === 200) {
      if (singleDone > 0) {
        singleDone = 0;
        await partHandle.truncate(0);
      }
    } else {
      await res.body.dump().catch(() => {});
      throw new HttpError(`下载失败（HTTP ${res.statusCode}）`, { status: res.statusCode });
    }
    for await (const chunk of res.body) {
      await partHandle.write(chunk, 0, chunk.length, singleDone);
      singleDone += chunk.length;
      meter.add(singleDone);
      emitProgress();
    }
    connections = 0;
    await persistMeta();
  }
}
