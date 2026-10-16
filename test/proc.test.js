import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, isAbortError } from '../src/engine/proc.js';

test('captures stdout, stderr and exit code', async () => {
  const res = await run('node', ['-e', 'console.log("out"); console.error("err");']);
  assert.equal(res.code, 0);
  assert.equal(res.stdout.trim(), 'out');
  assert.equal(res.stderr.trim(), 'err');
  assert.ok(res.durationMs >= 0);
});

test('non-zero exit codes are reported, not thrown', async () => {
  const res = await run('node', ['-e', 'process.exit(3)']);
  assert.equal(res.code, 3);
});

test('arguments are passed literally (no shell interpretation)', async () => {
  const res = await run('node', [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
    'a;b && calc.exe',
    '--upload-pack=evil',
    "$(rm -rf /)",
  ]);
  assert.deepEqual(JSON.parse(res.stdout), ['a;b && calc.exe', '--upload-pack=evil', '$(rm -rf /)']);
});

test('aborting a long-running process rejects with AbortError', async () => {
  const controller = new AbortController();
  const promise = run('node', ['-e', 'setTimeout(() => {}, 60000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(promise, (err) => isAbortError(err));
});

test('a pre-aborted signal never spawns', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run('node', ['-e', 'console.log("should not run")'], { signal: controller.signal }),
    (err) => isAbortError(err),
  );
});

test('timeoutMs kills the process and reports cancellation', async () => {
  await assert.rejects(
    run('node', ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 150 }),
    (err) => isAbortError(err),
  );
});

test('missing executable rejects with a spawn error', async () => {
  await assert.rejects(run('definitely-not-a-real-binary-gitdl', ['x']));
});

test('streams stderr chunks to the callback', async () => {
  const chunks = [];
  await run('node', ['-e', 'process.stderr.write("a"); setTimeout(() => process.stderr.write("b"), 30);'], {
    onStderr: (chunk) => chunks.push(chunk.toString()),
  });
  assert.equal(chunks.join(''), 'ab');
});
