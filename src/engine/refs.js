// Remote ref discovery and splitting into disjoint fetch groups, one group per
// parallel connection. Groups never overlap, so concurrent `git fetch`
// processes into the same repository never fight over the same ref.
import { run } from './proc.js';

export async function lsRemote(gitPath, url, { signal } = {}) {
  const res = await run(gitPath, ['ls-remote', '--symref', url], { signal, timeoutMs: 120000 });
  if (res.code !== 0) {
    throw new Error(`无法读取远端 ref（ls-remote 失败）：${res.stderr.trim() || `退出码 ${res.code}`}`);
  }
  let defaultBranch = null;
  const branches = [];
  const tags = [];
  const byRef = new Map();
  for (const raw of res.stdout.split('\n')) {
    const line = raw.trimEnd();
    if (!line) continue;
    if (line.startsWith('ref: ')) {
      const m = /^ref: (refs\/heads\/\S+)\s+HEAD$/.exec(line);
      if (m) defaultBranch = m[1].slice('refs/heads/'.length);
      continue;
    }
    const m = /^([0-9a-f]{40,64})\s+(\S+)$/.exec(line);
    if (!m) continue;
    const [, sha, ref] = m;
    if (ref.endsWith('^{}')) {
      const base = byRef.get(ref.slice(0, -3));
      if (base) base.peeledSha = sha;
      continue;
    }
    if (ref.startsWith('refs/heads/')) {
      const entry = { name: ref.slice('refs/heads/'.length), sha };
      branches.push(entry);
      byRef.set(ref, entry);
    } else if (ref.startsWith('refs/tags/')) {
      const entry = { name: ref.slice('refs/tags/'.length), sha, peeledSha: null };
      tags.push(entry);
      byRef.set(ref, entry);
    }
    // everything else (refs/pull/*, refs/notes/*, ...) is ignored
  }
  if (!defaultBranch && branches.length > 0) defaultBranch = branches[0].name;
  return { defaultBranch, branches, tags };
}

// planFetchGroups -> { defaultRef, groups: [{ id, refspecs, branchCount, tagCount }] }
// The default branch is fetched alone first (it is what users want usable
// fastest); the rest is round-robined into `groupCount` disjoint groups.
export function planFetchGroups({ branches, tags, defaultBranch, groupCount = 4, includeTags = true }) {
  const defaultRef = defaultBranch && branches.some((b) => b.name === defaultBranch)
    ? defaultBranch
    : (branches[0]?.name ?? null);
  const rest = branches.filter((b) => b.name !== defaultRef);
  const n = Math.max(1, Math.min(groupCount, rest.length + (includeTags ? tags.length : 0) || 1));
  const buckets = Array.from({ length: n }, () => ({ refspecs: [], branchCount: 0, tagCount: 0 }));
  rest.forEach((b, i) => {
    const bucket = buckets[i % n];
    bucket.refspecs.push(`+refs/heads/${b.name}:refs/remotes/origin/${b.name}`);
    bucket.branchCount += 1;
  });
  if (includeTags) {
    tags.forEach((t, i) => {
      const bucket = buckets[i % n];
      bucket.refspecs.push(`+refs/tags/${t.name}:refs/tags/${t.name}`);
      bucket.tagCount += 1;
    });
  }
  const groups = buckets
    .filter((b) => b.refspecs.length > 0)
    .map((b, i) => ({ id: `group-${i + 1}`, refspecs: b.refspecs, branchCount: b.branchCount, tagCount: b.tagCount }));
  return { defaultRef, groups };
}
