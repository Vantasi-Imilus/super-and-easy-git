// Mode 2: batch download of many repositories with a bounded worker pool,
// per-repository retry with backoff, and aggregate progress reporting.
import { downloadRepo } from './single-repo.js';
import { sanitizeRepoDirName, joinInside } from './util/urlsafe.js';
import { isAbortError } from './proc.js';
import { makeThrottled } from './util/throttle.js';

// Derives one target directory per URL, deduplicating names within the batch
// ("repo", "repo-2", ...) so two repositories with the same basename never
// write into the same directory.
export function planTaskDirs(urls, baseDir) {
  const taken = new Set();
  return urls.map((url, index) => {
    const base = sanitizeRepoDirName(url, `repo-${index + 1}`);
    let name = base;
    let n = 2;
    while (taken.has(name.toLowerCase())) {
      name = `${base}-${n}`;
      n += 1;
    }
    taken.add(name.toLowerCase());
    return { id: `t${index + 1}`, index, url, dir: joinInside(baseDir, name) };
  });
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

export async function downloadBatch(opts, onEvent = () => {}) {
  const {
    urls,
    baseDir,
    concurrency = 3,
    retries = 2,
    repoOptions = {},
    signal,
  } = opts;

  const planned = planTaskDirs(urls, baseDir);
  const tasks = planned.map((p) => ({
    ...p,
    state: 'pending',
    error: null,
    attempts: 0,
    snapshot: null,
    result: null,
  }));

  const publicTask = (task) => ({
    id: task.id,
    url: task.url,
    dir: task.dir,
    state: task.state,
    error: task.error,
    attempts: task.attempts,
    result: task.result,
    snapshot: task.snapshot,
  });

  const setState = (task, state) => {
    task.state = state;
    onEvent({ type: 'task', task: publicTask(task) });
  };

  const aggregate = () => {
    let done = 0;
    let failed = 0;
    let active = 0;
    let queued = 0;
    let percentSum = 0;
    let speed = 0;
    let speedPartial = false;
    for (const task of tasks) {
      if (task.state === 'done') {
        done += 1;
        percentSum += 1;
      } else if (task.state === 'failed') {
        failed += 1;
        percentSum += 1;
      } else if (task.state === 'running' || task.state === 'retrying') {
        active += 1;
        percentSum += task.snapshot?.percent ?? 0;
        if (task.snapshot?.speed) {
          speed += task.snapshot.speed;
          speedPartial = speedPartial || Boolean(task.snapshot.speedPartial);
        }
      } else {
        queued += 1;
      }
    }
    return {
      total: tasks.length,
      done,
      failed,
      active,
      queued,
      percent: tasks.length > 0 ? percentSum / tasks.length : 1,
      speed: speed > 0 ? speed : null,
      speedPartial,
    };
  };

  const emitAggregate = makeThrottled(() => {
    onEvent({ type: 'aggregate', aggregate: aggregate() });
  }, 150);

  async function runTask(task) {
    setState(task, 'running');
    for (let attempt = 0; attempt <= retries; attempt++) {
      task.attempts = attempt + 1;
      if (signal?.aborted) {
        task.error = '已暂停';
        setState(task, 'paused');
        return;
      }
      try {
        const result = await downloadRepo(
          { url: task.url, dir: task.dir, baseDir, ...repoOptions, signal },
          (event) => {
            if (event.type === 'progress') {
              task.snapshot = event.snapshot;
              onEvent({ type: 'progress', taskId: task.id, url: task.url, snapshot: event.snapshot });
              emitAggregate();
            } else if (event.type === 'log' && event.level !== 'info') {
              onEvent({ type: 'log', taskId: task.id, level: event.level, text: event.text });
            } else if (event.type === 'phase') {
              onEvent({ type: 'phase', taskId: task.id, text: event.text });
            } else if (event.type === 'fallback') {
              onEvent({ type: 'log', taskId: task.id, level: 'warn', text: event.text });
            }
          },
        );
        task.result = result;
        task.error = null;
        task.snapshot = null;
        setState(task, 'done');
        return;
      } catch (err) {
        if (isAbortError(err) || signal?.aborted) {
          task.error = '已暂停';
          setState(task, 'paused');
          return;
        }
        task.error = err.message;
        if (attempt < retries) {
          const delay = 1000 * 2 ** attempt;
          setState(task, 'retrying');
          onEvent({
            type: 'log',
            taskId: task.id,
            level: 'warn',
            text: `第 ${attempt + 1} 次尝试失败：${err.message}；${delay}ms 后重试`,
          });
          await sleep(delay, signal);
        } else {
          setState(task, 'failed');
        }
      }
    }
  }

  let cursor = 0;
  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const index = cursor;
      cursor += 1;
      if (index >= tasks.length) return;
      await runTask(tasks[index]);
      onEvent({ type: 'aggregate', aggregate: aggregate() });
    }
  };
  const workerCount = Math.max(1, Math.min(concurrency, tasks.length || 1));
  await Promise.all(Array.from({ length: workerCount }, worker));

  const final = aggregate();
  onEvent({ type: 'aggregate', aggregate: final });
  return {
    total: tasks.length,
    succeeded: final.done,
    failed: final.failed,
    paused: tasks.filter((t) => t.state === 'paused').length,
    tasks: tasks.map(publicTask),
  };
}
