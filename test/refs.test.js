import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { planFetchGroups, lsRemote } from '../src/engine/refs.js';
import { makeFixture } from './fixtures/mkfixture.js';

test('planFetchGroups separates the default branch and keeps groups disjoint', () => {
  const branches = ['main', 'a', 'b', 'c', 'd'].map((name) => ({ name, sha: '0'.repeat(40) }));
  const tags = ['v1', 'v2', 'v3'].map((name) => ({ name, sha: '1'.repeat(40), peeledSha: null }));
  const { defaultRef, groups } = planFetchGroups({ branches, tags, defaultBranch: 'main', groupCount: 2, includeTags: true });
  assert.equal(defaultRef, 'main');
  assert.equal(groups.length, 2);

  const all = groups.flatMap((g) => g.refspecs);
  // Every non-default branch appears exactly once.
  for (const name of ['a', 'b', 'c', 'd']) {
    assert.equal(all.filter((r) => r.includes(`refs/heads/${name}:`)).length, 1);
  }
  assert.equal(all.filter((r) => r.includes('refs/heads/main:')).length, 0, 'default branch is not duplicated into groups');
  for (const name of ['v1', 'v2', 'v3']) {
    assert.equal(all.filter((r) => r === `+refs/tags/${name}:refs/tags/${name}`).length, 1);
  }
  // Refspecs map heads to remote-tracking refs and force-update (+).
  assert.ok(all.some((r) => r === '+refs/heads/a:refs/remotes/origin/a'));
  assert.equal(groups[0].branchCount + groups[1].branchCount, 4);
  assert.equal(groups[0].tagCount + groups[1].tagCount, 3);
});

test('planFetchGroups falls back to the first branch when HEAD is unborn or unknown', () => {
  const branches = [{ name: 'trunk', sha: 'x' }];
  const { defaultRef, groups } = planFetchGroups({ branches, tags: [], defaultBranch: 'missing', groupCount: 4 });
  assert.equal(defaultRef, 'trunk');
  assert.equal(groups.length, 0);
});

test('planFetchGroups never creates more groups than there is work', () => {
  const branches = [{ name: 'main', sha: 'x' }, { name: 'only', sha: 'y' }];
  const { groups } = planFetchGroups({ branches, tags: [], defaultBranch: 'main', groupCount: 8 });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].refspecs.length, 1);
});

test('planFetchGroups can exclude tags', () => {
  const branches = [{ name: 'main', sha: 'x' }, { name: 'a', sha: 'y' }];
  const tags = [{ name: 'v1', sha: 'z', peeledSha: null }];
  const { groups } = planFetchGroups({ branches, tags, defaultBranch: 'main', groupCount: 2, includeTags: false });
  assert.equal(groups.flatMap((g) => g.refspecs).some((r) => r.includes('refs/tags/')), false);
});

let fixture;
before(async () => {
  fixture = await makeFixture({ branches: 4, commitsPerBranch: 1, filesPerCommit: 2, fileSize: 512 });
});

after(async () => {
  await fixture?.cleanup();
});

test('lsRemote finds the default branch, branches and tags over file://', async () => {
  const remote = await lsRemote('git', fixture.url);
  assert.equal(remote.defaultBranch, 'main');
  assert.deepEqual(remote.branches.map((b) => b.name).sort(), ['b1', 'b2', 'b3', 'b4', 'main'].sort());
  assert.deepEqual(remote.tags.map((t) => t.name).sort(), ['v1', 'v2', 'v3', 'v4', 'vA']);
  const annotated = remote.tags.find((t) => t.name === 'vA');
  assert.equal(annotated.peeledSha, fixture.tips.main, 'annotated tag exposes its peeled commit');
  const lightweight = remote.tags.find((t) => t.name === 'v2');
  assert.equal(lightweight.peeledSha, null, 'lightweight tag has no peeled line');
  for (const b of remote.branches) {
    assert.equal(b.sha, fixture.tips[b.name], `tip of ${b.name} matches the fixture`);
  }
});

test('lsRemote surfaces a clear error for unreachable remotes', async () => {
  await assert.rejects(lsRemote('git', 'file:///definitely/not/a/repo.git'), /ls-remote 失败/);
});
