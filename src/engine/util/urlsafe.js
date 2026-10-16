// Input validation. Two threats are handled here:
//  - argument injection: a URL starting with "-" would be parsed by git as an
//    option (e.g. --upload-pack=...), so it is rejected outright;
//  - path traversal: repository and file names derived from URLs must never
//    escape the chosen target directory.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCHEME_RE = /^(https?|git|ssh|git\+ssh|file):\/\//i;
const SCP_RE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\\/].*$/;
const ABS_PATH_RE = /^([A-Za-z]:[\\/]|\/)/;

export function assertSafeGitUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) throw new Error('仓库地址为空');
  if (value.startsWith('-')) throw new Error('仓库地址不能以 "-" 开头（可被 git 解释为参数）');
  if (/[\0\r\n]/.test(value)) throw new Error('仓库地址包含非法字符');
  if (SCHEME_RE.test(value) || SCP_RE.test(value) || ABS_PATH_RE.test(value)) return value;
  throw new Error('不支持的地址形式（支持 http(s)://、git://、ssh://、file://、user@host:path 及绝对路径）');
}

export function assertSafeHttpUrl(url) {
  const value = String(url ?? '').trim();
  if (!value) throw new Error('下载地址为空');
  if (/[\0\r\n]/.test(value)) throw new Error('下载地址包含非法字符');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('不是合法的 URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('仅支持 http/https 下载地址');
  }
  return parsed.toString();
}

// Turn a name into something safe for the local filesystem: no separators, no
// traversal, no control characters, no Windows-reserved names.
export function sanitizeFileName(name, fallback = 'download') {
  let value = String(name ?? '').trim();
  value = value.replace(/[\0-\x1f\x7f]/g, '');
  // Keep only the last path segment: strips both traversal and stray directories.
  const segments = value.split(/[\\/]+/).filter((seg) => seg && seg !== '.' && seg !== '..');
  value = segments.pop() ?? '';
  value = value.replace(/[\\/:*?"<>|]/g, '_');
  value = value.replace(/^\.+/, '').replace(/[ .]+$/, '');
  if (!value) value = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(value)) value = `_${value}`;
  if (value.length > 180) value = value.slice(0, 180);
  return value;
}

export function sanitizeRepoDirName(url, fallback = 'repo') {
  let name = '';
  try {
    if (SCHEME_RE.test(url)) {
      if (/^file:\/\//i.test(url)) {
        name = path.basename(fileURLToPath(url));
      } else {
        const parsed = new URL(url);
        const pathname = decodeURIComponent(parsed.pathname.replace(/\/+$/, ''));
        name = path.posix.basename(pathname);
      }
    } else if (ABS_PATH_RE.test(url)) {
      name = path.basename(url.replace(/[\\/]+$/, ''));
    } else {
      const scp = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:(.*)$/.exec(url);
      const rest = scp ? scp[1] : url;
      name = rest.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
    }
  } catch {
    name = '';
  }
  name = name.replace(/\.git$/i, '');
  return sanitizeFileName(name, fallback);
}

// Join and verify the result stays inside baseDir.
export function joinInside(baseDir, name) {
  const base = path.resolve(baseDir);
  const target = path.resolve(base, name);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error('目标路径越出所选目录');
  }
  return target;
}
