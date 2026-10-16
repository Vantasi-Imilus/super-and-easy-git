import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadRepo, isConcurrencyFailure, planParallelStrategy } from '../src/engine/single-repo.js';
import { isAbortError } from '../src/engine/proc.js';
import { makeFixture, git } from './fixtures/mkfixture.js';

let fx;
let outRoot;

before(async () => {
  fx = await makeFixture({ branches: 20, commitsPerBranch: 2, filesPerCommit: 4, fileSize: 8192 });
  outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-out-'));
});

after(async () => {
  await fx?.cleanup();
  await fsp.rm(outRoot, { recursive: true, force: true }).catch(() => {});
});

async function fsckClean(dir) {
  const res = await git(['fsck', '--strict'], dir, { allowFail: true });
  assert.equal(res.code, 0, `fsck 以非零退出：${res.stderr}`);
  const problems = res.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^dangling /.test(l));
  assert.deepEqual(problems, [], `fsck 发现问题：\n${problems.join('\n')}`);
}

async function assertAllBranchTips(dir) {
  for (const name of fx.branchNames) {
    const out = (await git(['rev-parse', `refs/remotes/origin/${name}`], dir)).stdout.trim();
    assert.equal(out, fx.tips[name], `分支 ${name} 的 tip 与源仓库不一致`);
  }
}

test('planParallelStrategy picks a safe strategy per mode', () => {
  assert.equal(planParallelStrategy({ depth: 0, filter: null }), 'same-repo');
  assert.equal(planParallelStrategy({ depth: 1, filter: null }), 'temp-repos');
  assert.equal(planParallelStrategy({ depth: 1, filter: 'blob:none' }), 'serial');
});

test('isConcurrencyFailure matches real conflict signatures only', () => {
  const real = [
    "error: cannot lock ref 'refs/remotes/origin/x': Unable to create 'C:/repo/.git/refs/remotes/origin/x.lock': File exists.",
    "fatal: Unable to create 'C:/repo/.git/shallow.lock': File exists.",
    'error: shallow file has changed since we read it',
    'fatal: index-pack failed',
    'error: Unable to create temporary file: File exists',
    'fatal: bad object 0000000000000000000000000000000000000000',
    'fatal: early EOF',
  ];
  for (const line of real) assert.equal(isConcurrencyFailure(line), true, `应识别：${line}`);
  const unrelated = [
    "fatal: couldn't find remote ref refs/heads/nope",
    'fatal: Authentication failed for https://example.com/repo',
    'fatal: repository not found',
    'warning: redirecting to https://example.com/',
  ];
  for (const line of unrelated) assert.equal(isConcurrencyFailure(line), false, `不应识别：${line}`);
});

test('full clone: parallel ref groups, fsck clean, all tips match', async () => {
  const dir = path.join(outRoot, 'full');
  const events = [];
  const result = await downloadRepo(
    { url: fx.url, dir, depth: 0, jobs: 4, baseDir: outRoot },
    (e) => events.push(e),
  );
  assert.equal(result.branch, 'main');
  assert.equal(result.shallow, false);
  assert.ok(result.head);
  await fsckClean(dir);
  await assertAllBranchTips(dir);

  // The default branch is fetched first, then the rest in parallel groups.
  const phases = events.filter((e) => e.type === 'phase').map((e) => e.phase);
  assert.ok(phases.includes('default-branch'));
  assert.ok(phases.includes('parallel'));
  assert.ok(phases.includes('checkout'));
  assert.ok(events.some((e) => e.type === 'done'));

  // Progress was reported with real object counts.
  const snaps = events.filter((e) => e.type === 'progress').map((e) => e.snapshot);
  assert.ok(snaps.length > 0, '应产生进度事件');
  assert.ok(snaps.some((s) => s.count > 0), '进度应包含对象计数');
  assert.ok(snaps.every((s) => s.percent == null || (s.percent >= 0 && s.percent <= 1)));

  // Worktree files from the default branch exist.
  const files = await fsp.readdir(dir);
  assert.ok(files.includes('main-0-0.bin'), '工作区应包含默认分支的文件');
});

test('shallow clone uses temp-repo parallelism and still checks out', async () => {
  const dir = path.join(outRoot, 'shallow');
  const events = [];
  const result = await downloadRepo(
    { url: fx.url, dir, depth: 1, jobs: 4, baseDir: outRoot },
    (e) => events.push(e),
  );
  assert.equal(result.shallow, true);
  assert.equal(result.depth, 1);
  await fsckClean(dir);
  await assertAllBranchTips(dir);
  assert.ok(events.some((e) => e.type === 'phase' && e.phase === 'merge'), '浅克隆应走临时仓库合并路径');
  const shallowFlag = (await git(['rev-parse', '--is-shallow-repository'], dir)).stdout.trim();
  assert.equal(shallowFlag, 'true');
  // No temp dirs leak into the result.
  const leftovers = (await fsp.readdir(outRoot)).filter((n) => n.includes('gitdl-tmp'));
  assert.deepEqual(leftovers, [], '临时仓库应被清理');
});

test('partial clone (blob:none) fetches in parallel and lazily materializes files', async () => {
  const dir = path.join(outRoot, 'partial');
  const events = [];
  const result = await downloadRepo(
    { url: fx.url, dir, depth: 0, filter: 'blob:none', jobs: 3, baseDir: outRoot },
    (e) => events.push(e),
  );
  assert.equal(result.filter, 'blob:none');
  const promisor = (await git(['config', 'remote.origin.promisor'], dir)).stdout.trim();
  assert.equal(promisor, 'true');
  await assertAllBranchTips(dir);
  // The blob was filtered out during fetch but checkout materializes it lazily.
  const content = await fsp.readFile(path.join(dir, 'main-0-0.bin'));
  assert.ok(content.length > 0);
});

test('interrupting a download and restarting resumes to a correct repo', async () => {
  const dir = path.join(outRoot, 'resume');
  const controller = new AbortController();
  let aborted = false;
  const first = downloadRepo(
    { url: fx.url, dir, depth: 0, jobs: 4, baseDir: outRoot, signal: controller.signal },
    (e) => {
      // Abort on the phase event that precedes the first fetch: deterministic,
      // unlike waiting for a progress line (a fast machine may finish first).
      if (!aborted && e.type === 'phase' && e.phase === 'default-branch') {
        aborted = true;
        controller.abort();
      }
    },
  );
  try {
    await first;
    assert.fail('中断后的下载不应正常完成');
  } catch (err) {
    assert.ok(isAbortError(err), `中断应产生 AbortError，而不是：${err.message}`);
  }
  assert.equal(aborted, true, '应在下载过程中成功发出中断');

  // Restart on the same directory: git skips already-present objects.
  const result = await downloadRepo({ url: fx.url, dir, depth: 0, jobs: 4, baseDir: outRoot }, () => {});
  assert.equal(result.branch, 'main');
  await fsckClean(dir);
  await assertAllBranchTips(dir);
});

test('branches=default fetches only the default branch', async () => {
  const dir = path.join(outRoot, 'default-only');
  await downloadRepo({ url: fx.url, dir, depth: 1, branches: 'default', jobs: 4, baseDir: outRoot }, () => {});
  const main = await git(['rev-parse', 'refs/remotes/origin/main'], dir);
  assert.equal(main.stdout.trim(), fx.tips.main);
  const others = await git(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/b1'], dir, { allowFail: true });
  assert.notEqual(others.code, 0, '不应存在其他分支的 remote-tracking ref');
});

test('checkoutRef selects a branch or a tag', async () => {
  const branchDir = path.join(outRoot, 'pick-branch');
  await downloadRepo({ url: fx.url, dir: branchDir, depth: 1, jobs: 2, checkoutRef: 'b7', baseDir: outRoot }, () => {});
  const branch = (await git(['rev-parse', '--abbrev-ref', 'HEAD'], branchDir)).stdout.trim();
  assert.equal(branch, 'b7');

  const tagDir = path.join(outRoot, 'pick-tag');
  await downloadRepo({ url: fx.url, dir: tagDir, depth: 1, jobs: 2, checkoutRef: 'v9', baseDir: outRoot }, () => {});
  const head = (await git(['rev-parse', 'HEAD'], tagDir)).stdout.trim();
  assert.equal(head, fx.tips.b9, 'v9（b9 的轻量标签）应被检出');
});

test('refuses to hijack a directory that is not a worktree repository', async () => {
  const dir = path.join(outRoot, 'occupied');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'keep.txt'), 'not a repo');
  await assert.rejects(
    downloadRepo({ url: fx.url, dir, baseDir: outRoot }, () => {}),
    /已存在且不是工作区仓库/,
  );
});

test('rejects dangerous URLs before touching the filesystem', async () => {
  await assert.rejects(
    downloadRepo({ url: '--upload-pack=calc.exe', baseDir: outRoot }, () => {}),
    /不能以 "-" 开头/,
  );
});
