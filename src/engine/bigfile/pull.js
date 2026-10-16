// Mode 3, pull side: download the chunks of a published big file in parallel
// and reassemble them locally with sha256 verification.
//
// Shard branches contain parentless root commits, so the fetches are plain
// full fetches (no --depth): there is no history to deepen, and avoiding
// --depth also avoids .git/shallow lock contention between parallel fetches.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { run, isAbortError } from '../proc.js';
import { detectGit } from '../git-detect.js';
import { GitProgressAggregator, createLineSplitter, parseProgressLine } from '../progress.js';
import { assertSafeGitUrl } from '../util/urlsafe.js';
import { readJson, writeJsonAtomic, ensureDir, exists, fileSize, rmrf } from '../util/fsx.js';
import { Hasher, sha256File } from '../util/sha256.js';
import { makeThrottled } from '../util/throttle.js';
import { SpeedMeter } from '../util/speed.js';
import { MANIFEST_BRANCH, MANIFEST_PATH, MANIFEST_VERSION } from './split.js';

// Branch names from the manifest ("dl/shard-3") map onto remote-tracking refs.
function localRefFor(branch) {
  return `refs/remotes/dl/${branch.split('/').pop()}`;
}

const PULL_META_VERSION = 1;
const FETCH_RETRIES = 2;
const CHUNK_RETRIES = 2;

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

async function gitRun(gitPath, cwd, args, { signal } = {}) {
  const res = await run(gitPath, args, { cwd, signal });
  if (res.code !== 0) {
    const err = new Error(`git ${args[0]} 失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
    err.stderr = res.stderr;
    throw err;
  }
  return res;
}

async function gitOut(gitPath, cwd, args, opts = {}) {
  const res = await gitRun(gitPath, cwd, args, opts);
  return res.stdout.trim();
}

// Offsets are cumulative so each chunk knows where to land in the .part file.
export function computeChunkOffsets(chunks) {
  let offset = 0;
  return chunks.map((chunk) => {
    const entry = { ...chunk, offset };
    offset += chunk.size;
    return entry;
  });
}

export async function pullBigFile(opts, onEvent = () => {}) {
  const {
    repoUrl: rawRepo,
    file,
    out,
    concurrency = 8,
    workdir: explicitWorkdir = null,
    overwrite = false,
    proxy = null,
    cleanup = null, // default: remove the cache dir when we created it ourselves
    signal,
  } = opts;

  const repoUrl = assertSafeGitUrl(rawRepo);
  const outPath = path.resolve(out);
  const workdir = explicitWorkdir
    ? path.resolve(explicitWorkdir)
    : `${outPath}.gitdl-cache`;
  const emitLog = (level, text) => onEvent({ type: 'log', level, text });

  const git = await detectGit();
  if (!git.ok) throw new Error(`未找到可用的 git：${git.error}`);
  const gitPath = git.path ?? 'git';

  const configArgs = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false'];
  if (proxy) configArgs.push('-c', `http.proxy=${proxy}`);

  // ---- work repository (also the resume cache) -----------------------------
  if (!exists(path.join(workdir, '.git'))) {
    await ensureDir(workdir);
    await gitRun(gitPath, workdir, ['init', '--quiet']);
    await gitRun(gitPath, workdir, ['remote', 'add', 'origin', repoUrl]);
    emitLog('info', `已初始化本地缓存仓库：${workdir}`);
  } else {
    emitLog('info', `复用本地缓存仓库：${workdir}`);
  }

  // ---- manifest ------------------------------------------------------------
  onEvent({ type: 'phase', phase: 'manifest', text: '获取 manifest…' });
  let manifest;
  for (let attempt = 0; ; attempt++) {
    try {
      await gitRun(gitPath, workdir, [
        ...configArgs, 'fetch', '--no-tags', 'origin',
        `+refs/heads/${MANIFEST_BRANCH}:refs/remotes/dl/manifest`,
      ], { signal });
      const json = await gitOut(gitPath, workdir, ['show', `refs/remotes/dl/manifest:${MANIFEST_PATH}`]);
      manifest = JSON.parse(json);
      break;
    } catch (err) {
      if (isAbortError(err) || signal?.aborted) throw err;
      if (attempt >= FETCH_RETRIES) {
        throw new Error(`无法读取 manifest（远端是否有 ${MANIFEST_BRANCH} 分支？）：${err.message}`);
      }
      await sleep(1000 * 2 ** attempt, signal);
    }
  }
  if (manifest?.version !== MANIFEST_VERSION || !Array.isArray(manifest.chunks)) {
    throw new Error('manifest 格式不受支持（可能由更新版本发布）');
  }
  if (manifest.file !== file) {
    throw new Error(`远端发布的文件是 ${manifest.file}，而不是请求的 ${file}`);
  }
  const chunks = computeChunkOffsets(manifest.chunks);
  const totalSize = chunks.reduce((n, c) => n + c.size, 0);
  if (totalSize !== manifest.size) {
    throw new Error('manifest 自相矛盾：分片大小之和与总大小不一致');
  }
  emitLog('info', `manifest：${manifest.file}，${chunks.length} 个分片、共 ${(totalSize / 1024 / 1024).toFixed(1)} MiB`);

  // ---- output/part file state ---------------------------------------------
  const partPath = `${outPath}.part`;
  const metaPath = `${outPath}.dlmeta.json`;

  if (exists(outPath) && !overwrite) {
    const existingSize = await fileSize(outPath);
    if (existingSize === totalSize) {
      const got = await sha256File(outPath, { signal });
      if (got === manifest.sha256) {
        emitLog('info', `目标文件已存在且校验通过，跳过：${outPath}`);
        return { file: outPath, bytes: existingSize, sha256: got, skipped: true, chunks: chunks.length, workdir };
      }
      throw new Error(`目标文件已存在但 sha256 不匹配：${outPath}（删除后重试，或启用覆盖）`);
    }
  }

  const partSizeBefore = await fileSize(partPath);
  let meta = await readJson(metaPath, null);
  const resumeValid = Boolean(
    meta
    && partSizeBefore != null
    && meta.version === PULL_META_VERSION
    && meta.repoUrl === repoUrl
    && meta.file === manifest.file
    && meta.size === manifest.size
    && meta.sha256 === manifest.sha256,
  );
  if (meta && !resumeValid) {
    emitLog('warn', '断点数据与远端发布不匹配，重新下载');
    await rmrf(partPath).catch(() => {});
    meta = null;
  }
  if (!meta && partSizeBefore != null) await rmrf(partPath).catch(() => {});
  const done = new Set(resumeValid ? meta.done.filter((i) => Number.isInteger(i) && i >= 0 && i < chunks.length) : []);
  if (done.size > 0) {
    const bytes = chunks.filter((c) => done.has(c.index)).reduce((n, c) => n + c.size, 0);
    emitLog('info', `断点续传：已完成 ${done.size}/${chunks.length} 个分片（${(bytes / 1024 / 1024).toFixed(1)} MiB）`);
  }

  const persistMeta = () => writeJsonAtomic(metaPath, {
    version: PULL_META_VERSION,
    repoUrl,
    file: manifest.file,
    size: manifest.size,
    sha256: manifest.sha256,
    done: [...done].sort((a, b) => a - b),
    updatedAt: new Date().toISOString(),
  });

  if (!exists(partPath)) await fsp.writeFile(partPath, '');
  if (partSizeBefore == null) await fsp.truncate(partPath, totalSize);

  // ---- fetch shard branches in parallel ------------------------------------
  const branches = [...new Set(chunks.map((c) => c.branch))];
  onEvent({ type: 'phase', phase: 'fetch', text: `并行抓取 ${branches.length} 个分片分支…` });
  const aggregator = new GitProgressAggregator();
  const emitSnapshot = makeThrottled(() => {
    onEvent({ type: 'progress', text: '抓取分片…', percent: null, snapshot: aggregator.snapshot(), connections: aggregator.size });
  }, 150);

  let fetchCursor = 0;
  const fetchWorker = async () => {
    for (;;) {
      const index = fetchCursor;
      fetchCursor += 1;
      if (index >= branches.length) return;
      const branch = branches[index];
      const splitter = createLineSplitter();
      for (let attempt = 0; ; attempt++) {
        try {
          const res = await run(gitPath, [
            ...configArgs, 'fetch', '--progress', '--no-tags', 'origin',
            `+refs/heads/${branch}:${localRefFor(branch)}`,
          ], {
            cwd: workdir,
            signal,
            onStderr: (buf) => {
              for (const line of splitter.push(buf.toString())) {
                const event = parseProgressLine(line);
                if (event) {
                  aggregator.update(branch, event);
                  emitSnapshot();
                }
              }
            },
          });
          if (res.code !== 0) {
            const err = new Error(`抓取 ${branch} 失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
            err.stderr = res.stderr;
            throw err;
          }
          break;
        } catch (err) {
          if (isAbortError(err) || signal?.aborted) throw err;
          if (attempt >= FETCH_RETRIES) throw err;
          emitLog('warn', `抓取 ${branch} 出错（${err.message}），重试…`);
          await sleep(800 * 2 ** attempt, signal);
        }
      }
      aggregator.remove(branch);
    }
  };
  const fetchWorkers = Math.max(1, Math.min(concurrency, branches.length));
  await Promise.all(Array.from({ length: fetchWorkers }, fetchWorker));

  // ---- verify that the fetched refs really contain the published objects ---
  onEvent({ type: 'phase', phase: 'verify', text: '校验分片对象…' });
  for (const chunk of chunks) {
    const ref = localRefFor(chunk.branch);
    const oid = (await gitOut(gitPath, workdir, ['rev-parse', `${ref}:${chunk.path}`]).catch(() => '')).trim();
    if (oid !== chunk.oid) {
      throw new Error(
        `分片 ${chunk.index} 的对象校验失败（期望 ${chunk.oid.slice(0, 12)}…，实际 ${oid ? `${oid.slice(0, 12)}…` : '不存在'}）`,
      );
    }
  }

  // ---- read chunks in parallel, writing at their offsets -------------------
  const remaining = chunks.filter((c) => !done.has(c.index));
  const meter = new SpeedMeter();
  let bytesWritten = chunks.filter((c) => done.has(c.index)).reduce((n, c) => n + c.size, 0);
  meter.add(bytesWritten);
  const emitReadProgress = makeThrottled(() => {
    onEvent({
      type: 'progress',
      text: `重组 ${done.size}/${chunks.length} 个分片`,
      percent: totalSize ? bytesWritten / totalSize : null,
      snapshot: {
        bytes: bytesWritten,
        total: totalSize,
        percent: totalSize ? bytesWritten / totalSize : null,
        bytesPerSec: meter.rate(),
        connections: Math.min(concurrency, Math.max(1, remaining.length)),
        chunksDone: done.size,
        chunksTotal: chunks.length,
      },
    });
  }, 150);

  const partHandle = await fsp.open(partPath, 'r+');
  const persistThrottled = makeThrottled(() => persistMeta().catch(() => {}), 500);
  let chunkCursor = 0;
  let failure = null;

  const chunkWorker = async () => {
    for (;;) {
      const index = chunkCursor;
      chunkCursor += 1;
      if (index >= remaining.length) return;
      const chunk = remaining[index];
      await readChunk(chunk);
    }
  };

  async function readChunk(chunk) {
    for (let attempt = 0; ; attempt++) {
      const ref = localRefFor(chunk.branch);
      const hasher = new Hasher();
      let position = chunk.offset;
      let chain = Promise.resolve();
      try {
        const res = await run(gitPath, ['cat-file', 'blob', `${ref}:${chunk.path}`], {
          cwd: workdir,
          signal,
          captureStdout: false,
          onStdout: (buffer) => {
            // Writes are chained so each chunk's bytes land at increasing
            // offsets even though the pipe yields them in separate ticks.
            hasher.update(buffer);
            const at = position;
            position += buffer.length;
            chain = chain.then(() => partHandle.write(buffer, 0, buffer.length, at));
          },
        });
        if (res.code !== 0) {
          throw new Error(`git cat-file 失败：${res.stderr.trim()}`);
        }
        await chain;
        if (hasher.size !== chunk.size || hasher.digestHex() !== chunk.sha256) {
          throw new Error(`分片 ${chunk.index} 内容校验失败（sha256 不一致）`);
        }
        done.add(chunk.index);
        bytesWritten += chunk.size;
        meter.add(bytesWritten);
        emitReadProgress();
        persistThrottled();
        return;
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) throw err;
        if (attempt >= CHUNK_RETRIES) throw err;
        emitLog('warn', `分片 ${chunk.index} 读取出错（${err.message}），重试…`);
        await sleep(500 * 2 ** attempt, signal);
      }
    }
  }

  try {
    const workers = Math.max(1, Math.min(concurrency, remaining.length || 1));
    await Promise.all(Array.from({ length: workers }, chunkWorker));
  } catch (err) {
    failure = err;
    await persistMeta().catch(() => {});
  } finally {
    await partHandle.close().catch(() => {});
  }
  if (failure) throw failure;

  // ---- finalize ------------------------------------------------------------
  await persistMeta().catch(() => {});
  const actualSize = await fileSize(partPath);
  if (actualSize !== totalSize) {
    throw new Error(`重组后大小不符：期望 ${totalSize}，实际 ${actualSize}`);
  }
  const finalSha = await sha256File(partPath, { signal });
  if (finalSha !== manifest.sha256) {
    throw new Error(`整体 sha256 校验失败（期望 ${manifest.sha256.slice(0, 12)}…，实际 ${finalSha.slice(0, 12)}…）`);
  }
  if (exists(outPath)) {
    if (!overwrite) throw new Error(`目标文件已存在：${outPath}（启用覆盖或更换输出路径）`);
    await rmrf(outPath);
  }
  await fsp.rename(partPath, outPath);
  await rmrf(metaPath).catch(() => {});
  const shouldCleanup = cleanup === null ? !explicitWorkdir : cleanup;
  if (shouldCleanup) await rmrf(workdir).catch(() => {});
  emitLog('info', `校验通过，已写入：${outPath}`);
  return { file: outPath, bytes: totalSize, sha256: finalSha, chunks: chunks.length, workdir };
}
