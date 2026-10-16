// Local HTTP server fixture for the downloader tests: deterministic content,
// optional Range support, and byte-level accounting so tests can prove that a
// resumed download really reused the bytes already on disk.
import http from 'node:http';
import { deterministicBytes } from './mkfixture.js';

export async function startHttpServer({
  size = 6 * 1024 * 1024,
  seed = 7,
  supportRange = true,
  lyingRange = false,
  disposition = null,
  etag = '"fixture-v1"',
  status = null,
  drip = null, // { chunkSize, delayMs } - pace the body so tests can interrupt mid-transfer
} = {}) {
  const content = deterministicBytes(seed, size);
  const stats = { requests: 0, headRequests: 0, rangeRequests: 0, bytesServed: 0 };

  // Sends the body, optionally paced in chunks. Bytes are accounted as they
  // are written out, so an aborted download only counts what was really sent.
  async function sendBody(res, body) {
    if (!drip) {
      res.end(body);
      stats.bytesServed += body.length;
      return;
    }
    const { chunkSize = 256 * 1024, delayMs = 20 } = drip;
    try {
      for (let offset = 0; offset < body.length; offset += chunkSize) {
        if (res.destroyed || res.writableEnded) return;
        const slice = body.subarray(offset, Math.min(offset + chunkSize, body.length));
        res.write(slice);
        stats.bytesServed += slice.length;
        if (res.destroyed) return;
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      if (!res.destroyed && !res.writableEnded) res.end();
    } catch {
      /* client disconnected */
    }
  }

  const server = http.createServer((req, res) => {
    stats.requests += 1;
    req.on('error', () => {});
    res.on('error', () => {});
    const headers = {
      'etag': etag,
      'last-modified': 'Wed, 01 Jan 2025 00:00:00 GMT',
      'accept-ranges': supportRange || lyingRange ? 'bytes' : 'none',
      'content-type': 'application/octet-stream',
    };
    if (disposition) headers['content-disposition'] = disposition;

    if (req.url === '/redirect') {
      res.writeHead(302, { location: '/file.bin' });
      res.end();
      return;
    }
    if (status) {
      res.writeHead(status, headers);
      res.end('error body');
      return;
    }
    if (req.url !== '/file.bin') {
      res.writeHead(404, headers);
      res.end('not found');
      return;
    }

    if (req.method === 'HEAD') {
      stats.headRequests += 1;
      res.writeHead(200, { ...headers, 'content-length': String(content.length) });
      res.end();
      return;
    }

    const range = supportRange ? req.headers.range : null;
    if (range && !lyingRange) {
      const m = /^bytes=(\d+)-(\d*)$/.exec(range);
      if (m) {
        stats.rangeRequests += 1;
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : content.length - 1;
        if (start >= content.length || end >= content.length || start > end) {
          res.writeHead(416, { ...headers, 'content-range': `bytes */${content.length}` });
          res.end();
          return;
        }
        const slice = content.subarray(start, end + 1);
        res.writeHead(206, {
          ...headers,
          'content-range': `bytes ${start}-${end}/${content.length}`,
          'content-length': String(slice.length),
        });
        sendBody(res, slice).catch(() => {});
        return;
      }
    }
    res.writeHead(200, { ...headers, 'content-length': String(content.length) });
    sendBody(res, content).catch(() => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  return {
    content,
    stats,
    base: `http://127.0.0.1:${port}`,
    url(pathname = '/file.bin') {
      return `http://127.0.0.1:${port}${pathname}`;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
