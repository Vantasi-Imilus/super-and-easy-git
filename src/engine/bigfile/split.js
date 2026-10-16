// Mode 3, publish side: split a big file into chunks and publish them as
// per-shard branches of a git repository.
//
// Data model (all branches live under the `dl/` namespace of the target repo):
//   dl/manifest    manifest.json only
//   dl/shard-<K>   chunks/<i>.bin for every chunk i with i % shards === K
//
// Everything is built with plumbing (hash-object / mktree / commit-tree /
// update-ref / push), so the publisher never needs a worktree and a re-publish
// simply force-updates the tool-owned branches.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run } from '../proc.js';
import { detectGit } from '../git-detect.js';
import { assertSafeGitUrl } from '../util/urlsafe.js';
import { ensureDir, exists, rmrf } from '../util/fsx.js';
import { Hasher, sha256Buffer } from '../util/sha256.js';
import { makeThrottled } from '../util/throttle.js';

export const MANIFEST_BRANCH = 'dl/manifest';
export const MANIFEST_PATH = 'manifest.json';
export const CHUNK_DIR = 'chunks';
export const SHARD_PREFIX = 'dl/shard-';
export const MANIFEST_VERSION = 1;

export function chunkPath(index) {
  return `${CHUNK_DIR}/${index}.bin`;
}

async function gitRun(gitPath, cwd, args, { signal, input } = {}) {
  const res = await run(gitPath, args, { cwd, signal, input });
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} 失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  return res;
}

async function gitOut(gitPath, cwd, args, { signal, input } = {}) {
  const res = await gitRun(gitPath, cwd, args, { signal, input });
  return res.stdout.trim();
}

async function mktree(gitPath, cwd, entries) {
  const input = entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}\n`).join('');
  return gitOut(gitPath, cwd, ['mktree'], { input });
}

export async function publishBigFile(opts, onEvent = () => {}) {
  const {
    file,
    repoUrl: rawRepo,
    shards = 8,
    chunkSize = 32 * 1024 * 1024,
    workdir: explicitWorkdir = null,
    keepChunks = null,
    signal,
  } = opts;

  const repoUrl = assertSafeGitUrl(rawRepo);
  const source = path.resolve(file);
  const emitLog = (level, text) => onEvent({ type: 'log', level, text });
  const emitProgress = makeThrottled((text, percent) => onEvent({ type: 'progress', text, percent }), 120);

  const stat = await fsp.stat(source).catch(() => null);
  if (!stat?.isFile()) throw new Error(`待发布的文件不存在：${source}`);
  if (stat.size === 0) throw new Error('不支持发布空文件');
  const totalSize = stat.size;
  const shardCount = Math.max(1, Math.min(1024, Math.floor(shards)));

  const git = await detectGit();
  if (!git.ok) throw new Error(`未找到可用的 git：${git.error}`);
  const gitPath = git.path ?? 'git';

  // ---- work repository -----------------------------------------------------
  const tempWorkdir = !explicitWorkdir;
  const workdir = explicitWorkdir
    ? path.resolve(explicitWorkdir)
    : path.join(await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-push-')), 'repo');
  await ensureDir(workdir);

  const isRepo = exists(path.join(workdir, '.git'));
  if (isRepo) {
    const remoteUrl = await gitOut(gitPath, workdir, ['remote', 'get-url', 'origin']).catch(() => null);
    if (remoteUrl && remoteUrl !== repoUrl) {
      throw new Error(`工作目录 ${workdir} 指向其他远端（${remoteUrl}），请更换 --workdir`);
    }
    if (!remoteUrl) await gitRun(gitPath, workdir, ['remote', 'add', 'origin', repoUrl]);
    emitLog('info', `复用工作仓库：${workdir}`);
  } else {
    await gitRun(gitPath, workdir, ['init', '--quiet']);
    await gitRun(gitPath, workdir, ['remote', 'add', 'origin', repoUrl]);
    emitLog('info', `已初始化工作仓库：${workdir}`);
  }
  // commit-tree needs an identity; set a repo-local fallback if the user has none.
  const email = await gitOut(gitPath, workdir, ['config', 'user.email']).catch(() => '');
  if (!email) {
    await gitRun(gitPath, workdir, ['config', 'user.name', 'super-and-easy-git']);
    await gitRun(gitPath, workdir, ['config', 'user.email', 'super-and-easy-git@localhost']);
    emitLog('warn', '未配置 git 身份，已在本仓库内使用 super-and-easy-git@localhost');
  }

  let succeeded = false;
  try {
    // ---- split -------------------------------------------------------------
    const chunksDir = path.join(workdir, CHUNK_DIR);
    await ensureDir(chunksDir);
    const chunks = [];
    const totalHasher = new Hasher();
    const handle = await fsp.open(source, 'r');
    try {
      for (let offset = 0, index = 0; offset < totalSize; offset += chunkSize, index++) {
        const length = Math.min(chunkSize, totalSize - offset);
        const buffer = Buffer.allocUnsafe(length);
        await handle.read(buffer, 0, length, offset);
        totalHasher.update(buffer);
        const sha256 = sha256Buffer(buffer);
        const filePath = path.join(chunksDir, `${index}.bin`);
        await fsp.writeFile(filePath, buffer);
        chunks.push({ index, size: length, sha256, filePath });
        emitProgress(`切分 ${index + 1}/${Math.ceil(totalSize / chunkSize)}`, (offset + length) / totalSize / 3);
      }
    } finally {
      await handle.close();
    }
    const totalSha256 = totalHasher.digestHex();
    emitLog('info', `已切分 ${chunks.length} 个分片（每片 ${(chunkSize / 1024 / 1024).toFixed(0)} MiB），文件 sha256 ${totalSha256.slice(0, 12)}…`);

    // ---- blob objects ------------------------------------------------------
    for (const chunk of chunks) {
      chunk.oid = await gitOut(gitPath, workdir, ['hash-object', '-w', chunk.filePath], { signal });
      chunk.branch = `${SHARD_PREFIX}${chunk.index % shardCount}`;
      chunk.path = chunkPath(chunk.index);
    }

    const manifest = {
      version: MANIFEST_VERSION,
      file: path.basename(source),
      size: totalSize,
      sha256: totalSha256,
      chunkSize,
      shards: shardCount,
      chunks: chunks.map((c) => ({
        index: c.index,
        size: c.size,
        sha256: c.sha256,
        oid: c.oid,
        branch: c.branch,
        path: c.path,
      })),
    };
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestOid = await gitOut(gitPath, workdir, ['hash-object', '-w', '--stdin'], {
      input: manifestJson,
      signal,
    });

    // ---- one root commit per shard ----------------------------------------
    const branches = [MANIFEST_BRANCH];
    const manifestTree = await mktree(gitPath, workdir, [
      { mode: '100644', type: 'blob', sha: manifestOid, name: MANIFEST_PATH },
    ]);
    const manifestCommit = await gitOut(gitPath, workdir, [
      'commit-tree', manifestTree, '-m', `gitdl: manifest for ${manifest.file}`,
    ], { signal });
    await gitRun(gitPath, workdir, ['update-ref', `refs/heads/${MANIFEST_BRANCH}`, manifestCommit], { signal });

    for (let k = 0; k < shardCount; k++) {
      const mine = chunks.filter((c) => c.index % shardCount === k);
      if (mine.length === 0) continue;
      const branch = `${SHARD_PREFIX}${k}`;
      const chunksTree = await mktree(gitPath, workdir, mine.map((c) => ({
        mode: '100644', type: 'blob', sha: c.oid, name: `${c.index}.bin`,
      })));
      const rootTree = await mktree(gitPath, workdir, [
        { mode: '040000', type: 'tree', sha: chunksTree, name: CHUNK_DIR },
      ]);
      const commit = await gitOut(gitPath, workdir, [
        'commit-tree', rootTree, '-m', `gitdl: ${manifest.file} shard ${k}/${shardCount}`,
      ], { signal });
      await gitRun(gitPath, workdir, ['update-ref', `refs/heads/${branch}`, commit], { signal });
      branches.push(branch);
      emitProgress(`构建分支 ${branch}`, 0.33 + (0.3 * (k + 1)) / shardCount);
    }

    // ---- push --------------------------------------------------------------
    emitLog('info', `推送到 ${repoUrl}（${branches.length} 个分支）…`);
    onEvent({ type: 'phase', phase: 'push', text: '推送到远端…' });
    const refspecs = branches.map((b) => `refs/heads/${b}:refs/heads/${b}`);
    const pushRes = await run(gitPath, ['push', '--force', '--porcelain', 'origin', ...refspecs], {
      cwd: workdir,
      signal,
    });
    if (pushRes.code !== 0) {
      throw new Error(`推送失败：${pushRes.stderr.trim() || pushRes.stdout.trim()}`);
    }
    emitProgress('推送完成', 1);
    emitLog('info', `已推送 ${branches.length} 个分支（dl/manifest + ${branches.length - 1} 个分片分支）`);

    const shouldClean = keepChunks === null ? tempWorkdir : !keepChunks;
    if (shouldClean) {
      await rmrf(chunksDir).catch(() => {});
    }
    succeeded = true;
    return {
      file: manifest.file,
      size: totalSize,
      sha256: totalSha256,
      chunks: chunks.length,
      shards: shardCount,
      branches,
      branch: MANIFEST_BRANCH,
      workdir,
      manifest,
    };
  } catch (err) {
    if (tempWorkdir) emitLog('warn', `发布未完成，已保留工作仓库以便重试：${workdir}`);
    throw err;
  } finally {
    if (tempWorkdir && succeeded) {
      // The pushed objects live on the remote; the scratch repo can go.
      await rmrf(path.dirname(workdir)).catch(() => {});
    }
  }
}
