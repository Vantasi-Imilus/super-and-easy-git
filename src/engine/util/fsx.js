// Small filesystem helpers used by every mode.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export async function fileSize(file) {
  try {
    const st = await fsp.stat(file);
    return st.size;
  } catch {
    return null;
  }
}

// Atomic JSON write: write to a temp file in the same directory, then rename.
export async function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp-${process.pid}`;
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2));
  await fsp.rename(tmp, file);
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Is this directory a git repository (worktree or bare)?
export async function isGitRepo(dir) {
  try {
    await fsp.access(path.join(dir, '.git'));
    return true;
  } catch {
    try {
      await fsp.access(path.join(dir, 'HEAD'));
      await fsp.access(path.join(dir, 'objects'));
      return true; // bare
    } catch {
      return false;
    }
  }
}

export async function rmrf(target) {
  await fsp.rm(target, { recursive: true, force: true });
}
