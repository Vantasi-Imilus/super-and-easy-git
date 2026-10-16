// Rate-limits a callback so chatty producers (git progress updates) do not
// flood the UI or IPC. Callers that need a final update should invoke the
// wrapped function's `.now()` escape hatch.
export function makeThrottled(fn, intervalMs = 120) {
  let last = 0;
  const wrapped = (...args) => {
    const now = Date.now();
    if (now - last >= intervalMs) {
      last = now;
      fn(...args);
    }
  };
  wrapped.now = (...args) => {
    last = Date.now();
    fn(...args);
  };
  return wrapped;
}
