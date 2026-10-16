// Child-process wrapper. Never uses a shell: arguments are passed as arrays so
// URLs or file names can never be interpreted as shell syntax.
import { spawn } from 'node:child_process';

const MAX_CAPTURE = 256 * 1024; // tail of stdout/stderr kept for error messages

export function abortError(message = '操作已取消') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export function isAbortError(err) {
  return err?.name === 'AbortError';
}

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    // git spawns helper processes (fetch-pack, index-pack); kill the tree.
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      return;
    } catch { /* fall through to plain kill */ }
  }
  try { child.kill('SIGTERM'); } catch { /* already gone */ }
}

function appendTail(buffer, chunk) {
  const next = buffer + chunk;
  return next.length > MAX_CAPTURE ? next.slice(-MAX_CAPTURE) : next;
}

// run(cmd, args, opts) -> { code, signal, stdout, stderr, durationMs }
// opts: { cwd, env, signal (AbortSignal), timeoutMs, onStdout, onStderr,
//         input, captureStdout }
//   input        - string/Buffer written to the child's stdin (then closed);
//                  with `input` set the stream is a pipe instead of 'ignore'.
//   captureStdout- set false for binary output you only want via onStdout.
export function run(cmd, args, opts = {}) {
  const { cwd, env, signal, timeoutMs, onStdout, onStderr, input = null, captureStdout = true } = opts;
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    let child;
    try {
      child = spawn(cmd, args, {
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        windowsHide: true,
        stdio: [input == null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timer = null;

    if (input != null) {
      child.stdin.on('error', () => {}); // the child may exit before reading
      child.stdin.end(input);
    }

    child.stdout.on('data', (chunk) => {
      if (captureStdout) stdout = appendTail(stdout, chunk.toString());
      onStdout?.(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr = appendTail(stderr, chunk.toString());
      onStderr?.(chunk);
    });

    const onAbort = () => {
      aborted = true;
      killTree(child);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    if (timeoutMs) {
      timer = setTimeout(() => {
        aborted = true;
        killTree(child);
      }, timeoutMs);
    }

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      if (timer) clearTimeout(timer);
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });
    child.on('close', (code, sig) => {
      cleanup();
      if (aborted) {
        reject(abortError());
        return;
      }
      resolve({ code, signal: sig, stdout, stderr, durationMs: Date.now() - started });
    });
  });
}
