// HEAD/Range probe: decide whether a URL supports segmented, resumable
// downloads and what the file is called.
import path from 'node:path';
import { requestFollowing, HttpError, statusText } from './client.js';
import { sanitizeFileName } from '../util/urlsafe.js';

export function parseContentDisposition(value) {
  if (!value) return null;
  const star = /filename\*\s*=\s*([^']*)'([^']*)'([^;]+)/i.exec(value);
  if (star) {
    try {
      return decodeURIComponent(star[3].trim().replace(/^"|"$/g, ''));
    } catch {
      return star[3].trim().replace(/^"|"$/g, '');
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"|filename\s*=\s*([^;]+)/i.exec(value);
  if (plain) return (plain[1] ?? plain[2]).trim();
  return null;
}

function filenameFromUrl(url) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const base = path.posix.basename(pathname);
    return base || null;
  } catch {
    return null;
  }
}

// probeUrl -> { finalUrl, size, acceptRanges, etag, lastModified, filename, contentType }
// `size` is null when the server does not report a reliable content length.
export async function probeUrl(url, { dispatcher, signal } = {}) {
  let { res, finalUrl } = await requestFollowing(url, { method: 'HEAD', dispatcher, signal });
  // Some servers reject HEAD; retry with a one-byte ranged GET.
  if (res.statusCode === 405 || res.statusCode === 403) {
    await res.body.dump();
    ({ res, finalUrl } = await requestFollowing(url, {
      method: 'GET',
      headers: { range: 'bytes=0-0' },
      dispatcher,
      signal,
    }));
  }
  const status = res.statusCode;
  if (status !== 200 && status !== 206) {
    await res.body.dump().catch(() => {});
    throw new HttpError(`${statusText(status)}（HTTP ${status}）`, { status, url: finalUrl });
  }
  const headers = res.headers;
  const encoded = headers['content-encoding'] && headers['content-encoding'] !== 'identity';
  const contentRange = headers['content-range'];
  let size = null;
  if (contentRange) {
    const m = /\/(\d+)\s*$/.exec(String(contentRange));
    if (m) size = Number(m[1]);
  } else if (headers['content-length'] && !encoded) {
    size = Number(headers['content-length']);
  }
  if (status === 206 && size === 0) size = null;
  const acceptRanges = status === 206
    || /bytes/i.test(String(headers['accept-ranges'] ?? ''))
    || Boolean(contentRange);
  await res.body.dump().catch(() => {});
  const dispositionName = parseContentDisposition(headers['content-disposition']);
  const filename = sanitizeFileName(dispositionName ?? filenameFromUrl(finalUrl) ?? 'download', 'download');
  return {
    finalUrl,
    size: Number.isFinite(size) && size > 0 ? size : null,
    acceptRanges,
    etag: headers.etag ?? null,
    lastModified: headers['last-modified'] ?? null,
    filename,
    contentType: headers['content-type'] ?? null,
  };
}
