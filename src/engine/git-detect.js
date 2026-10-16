// Locate the git executable and probe which options it supports, so the
// downloader degrades gracefully instead of passing unknown flags.
import { run } from './proc.js';

let cache = null;

export async function detectGit(gitPath = 'git', { refresh = false } = {}) {
  if (cache && !refresh && cache.path === gitPath) return cache;
  let res;
  try {
    res = await run(gitPath, ['--version'], { timeoutMs: 15000 });
  } catch (err) {
    cache = { ok: false, path: gitPath, error: err.message };
    return cache;
  }
  if (res.code !== 0) {
    cache = { ok: false, path: gitPath, error: res.stderr.trim() || `git --version 退出码 ${res.code}` };
    return cache;
  }
  const m = /git version (\d+)\.(\d+)(?:\.(\d+))?/.exec(res.stdout);
  const versionParsed = m ? { major: +m[1], minor: +m[2], patch: +(m[3] ?? 0) } : null;
  const capabilities = await probeCapabilities(gitPath, versionParsed);
  cache = {
    ok: true,
    path: gitPath,
    version: m ? `${m[1]}.${m[2]}${m[3] ? `.${m[3]}` : ''}` : res.stdout.trim(),
    versionRaw: res.stdout.trim(),
    versionParsed,
    capabilities,
  };
  return cache;
}

function atLeast(version, major, minor) {
  if (!version) return false;
  return version.major > major || (version.major === major && version.minor >= minor);
}

async function probeCapabilities(gitPath, versionParsed) {
  const help = {};
  for (const cmd of ['clone', 'fetch']) {
    try {
      const res = await run(gitPath, [cmd, '-h'], { timeoutMs: 15000 });
      // parse-options help renders negatable flags as "--[no-]foo"; expand them
      // so the checks below can look for plain "--foo" / "--no-foo".
      help[cmd] = (res.stdout + res.stderr).replace(/--\[no-\]([a-zA-Z0-9-]+)/g, '--$1 --no-$1');
    } catch {
      help[cmd] = '';
    }
  }
  const has = (cmd, flag) => help[cmd].includes(flag);
  return {
    filter: has('clone', '--filter') && has('fetch', '--filter'),
    alsoFilterSubmodules: has('clone', '--also-filter-submodules'),
    jobs: has('clone', '--jobs'),
    recurseSubmodules: has('clone', '--recurse-submodules') && has('fetch', '--recurse-submodules'),
    sparse: has('clone', '--sparse'),
    singleBranch: has('clone', '--single-branch'),
    noAutoGc: has('fetch', '--no-auto-gc'),
    noAutoMaintenance: has('fetch', '--no-auto-maintenance'),
    noWriteFetchHead: has('fetch', '--no-write-fetch-head'),
    noTags: has('fetch', '--no-tags'),
    deepen: has('fetch', '--deepen'),
    rejectShallow: has('clone', '--reject-shallow'),
    // `git submodule -h` only prints usage lines, so these are gated on version.
    submoduleJobs: atLeast(versionParsed, 2, 10),
    submoduleDepth: atLeast(versionParsed, 2, 10),
    submoduleFilter: atLeast(versionParsed, 2, 36),
  };
}
