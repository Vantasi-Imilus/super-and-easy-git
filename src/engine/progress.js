// Parsing of `git --progress` stderr output and aggregation across workers.
//
// A real line looks like:
//   Receiving objects:  47% (1234/2600), 12.34 MiB | 5.67 MiB/s
//   remote: Enumerating objects: 100% (2600/2600), done.
//   Resolving deltas:  12% (123/1024)
// Progress updates end with \r (not \n), so callers must split on both.

export function createLineSplitter() {
  let carry = '';
  return {
    push(chunk) {
      const parts = (carry + chunk).split(/[\r\n]/);
      carry = parts.pop() ?? '';
      return parts;
    },
    flush() {
      const rest = carry;
      carry = '';
      return rest ? [rest] : [];
    },
  };
}

const SIZE_UNITS = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3 };

// git pads the percentage to three characters ("  37%"), so leading spaces are
// expected right after the phase prefix.
const OP_RE = /^\s*(\d+)% \((\d+)\/(\d+)\)/;
const SIZE_RE = /, ([\d.]+) (KiB|MiB|GiB|B)(?: \| ([\d.]+) (KiB|MiB|GiB|B)\/s)?/;

const PHASES = [
  ['receiving', 'Receiving objects: '],
  ['resolving', 'Resolving deltas: '],
  ['remote-compressing', 'remote: Compressing objects: '],
  ['remote-counting', 'remote: Counting objects: '],
  ['remote-enumerating', 'remote: Enumerating objects: '],
];

export function parseProgressLine(line) {
  const text = line.trimEnd();
  let rest = null;
  let phase = null;
  for (const [name, prefix] of PHASES) {
    if (text.startsWith(prefix)) {
      phase = name;
      rest = text.slice(prefix.length);
      break;
    }
  }
  if (!phase) return null;
  const op = OP_RE.exec(rest);
  if (!op) {
    // "remote: Enumerating objects: 343, done." carries a count but no percentage.
    if (phase === 'remote-enumerating') {
      const countOnly = /^(\d+), done/.exec(rest);
      if (countOnly) {
        return { phase, percent: null, count: +countOnly[1], total: null, bytes: null, bytesPerSec: null };
      }
    }
    return null;
  }
  const event = { phase, percent: +op[1], count: +op[2], total: +op[3], bytes: null, bytesPerSec: null };
  const size = SIZE_RE.exec(rest.slice(op[0].length));
  if (size) {
    const unit = SIZE_UNITS[size[2]] ?? 1;
    event.bytes = Math.round(parseFloat(size[1]) * unit);
    if (size[4]) event.bytesPerSec = Math.round(parseFloat(size[3]) * (SIZE_UNITS[size[4]] ?? 1));
  }
  return event;
}

const PHASE_PRIORITY = ['receiving', 'remote-compressing', 'remote-counting', 'remote-enumerating', 'resolving'];

// Aggregates several concurrent git processes (workers) into one honest
// snapshot: object counts are summed, speeds are summed per worker, and the
// percentage is object-based (git does not report byte progress).
export class GitProgressAggregator {
  constructor() {
    this.workers = new Map();
  }

  update(workerId, event) {
    const prev = this.workers.get(workerId);
    const now = Date.now();
    const rec = { ...event, ts: now, objectsPerSec: null };
    if (prev && prev.count != null && event.count != null && now > prev.ts) {
      const dt = (now - prev.ts) / 1000;
      const dc = event.count - prev.count;
      if (dt > 0 && dc >= 0) {
        const instant = dc / dt;
        rec.objectsPerSec = prev.objectsPerSec == null ? instant : prev.objectsPerSec * 0.7 + instant * 0.3;
      } else {
        rec.objectsPerSec = prev.objectsPerSec ?? null;
      }
    }
    this.workers.set(workerId, rec);
  }

  remove(workerId) {
    this.workers.delete(workerId);
  }

  reset() {
    this.workers.clear();
  }

  get size() {
    return this.workers.size;
  }

  snapshot() {
    const all = [...this.workers.values()];
    if (all.length === 0) {
      return { percent: null, count: 0, total: 0, workers: 0, speed: null, speedPartial: false, objectsPerSec: null, phase: null };
    }
    // Prefer the client-side "Receiving" progress; otherwise aggregate whatever
    // phase the workers are in (server-side counting, enumerating, ...).
    const receiving = all.filter((w) => w.phase === 'receiving');
    const pool = receiving.length > 0 ? receiving : all;
    let count = 0;
    let total = 0;
    for (const w of pool) {
      count += w.count ?? 0;
      total += w.total ?? 0;
    }
    const now = Date.now();
    let speed = 0;
    let speedKnown = 0;
    let speedMissing = 0;
    let objectsPerSec = 0;
    let opsKnown = 0;
    for (const w of pool) {
      if (w.bytesPerSec != null && now - w.ts < 5000) {
        speed += w.bytesPerSec;
        speedKnown += 1;
      } else {
        speedMissing += 1;
      }
      if (w.objectsPerSec != null && now - w.ts < 5000) {
        objectsPerSec += w.objectsPerSec;
        opsKnown += 1;
      }
    }
    let phase = null;
    for (const name of PHASE_PRIORITY) {
      if (all.some((w) => w.phase === name)) {
        phase = name;
        break;
      }
    }
    return {
      percent: total > 0 ? Math.min(1, count / total) : null,
      count,
      total,
      workers: all.length,
      phase,
      speed: speedKnown > 0 ? speed : null,
      speedPartial: speedMissing > 0 && speedKnown > 0,
      objectsPerSec: speedKnown === 0 && opsKnown > 0 ? objectsPerSec : null,
    };
  }
}
