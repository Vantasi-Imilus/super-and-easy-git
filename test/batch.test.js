import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { downloadBatch, planTaskDirs } from '../src/engine/batch.js';
import { makeFixture, git } from './fixtures/mkfixture.js';

let fx;
let outRoot;

before(async () => {
  fx = await makeFixture({ branches: 2, commitsPerBranch: 1, filesPerCommit: 2, fileSize: 1024, withTags: false });
  outRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-batch-'));
});

after(async () => {
  await fx?.cleanup();
  await fsp.rm(outRoot, { recursive: true, force: true }).catch(() => {});
});

test('planTaskDirs deduplicates directory names within a batch', () => {
  const plan = planTaskDirs(
    ['https://x.example/a/repo.git', 'https://y.example/b/repo.git', 'https://x.example/a/repo.git'],
    process.cwd(),
  );
  assert.equal(path.basename(plan[0].dir), 'repo');
  assert.equal(path.basename(plan[1].dir), 'repo-2');
  assert.equal(path.basename(plan[2].dir), 'repo-3');
});

test('batch downloads in parallel, retries failures and reports per-task state', async () => {
  const badUrl = 'file:///definitely/not/a/repo.git';
  const events = [];
  const result = await downloadBatch({
    urls: [fx.url, fx.url, badUrl],
    baseDir: outRoot,
    concurrency: 2,
    retries: 1,
    repoOptions: { depth: 1, jobs: 2 },
  }, (e) => events.push(e));

  assert.equal(result.total, 3);
  assert.equal(result.succeeded, 2);
  assert.equal(result.failed, 1);

  const byState = Object.fromEntries(result.tasks.map((t) => [path.basename(t.dir), t]));
  assert.equal(byState.bare.state, 'done');
  assert.equal(byState['bare-2'].state, 'done');
  const failedTask = result.tasks.find((t) => t.state === 'failed');
  assert.equal(failedTask.url, badUrl);
  assert.equal(failedTask.attempts, 2, '应按 retries=1 尝试两次');
  assert.ok(failedTask.error, '失败任务应带错误信息');

  // Both good clones are usable.
  for (const dir of ['bare', 'bare-2']) {
    const out = (await git(['rev-parse', 'refs/remotes/origin/main'], path.join(outRoot, dir))).stdout.trim();
    assert.equal(out, fx.tips.main);
  }

  // Retry and aggregate events were emitted.
  assert.ok(events.some((e) => e.type === 'task' && e.task.state === 'retrying'));
  assert.ok(events.some((e) => e.type === 'log' && /重试/.test(e.text)));
  const aggregates = events.filter((e) => e.type === 'aggregate').map((e) => e.aggregate);
  assert.ok(aggregates.length > 0);
  const last = aggregates[aggregates.length - 1];
  assert.equal(last.total, 3);
  assert.equal(last.done, 2);
  assert.equal(last.failed, 1);
});

test('aborting a batch pauses running and queued tasks instead of throwing', async () => {
  const controller = new AbortController();
  let aborted = false;
  const result = await downloadBatch({
    urls: [fx.url, fx.url, fx.url],
    baseDir: outRoot,
    concurrency: 1,
    retries: 0,
    repoOptions: { depth: 1, jobs: 2 },
    signal: controller.signal,
  }, (event) => {
    // Abort as soon as the first task starts running: deterministic, unlike
    // waiting for a progress line (a fast machine may finish the task first).
    if (!aborted && event.type === 'task' && event.task?.state === 'running') {
      aborted = true;
      controller.abort();
    }
  });
  assert.equal(aborted, true, '应在下载过程中触发中止');
  assert.equal(result.failed, 0, '中止不应记为失败');
  assert.ok(
    result.tasks.every((t) => ['done', 'paused', 'pending'].includes(t.state)),
    `中止后任务状态异常：${result.tasks.map((t) => t.state).join(',')}`,
  );
  assert.ok(result.tasks.some((t) => t.state !== 'done'), '应有未完成的任务');
});
