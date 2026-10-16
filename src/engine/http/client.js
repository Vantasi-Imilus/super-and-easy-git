// Shared HTTP plumbing for the downloader modes. Uses undici directly (not
// global fetch) because we need Range requests, streaming bodies, manual
// redirect tracking and proxy dispatchers.
import { ProxyAgent, request } from 'undici';
import { abortError } from '../proc.js';

const USER_AGENT = 'super-and-easy-git/0.1';
const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);

export function makeDispatcher(proxy) {
  return proxy ? new ProxyAgent(proxy) : undefined;
}

export class HttpError extends Error {
  constructor(message, { status = null, url = null } = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
  }
}

// Performs one request, following redirects manually so the caller learns the
// final URL (used for file naming and resume validation). The caller owns the
// returned body stream.
export async function requestFollowing(rawUrl, { method = 'GET', headers = {}, dispatcher, signal, maxRedirects = 10 } = {}) {
  let currentUrl = rawUrl;
  let currentMethod = method;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await request(currentUrl, {
        method: currentMethod,
        headers: { 'user-agent': USER_AGENT, 'accept-encoding': 'identity', ...headers },
        dispatcher,
        signal,
      });
    } catch (err) {
      // Normalize undici's abort flavours into the engine's AbortError.
      if (signal?.aborted || err?.name === 'AbortError' || err?.code === 'UND_ERR_ABORTED') {
        throw abortError();
      }
      throw new HttpError(`请求失败：${err?.cause?.message ?? err.message}`, { url: currentUrl });
    }
    if (REDIRECT_CODES.has(res.statusCode) && res.headers.location) {
      await res.body.dump();
      currentUrl = new URL(String(res.headers.location), currentUrl).toString();
      if (res.statusCode === 303) currentMethod = 'GET';
      continue;
    }
    return { res, finalUrl: currentUrl };
  }
  throw new HttpError('重定向次数过多', { url: rawUrl });
}

export function statusText(status) {
  const map = {
    400: '请求错误',
    401: '需要认证',
    403: '拒绝访问',
    404: '资源不存在',
    405: '方法不被允许',
    407: '需要代理认证',
    429: '请求过于频繁',
    500: '服务器内部错误',
    502: '网关错误',
    503: '服务不可用',
    504: '网关超时',
  };
  return map[status] ?? 'HTTP 错误';
}
