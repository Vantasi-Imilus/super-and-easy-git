import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLineSplitter, parseProgressLine, GitProgressAggregator } from '../src/engine/progress.js';

// Real samples captured from git 2.52.0.windows.1 on this machine. The parser
// is tested against actual output, never against guessed formats.
const SAMPLES = {
  enumerating: 'remote: Enumerating objects: 343, done.        ',
  counting: 'remote: Counting objects:  37% (127/343)        ',
  compressing: 'remote: Compressing objects: 100% (7/7), done.        ',
  receivingStart: 'Receiving objects:  14% (1/7)',
  receivingDone: 'Receiving objects: 100% (7/7), 320.45 KiB | 4.93 MiB/s, done.',
  receivingMid: 'Receiving objects:  47% (1234/2600), 12.34 MiB | 5.67 MiB/s',
  resolving: 'Resolving deltas:  12% (123/1024)',
};

test('line splitter handles \\r updates and partial chunks', () => {
  const splitter = createLineSplitter();
  assert.deepEqual(splitter.push('Receiving objects:  14% (1/7)\rReceiving obj'), [
    'Receiving objects:  14% (1/7)',
  ]);
  // The carry buffer reassembles the line that was split across chunks.
  assert.deepEqual(splitter.push('ects:  28% (2/7)\rReceiving objects: 100% (7/7)\n'), [
    'Receiving objects:  28% (2/7)',
    'Receiving objects: 100% (7/7)',
  ]);
  assert.deepEqual(splitter.flush(), []);
});

test('parses every observed phase format', () => {
  assert.deepEqual(parseProgressLine(SAMPLES.enumerating), {
    phase: 'remote-enumerating', percent: null, count: 343, total: null, bytes: null, bytesPerSec: null,
  });
  assert.deepEqual(parseProgressLine(SAMPLES.counting), {
    phase: 'remote-counting', percent: 37, count: 127, total: 343, bytes: null, bytesPerSec: null,
  });
  assert.deepEqual(parseProgressLine(SAMPLES.compressing), {
    phase: 'remote-compressing', percent: 100, count: 7, total: 7, bytes: null, bytesPerSec: null,
  });
  assert.deepEqual(parseProgressLine(SAMPLES.receivingStart), {
    phase: 'receiving', percent: 14, count: 1, total: 7, bytes: null, bytesPerSec: null,
  });
  const done = parseProgressLine(SAMPLES.receivingDone);
  assert.equal(done.phase, 'receiving');
  assert.equal(done.percent, 100);
  assert.equal(done.bytes, Math.round(320.45 * 1024));
  assert.equal(done.bytesPerSec, Math.round(4.93 * 1024 * 1024));
  const mid = parseProgressLine(SAMPLES.receivingMid);
  assert.equal(mid.bytes, Math.round(12.34 * 1024 * 1024));
  assert.equal(mid.bytesPerSec, Math.round(5.67 * 1024 * 1024));
  assert.deepEqual(parseProgressLine(SAMPLES.resolving), {
    phase: 'resolving', percent: 12, count: 123, total: 1024, bytes: null, bytesPerSec: null,
  });
});

test('ignores unrelated output lines', () => {
  assert.equal(parseProgressLine('remote: Total 7 (delta 0), reused 0 (delta 0), pack-reused 0 (from 0)'), null);
  assert.equal(parseProgressLine("Cloning into 'foo'..."), null);
  assert.equal(parseProgressLine(''), null);
  assert.equal(parseProgressLine('Resolving deltas: done.'), null);
});

test('aggregator sums object counts and speeds across workers', () => {
  const agg = new GitProgressAggregator();
  agg.update('g1', { phase: 'receiving', percent: 50, count: 100, total: 200, bytes: null, bytesPerSec: 1024 * 1024 });
  agg.update('g2', { phase: 'receiving', percent: 50, count: 50, total: 100, bytes: null, bytesPerSec: 2 * 1024 * 1024 });
  const snap = agg.snapshot();
  assert.equal(snap.percent, 0.5); // (100+50)/(200+100)
  assert.equal(snap.count, 150);
  assert.equal(snap.total, 300);
  assert.equal(snap.speed, 3 * 1024 * 1024);
  assert.equal(snap.speedPartial, false);
  assert.equal(snap.workers, 2);
});

test('aggregator reports partial speed and no fabricated byte totals', () => {
  const agg = new GitProgressAggregator();
  agg.update('g1', { phase: 'receiving', percent: 10, count: 10, total: 100, bytes: null, bytesPerSec: 4096 });
  agg.update('g2', { phase: 'receiving', percent: 10, count: 5, total: 50, bytes: null, bytesPerSec: null });
  const snap = agg.snapshot();
  assert.equal(snap.speed, 4096);
  assert.equal(snap.speedPartial, true);
});

test('aggregator falls back to objects-per-second when git reports no speed', () => {
  const agg = new GitProgressAggregator();
  agg.update('g1', { phase: 'receiving', percent: 10, count: 10, total: 100, bytes: null, bytesPerSec: null });
  busyWait(5); // give the aggregator a positive time delta
  agg.update('g1', { phase: 'receiving', percent: 20, count: 20, total: 100, bytes: null, bytesPerSec: null });
  const snap = agg.snapshot();
  assert.equal(snap.speed, null);
  assert.ok(snap.objectsPerSec > 0);
});

function busyWait(ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* spin */ }
}

test('aggregator handles enumerating-only phase (no percentage)', () => {
  const agg = new GitProgressAggregator();
  agg.update('g1', parseProgressLine(SAMPLES.enumerating));
  const snap = agg.snapshot();
  assert.equal(snap.percent, null);
  assert.equal(snap.count, 343);
  assert.equal(snap.phase, 'remote-enumerating');
});

test('aggregator forgets removed workers', () => {
  const agg = new GitProgressAggregator();
  agg.update('g1', { phase: 'receiving', percent: 10, count: 10, total: 100, bytes: null, bytesPerSec: null });
  agg.update('g2', { phase: 'receiving', percent: 10, count: 10, total: 100, bytes: null, bytesPerSec: null });
  agg.remove('g2');
  const snap = agg.snapshot();
  assert.equal(snap.workers, 1);
  assert.equal(snap.total, 100);
});
