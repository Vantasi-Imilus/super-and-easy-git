// Mode 1: accelerated download of a single repository.
//
// Pipeline:
//   init -> A) fetch the default branch (one connection, gives a usable repo
//   fast) -> B) fetch the remaining refs over N parallel connections -> C)
//   checkout -> D) optional submodules -> done. Re-running resumes: git skips
//   objects that are already present.
//
// Parallelism caveat: git keeps `.git/shallow` behind `shallow.lock` for the
// whole transfer, so concurrent *shallow* fetches into one repository fail
// fast. For depth-limited downloads without --filter we therefore fetch each
// group in its own temporary bare repository (parallel network I/O) and merge
// the groups locally afterwards; with --filter we fall back to a serial fetch,
// because promisor objects cannot be routed through temporary repositories.
import path from 'node:path';
import { run, isAbortError } from './proc.js';
import { detectGit } from './git-detect.js';
import { lsRemote, planFetchGroups } from './refs.js';
import { GitProgressAggregator, createLineSplitter, parseProgressLine } from './progress.js';
import { assertSafeGitUrl, sanitizeRepoDirName, joinInside } from './util/urlsafe.js';
import { ensureDir, exists, isGitRepo, rmrf } from './util/fsx.js';
import { makeThrottled } from './util/throttle.js';

// A worker dying with one of these messages means the concurrent fetch into a
// single repository lost a race (ref locks, pack files, the shallow file, or a
// Windows file-rename collision). The stage is then retried serially.
const CONCURRENCY_FAILURE_RE = new RegExp(
  [
    'cannot lock ref',
    'unable to create .*\\.lock',
    'File exists',
    'index-pack failed',
    'unable to write',
    'Unable to create .*\\.pack',
    'bad object',
    'shallow file has changed',
    'shallow\\.lock',
    'Early EOF',
  ].join('|'),
  'i',
);

export function isConcurrencyFailure(stderr) {
  return CONCURRENCY_FAILURE_RE.test(String(stderr ?? ''));
}

export function planParallelStrategy({ depth, filter }) {
  if (!depth || depth <= 0) return 'same-repo';
  if (filter) return 'serial';
  return 'temp-repos';
}

function filterNoiseLine(line) {
  const text = line.replace(/\s+$/, '');
  if (!text) return null;
  if (/^(fatal|error):/i.test(text)) return { level: 'error', text };
  if (/^warning:/i.test(text)) return { level: 'warn', text };
  if (/^Cloning into /.test(text)) return { level: 'info', text };
  if (/^(From |remote: Total )/.test(text)) return { level: 'info', text };
  return null;
}

export async function downloadRepo(opts, onEvent = () => {}) {
  const {
    url: rawUrl,
    baseDir,
    dir: explicitDir,
    gitPath = 'git',
    depth = 0,
    filter = null,
    branches = 'all',
    includeTags = true,
    jobs = 4,
    recursiveSubmodules = false,
    submoduleDepth = depth,
    submoduleJobs = jobs,
    proxy = null,
    checkoutRef = null,
    stallTimeoutSec = 60,
    signal,
  } = opts;

  const url = assertSafeGitUrl(rawUrl);
  const git = await detectGit(gitPath);
  if (!git.ok) throw new Error(`未找到可用的 git：${git.error}`);
  const caps = git.capabilities;
  const startedAt = Date.now();

  const effectiveFilter = filter && caps.filter ? filter : null;
  if (filter && !caps.filter) {
    onEvent({ type: 'log', level: 'warn', text: '当前 git 不支持 --filter（部分克隆），已按完整克隆处理' });
  }

  const targetDir = explicitDir
    ? path.resolve(explicitDir)
    : joinInside(baseDir ?? process.cwd(), sanitizeRepoDirName(url));

  const emitLog = (level, text) => onEvent({ type: 'log', level, text });

  // ---- validate target and read remote refs (nothing written yet) ----------
  const resuming = exists(targetDir) && (await isGitRepo(targetDir)) && !(await isBare(targetDir));
  let existingRemoteUrl = null;
  if (resuming) {
    existingRemoteUrl = await gitOut(targetDir, ['remote', 'get-url', 'origin']).catch(() => null);
    if (existingRemoteUrl && existingRemoteUrl.trim() !== url) {
      throw new Error(`目录 ${targetDir} 已存在且指向其他远端（${existingRemoteUrl.trim()}），请更换目标目录`);
    }
  } else if (exists(targetDir)) {
    throw new Error(`目录 ${targetDir} 已存在且不是工作区仓库（普通目录或裸仓库），请更换目标目录`);
  }

  onEvent({ type: 'phase', phase: 'refs', text: '读取远端 ref…' });
  const remote = await lsRemote(gitPath, url, { signal });
  const branchCount = branches === 'default' ? (remote.defaultBranch ? 1 : 0) : remote.branches.length;
  emitLog('info', `远端共有 ${remote.branches.length} 个分支、${remote.tags.length} 个标签，默认分支 ${remote.defaultBranch ?? '未知'}`);
  onEvent({ type: 'plan', plan: { branches: branchCount, tags: includeTags ? remote.tags.length : 0, depth: depth || null, filter: effectiveFilter, jobs } });

  // ---- init (or resume an existing download) -------------------------------
  if (resuming) {
    emitLog('info', `检测到已有仓库，继续增量下载：${targetDir}`);
    if (!existingRemoteUrl) await gitRun(targetDir, ['remote', 'add', 'origin', url]);
  } else {
    await ensureDir(path.dirname(targetDir));
    await gitRun(path.dirname(targetDir), ['init', '--quiet', targetDir]);
    await gitRun(targetDir, ['remote', 'add', 'origin', url]);
    emitLog('info', `已初始化仓库：${targetDir}`);
  }

  // `git fetch --filter` would write remote.origin.promisor into .git/config on
  // every call; setting it once up front keeps concurrent workers from racing
  // on the config file lock during the parallel stage.
  if (effectiveFilter) {
    await gitRun(targetDir, ['config', 'remote.origin.promisor', 'true']);
    await gitRun(targetDir, ['config', 'remote.origin.partialclonefilter', effectiveFilter]);
  }

  // ---- shared fetch plumbing ----------------------------------------------
  const configArgs = ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', '-c', 'fetch.writeCommitGraph=false'];
  if (proxy) configArgs.push('-c', `http.proxy=${proxy}`);
  if (/^https?:/i.test(url) && stallTimeoutSec > 0) {
    configArgs.push('-c', 'http.lowSpeedLimit=1000', '-c', `http.lowSpeedTime=${stallTimeoutSec}`);
  }
  const baseFetchArgs = ['fetch', '--progress'];
  if (caps.noTags) baseFetchArgs.push('--no-tags');
  if (caps.noWriteFetchHead) baseFetchArgs.push('--no-write-fetch-head');
  if (caps.noAutoGc) baseFetchArgs.push('--no-auto-gc');
  if (caps.noAutoMaintenance) baseFetchArgs.push('--no-auto-maintenance');
  if (depth > 0) baseFetchArgs.push(`--depth=${depth}`);
  if (effectiveFilter) baseFetchArgs.push(`--filter=${effectiveFilter}`);

  const aggregator = new GitProgressAggregator();
  const emitProgress = makeThrottled(() => {
    onEvent({ type: 'progress', snapshot: aggregator.snapshot() });
  }, 120);

  function runFetch(cwd, refspecs, { workerId, label, stageSignal, repoArg = 'origin', prefixArgs = [] }) {
    const splitter = createLineSplitter();
    const onStderr = (chunk) => {
      for (const line of splitter.push(chunk.toString())) {
        const event = parseProgressLine(line);
        if (event) {
          aggregator.update(workerId, event);
          emitProgress();
          continue;
        }
        const noise = filterNoiseLine(line);
        if (noise) onEvent({ type: 'log', ...noise });
      }
    };
    const args = [...prefixArgs, ...configArgs, ...baseFetchArgs, repoArg, ...refspecs];
    return run(gitPath, args, { cwd, signal: stageSignal, onStderr }).then((res) => {
      for (const line of splitter.flush()) {
        const event = parseProgressLine(line);
        if (event) aggregator.update(workerId, event);
      }
      if (res.code !== 0) {
        const err = new Error(`git fetch 失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
        err.stderr = res.stderr;
        err.workerId = workerId;
        throw err;
      }
      return res;
    });
  }

  // Shallow parallel strategy: each ref group is downloaded over its own
  // connection into a temporary bare repository (each has its own shallow
  // file, so there is no lock contention), then merged locally one group at a
  // time so the target repository's shallow file is only ever touched serially.
  async function fetchViaTempRepos(groups, stageSignal) {
    const tmpRoot = `${targetDir}.gitdl-tmp`;
    await ensureDir(tmpRoot);
    try {
      const settled = await Promise.allSettled(groups.map(async (g) => {
        const tmp = path.join(tmpRoot, g.id);
        await rmrf(tmp);
        const initRes = await run(gitPath, ['init', '--quiet', '--bare', tmp], { signal: stageSignal });
        if (initRes.code !== 0) throw new Error(`临时仓库初始化失败：${initRes.stderr.trim()}`);
        // Temp repos hold the group's refs locally instead of remote-tracking.
        const tmpRefspecs = g.refspecs.map((r) => r.replace(':refs/remotes/origin/', ':refs/heads/'));
        await runFetch(tmpRoot, tmpRefspecs, {
          workerId: g.id,
          label: `${g.branchCount + g.tagCount} 个 ref`,
          stageSignal,
          prefixArgs: [`--git-dir=${tmp}`],
          repoArg: url,
        });
        return { group: g, tmp };
      }));
      const failures = settled
        .map((r, i) => ({ r, group: groups[i] }))
        .filter(({ r }) => r.status === 'rejected');
      if (failures.length > 0) throw failures[0].r.reason;

      onEvent({ type: 'phase', phase: 'merge', text: '合入目标仓库…' });
      for (const outcome of settled) {
        const { group, tmp } = outcome.value;
        await runFetch(targetDir, group.refspecs, {
          workerId: `merge-${group.id}`,
          label: `合并 ${group.id}`,
          stageSignal,
          repoArg: tmp,
        });
        aggregator.remove(`merge-${group.id}`);
        await rmrf(tmp);
        onEvent({ type: 'worker', id: group.id, state: 'done' });
        emitProgress();
      }
    } finally {
      await rmrf(tmpRoot).catch(() => {});
    }
  }

  let parentAborted = signal?.aborted ?? false;
  const stageAbort = new AbortController();
  const onParentAbort = () => {
    parentAborted = true;
    stageAbort.abort();
  };
  signal?.addEventListener('abort', onParentAbort, { once: true });
  const stageSignal = stageAbort.signal;

  try {
    // ---- stage A: default branch ------------------------------------------
    const plan = planFetchGroups({
      branches: remote.branches,
      tags: remote.tags,
      defaultBranch: remote.defaultBranch,
      groupCount: jobs,
      includeTags,
    });
    const defaultRef = plan.defaultRef;
    // "default" mode fetches nothing beyond the default branch.
    const groups = branches === 'default' ? [] : plan.groups;
    if (!defaultRef) throw new Error('远端没有任何分支，无法下载');

    onEvent({ type: 'phase', phase: 'default-branch', text: `抓取默认分支 ${defaultRef}…` });
    await runFetch(targetDir, [`+refs/heads/${defaultRef}:refs/remotes/origin/${defaultRef}`], {
      workerId: 'default',
      label: `默认分支 ${defaultRef}`,
      stageSignal,
    });
    onEvent({ type: 'worker', id: 'default', label: `默认分支 ${defaultRef}`, state: 'done' });

    // ---- stage B: remaining refs over N connections ------------------------
    if (groups.length > 0) {
      const strategy = planParallelStrategy({ depth, filter: effectiveFilter });
      const totalRefs = groups.reduce((n, g) => n + g.refspecs.length, 0);
      onEvent({
        type: 'phase',
        phase: 'parallel',
        text: strategy === 'serial'
          ? `并行受限（浅克隆 + 过滤），串行抓取其余 ${totalRefs} 个 ref…`
          : `并行抓取其余 ${totalRefs} 个 ref（${groups.length} 个连接）…`,
      });
      for (const g of groups) {
        onEvent({
          type: 'worker', id: g.id, state: 'pending',
          label: `组 ${g.branchCount} 分支${g.tagCount ? ` + ${g.tagCount} 标签` : ''}`,
        });
      }

      if (strategy === 'temp-repos') {
        await fetchViaTempRepos(groups, stageSignal);
      } else {
        let pendingGroups = groups;
        if (strategy === 'same-repo') {
          const settled = await Promise.allSettled(
            groups.map((g) => runFetch(targetDir, g.refspecs, {
              workerId: g.id,
              label: `${g.branchCount + g.tagCount} 个 ref`,
              stageSignal,
            })),
          );
          const failures = settled
            .map((r, i) => ({ r, group: groups[i] }))
            .filter(({ r }) => r.status === 'rejected');
          if (failures.length > 0) {
            if (parentAborted) throw failures[0].r.reason;
            const allConcurrency = failures.every(({ r }) => isConcurrencyFailure(r.reason?.stderr));
            if (!allConcurrency) throw failures[0].r.reason;
            for (const { group } of failures) aggregator.remove(group.id);
            onEvent({
              type: 'fallback',
              text: `并发抓取遇到文件锁冲突（${failures.length} 个连接），改用单连接重试剩余 ref`,
            });
            pendingGroups = failures.map(({ group }) => group);
          } else {
            pendingGroups = [];
            for (const g of groups) onEvent({ type: 'worker', id: g.id, state: 'done' });
          }
        }

        if (pendingGroups.length > 0) {
          const refspecs = pendingGroups.flatMap((g) => g.refspecs);
          onEvent({ type: 'phase', phase: 'parallel-serial', text: `串行抓取 ${refspecs.length} 个 ref…` });
          try {
            await runFetch(targetDir, refspecs, { workerId: 'serial', label: `${refspecs.length} 个 ref（串行）`, stageSignal });
          } catch (err) {
            // "cannot lock ref" may be a leftover lock from the aborted workers.
            if (isConcurrencyFailure(err.stderr) && !parentAborted) {
              onEvent({ type: 'log', level: 'warn', text: '检测到残留锁，1 秒后重试…' });
              await new Promise((resolve) => setTimeout(resolve, 1000));
              await runFetch(targetDir, refspecs, { workerId: 'serial', label: `${refspecs.length} 个 ref（串行重试）`, stageSignal });
            } else {
              throw err;
            }
          }
          for (const g of pendingGroups) onEvent({ type: 'worker', id: g.id, state: 'done' });
        }
      }
    }

    // ---- stage C: checkout -------------------------------------------------
    onEvent({ type: 'phase', phase: 'checkout', text: '检出工作区…' });
    await checkout({ targetDir, checkoutRef, defaultRef, remote, gitPath, caps, signal: stageSignal, onEvent });

    // ---- stage D: submodules ----------------------------------------------
    if (recursiveSubmodules && caps.recurseSubmodules) {
      onEvent({ type: 'phase', phase: 'submodules', text: '初始化子模块…' });
      const args = ['submodule', 'update', '--init', '--recursive', '--progress'];
      if (submoduleDepth > 0 && caps.submoduleDepth) args.push(`--depth=${submoduleDepth}`);
      if (submoduleJobs > 0 && caps.submoduleJobs) args.push(`--jobs=${submoduleJobs}`);
      if (effectiveFilter && caps.submoduleFilter) args.push(`--filter=${effectiveFilter}`);
      const splitter = createLineSplitter();
      const res = await run(gitPath, [...configArgs, ...args], {
        cwd: targetDir,
        signal: stageSignal,
        onStderr: (chunk) => {
          for (const line of splitter.push(chunk.toString())) {
            const event = parseProgressLine(line);
            if (event) {
              aggregator.update('submodules', event);
              emitProgress();
              continue;
            }
            const noise = filterNoiseLine(line);
            if (noise) onEvent({ type: 'log', ...noise });
          }
        },
      });
      if (res.code !== 0) {
        throw new Error(`子模块初始化失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
      }
    } else if (recursiveSubmodules && !caps.recurseSubmodules) {
      onEvent({ type: 'log', level: 'warn', text: '当前 git 不支持 --recurse-submodules，已跳过子模块' });
    }

    onEvent({ type: 'progress', snapshot: aggregator.snapshot() });
    const head = (await gitOut(targetDir, ['rev-parse', 'HEAD'])).trim();
    const branch = (await gitOut(targetDir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
    const shallow = (await gitOut(targetDir, ['rev-parse', '--is-shallow-repository']).catch(() => 'false')).trim() === 'true';
    const result = {
      dir: targetDir,
      head,
      branch: branch === 'HEAD' ? null : branch,
      shallow,
      depth: depth || null,
      filter: effectiveFilter,
      elapsedMs: Date.now() - startedAt,
      fetchedRefs: 1 + (branches === 'default' ? 0 : groups.reduce((n, g) => n + g.refspecs.length, 0)),
    };
    onEvent({ type: 'done', result });
    return result;
  } finally {
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function checkout({ targetDir, checkoutRef, defaultRef, remote, gitPath, caps, signal, onEvent }) {
  const want = checkoutRef ?? defaultRef;
  const isBranch = remote.branches.some((b) => b.name === want);
  const isTag = remote.tags.some((t) => t.name === want);
  if (isBranch) {
    const localExists = await gitOut(targetDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${want}`]).catch(() => null);
    if (localExists) {
      await gitRun(targetDir, ['checkout', '--quiet', want], { signal });
    } else {
      await gitRun(targetDir, ['checkout', '--quiet', '-b', want, `refs/remotes/origin/${want}`], { signal });
    }
    onEvent({ type: 'log', level: 'info', text: `已检出分支 ${want}` });
    return;
  }
  if (isTag) {
    await gitRun(targetDir, ['checkout', '--quiet', `refs/tags/${want}`], { signal });
    onEvent({ type: 'log', level: 'info', text: `已检出标签 ${want}（detached HEAD）` });
    return;
  }
  // Commit-ish fallback: let git resolve it.
  await gitRun(targetDir, ['checkout', '--quiet', want], { signal });
  onEvent({ type: 'log', level: 'info', text: `已检出 ${want}（detached HEAD）` });
}

async function isBare(dir) {
  const out = await gitOut(dir, ['rev-parse', '--is-bare-repository']).catch(() => 'false');
  return out.trim() === 'true';
}

async function gitRun(cwd, args, { signal } = {}) {
  const res = await run('git', args, { cwd, signal });
  if (res.code !== 0) {
    throw new Error(`git ${args[0]} 失败：${res.stderr.trim().split('\n').slice(-3).join(' ')}`);
  }
  return res;
}

async function gitOut(cwd, args, { signal } = {}) {
  const res = await run('git', args, { cwd, signal });
  if (res.code !== 0) {
    const err = new Error(`git ${args.join(' ')} 失败：${res.stderr.trim()}`);
    err.stderr = res.stderr;
    throw err;
  }
  return res.stdout;
}
