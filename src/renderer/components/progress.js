// Shared progress widgets: formatted numbers, progress bar, stat row, log console.
import { h } from './dom.js';

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(n, digits = 2) {
  if (n == null || !Number.isFinite(n)) return '—';
  let v = n;
  let u = 0;
  while (v >= 1024 && u < UNITS.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(u === 0 ? 0 : digits)} ${UNITS[u]}`;
}

export function formatSpeed(bytesPerSec) {
  if (bytesPerSec == null || !Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—';
  return `${formatBytes(bytesPerSec, 2)}/s`;
}

export function formatCount(n) {
  return n == null ? '—' : String(n);
}

export function formatDuration(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  const hr = Math.floor(m / 60);
  return `${hr} 时 ${m % 60} 分`;
}

// A progress bar whose width can be driven by a fraction (0..1) or set to
// indeterminate when the producer cannot compute a percentage.
export function createProgressBar() {
  const fill = h('i', { class: 'fill' });
  const el = h('div', { class: 'progress' }, fill);
  return {
    el,
    set(fraction) {
      el.classList.remove('indeterminate');
      const pct = Math.max(0, Math.min(1, fraction ?? 0)) * 100;
      fill.style.width = `${pct.toFixed(1)}%`;
    },
    indeterminate(on = true) {
      el.classList.toggle('indeterminate', on);
      if (!on) fill.style.width = '0%';
    },
  };
}

// Stat row: createStatRow([['speed','速度'], ['eta','剩余']]) -> { el, set(key, text) }
export function createStatRow(defs) {
  const slots = {};
  const el = h('div', { class: 'stat-row' });
  for (const [key, label] of defs) {
    const value = h('b', { text: '—' });
    slots[key] = value;
    el.append(h('span', {}, `${label} `, value));
  }
  return {
    el,
    set(key, text) {
      if (slots[key]) slots[key].textContent = text ?? '—';
    },
  };
}

export function createLogConsole(maxLines = 400) {
  const el = h('div', { class: 'logbox' });
  let lines = 0;
  function appendAtEnd(node) {
    el.append(node);
    lines += 1;
    while (lines > maxLines) {
      el.firstChild.remove();
      lines -= 1;
    }
    el.scrollTop = el.scrollHeight;
  }
  return {
    el,
    append(text, cls) {
      const node = cls ? h('span', { class: cls, text: `${text}\n` }) : document.createTextNode(`${text}\n`);
      appendAtEnd(node);
    },
    clear() {
      el.replaceChildren();
      lines = 0;
    },
  };
}

// Per-worker mini bars: update({id, label, fraction, active})
export function createWorkerGrid() {
  const rows = new Map();
  const el = h('div', { class: 'worker-grid' });
  function entry(id, label) {
    if (!rows.has(id)) {
      const bar = h('i');
      const pct = h('span', { class: 'mono', text: '—' });
      const row = h('div', { class: 'worker' },
        h('span', { text: label ?? id, title: label ?? id }),
        h('div', { class: 'wbar' }, bar),
        pct);
      rows.set(id, { row, bar, pct });
      el.append(row);
    }
    return rows.get(id);
  }
  return {
    el,
    update({ id, label, fraction, text, active = true }) {
      const r = entry(id, label);
      r.row.classList.toggle('active', active);
      if (fraction != null) r.bar.style.width = `${(Math.max(0, Math.min(1, fraction)) * 100).toFixed(1)}%`;
      if (text != null) r.pct.textContent = text;
    },
    clear() {
      rows.clear();
      el.replaceChildren();
    },
  };
}
