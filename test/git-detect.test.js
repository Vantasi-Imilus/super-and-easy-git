import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectGit } from '../src/engine/git-detect.js';

test('detects the installed git and probes its capabilities', async () => {
  const det = await detectGit();
  assert.equal(det.ok, true, `git 探测失败: ${det.error}`);
  assert.match(det.version, /^\d+\.\d+/);
  assert.ok(det.versionParsed.major >= 2);
  const caps = det.capabilities;
  for (const [name, value] of Object.entries(caps)) {
    assert.equal(typeof value, 'boolean', `能力 ${name} 应为布尔值`);
  }
  assert.equal(caps.filter, true, '现代 git 应支持 --filter');
  assert.equal(caps.noTags, true, 'fetch --no-tags 应存在');
});

test('reports failure for a missing git binary', async () => {
  const det = await detectGit('definitely-not-a-real-git-binary', { refresh: true });
  assert.equal(det.ok, false);
  assert.ok(det.error);
});
