// Creates a local git fixture used by the tests. It is a bare repository served
// over a file:// URL (a plain path would make git use its local optimization,
// which silently ignores --depth and --filter), with uploadpack.allowFilter
// enabled so partial-clone features work during tests.
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { run } from '../../src/engine/proc.js';

export async function git(args, cwd, { allowFail = false, input } = {}) {
  const res = await run('git', args, { cwd, input });
  if (!allowFail && res.code !== 0) {
    throw new Error(`git ${args.join(' ')} 失败（退出码 ${res.code}）：${res.stderr.trim()}`);
  }
  return res;
}

export function deterministicBytes(seed, size) {
  const out = Buffer.allocUnsafe(size);
  let state = (seed * 2654435761) >>> 0 || 1;
  for (let i = 0; i < size; i++) {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    out[i] = state & 0xff;
  }
  return out;
}

// makeFixture() -> { root, work, bare, url, branchNames, tips, tags, cleanup }
export async function makeFixture({
  branches = 20,
  commitsPerBranch = 3,
  filesPerCommit = 5,
  fileSize = 4096,
  allowFilter = true,
  withTags = true,
  tmpRoot = null,
} = {}) {
  const root = tmpRoot ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'gitdl-fx-')));
  const work = path.join(root, 'work');
  const bare = path.join(root, 'bare.git');
  await fsp.mkdir(work, { recursive: true });

  await git(['init', '-q', '-b', 'main'], work);
  await git(['config', 'user.name', 'Fixture'], work);
  await git(['config', 'user.email', 'fixture@example.test'], work);
  await git(['config', 'commit.gpgsign', 'false'], work);

  let seed = 1;
  async function commitFiles(prefix) {
    for (let f = 0; f < filesPerCommit; f++) {
      seed += 1;
      await fsp.writeFile(path.join(work, `${prefix}-${f}.bin`), deterministicBytes(seed, fileSize));
    }
    await git(['add', '-A'], work);
    await git(['commit', '-q', '-m', `fixture commit ${prefix}`], work);
    return (await git(['rev-parse', 'HEAD'], work)).stdout.trim();
  }

  await commitFiles('main-0');

  const branchNames = ['main'];
  for (let b = 1; b <= branches; b++) {
    const name = `b${b}`;
    branchNames.push(name);
    await git(['checkout', '-q', '-b', name, 'main'], work);
    for (let c = 0; c < commitsPerBranch; c++) {
      await commitFiles(`${name}-${c}`);
    }
  }
  await git(['checkout', '-q', 'main'], work);

  const tips = {};
  for (const name of branchNames) {
    tips[name] = (await git(['rev-parse', `refs/heads/${name}`], work)).stdout.trim();
  }

  // Lightweight tag vN on branch bN, plus one annotated tag on main.
  const tags = {};
  if (withTags) {
    for (let b = 1; b <= branches; b++) {
      await git(['tag', `v${b}`, `b${b}`], work);
      tags[`v${b}`] = tips[`b${b}`];
    }
    await git(['tag', '-a', '-m', 'annotated fixture tag', 'vA', 'main'], work);
    tags.vA = tips.main;
  }

  await git(['clone', '-q', '--bare', work, bare], root);
  if (allowFilter) {
    await git(['config', 'uploadpack.allowFilter', 'true'], bare);
  }
  const url = pathToFileURL(bare).href;

  // Fail fast: the tests rely on file:// protocol features actually working.
  const probe = path.join(root, 'probe');
  const probeRes = await run('git', ['clone', '-q', '--depth=1', '--filter=blob:none', url, probe]);
  if (probeRes.code !== 0) {
    throw new Error(
      `fixture 自检失败：file:// 协议下 --depth/--filter 不可用。请检查 git 版本。\n${probeRes.stderr.trim()}`,
    );
  }
  if (allowFilter) {
    const packDir = path.join(probe, '.git', 'objects', 'pack');
    const files = await fsp.readdir(packDir);
    if (!files.some((f) => f.endsWith('.promisor'))) {
      throw new Error('fixture 自检失败：未生成 promisor pack，--filter 未生效（uploadpack.allowFilter 配置无效）');
    }
  }
  await fsp.rm(probe, { recursive: true, force: true });

  return {
    root,
    work,
    bare,
    url,
    branchNames,
    tips,
    tags,
    async cleanup() {
      await fsp.rm(root, { recursive: true, force: true });
    },
  };
}
