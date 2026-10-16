// Shared task card: state chip, progress bar, live stats, worker/segment bars,
// log console and state-dependent actions. Used by all four mode views.
import { h } from './dom.js';
import {
  createProgressBar,
  createStatRow,
  createLogConsole,
  createWorkerGrid,
  formatSpeed,
  formatDuration,
} from './progress.js';

const STATE_LABELS = {
  running: '下载中',
  retrying: '重试中',
  paused: '已暂停',
  interrupted: '已中断（可继续）',
  done: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

export function createTaskCard(task, handlers = {}) {
  const chip = h('span', { class: 'state-chip' });
  const title = h('div', { class: 'task-title' });
  const subtitle = h('div', { class: 'task-sub' });
  const resultLine = h('div', { class: 'task-sub mono' });

  const btn = (label, cls, fn) => h('button', { class: `btn small ${cls ?? ''}`.trim(), text: label, onclick: fn });
  const btnPause = btn('暂停', '', () => handlers.onPause?.());
  const btnResume = btn('继续', 'primary', () => handlers.onResume?.());
  const btnRetry = btn('重试', 'primary', () => handlers.onRetry?.());
  const btnReveal = btn('打开位置', '', () => handlers.onReveal?.());
  const btnCancel = btn('取消', 'danger', () => handlers.onCancel?.());
  const btnRemove = btn('移除', '', () => handlers.onRemove?.());
  const actions = h('div', { class: 'actions-inline' }, btnPause, btnResume, btnRetry, btnReveal, btnCancel, btnRemove);

  const bar = createProgressBar();
  const stats = createStatRow([
    ['percent', '进度'],
    ['speed', '速度'],
    ['connections', '连接'],
    ['elapsed', '耗时'],
  ]);
  const workers = createWorkerGrid();
  const log = createLogConsole(300);
  const logBox = h('details', { class: 'advanced' }, h('summary', { text: '日志' }), log.el);

  const el = h('div', { class: 'task' },
    h('div', { class: 'task-head' },
      chip,
      h('div', { class: 'task-title-wrap' }, title, subtitle, resultLine),
      actions),
    bar.el,
    stats.el,
    workers.el,
    logBox);

  let current = task;
  let speed = null;
  let percent = null;
  let connections = null;
  let progressText = null;
  let elapsedTimer = null;

  function elapsedMs() {
    if (!current) return null;
    if (current.elapsedMs != null) return current.elapsedMs;
    if (current.startedAt) return Date.now() - current.startedAt;
    return null;
  }

  function render() {
    const state = current?.state ?? 'running';
    chip.textContent = STATE_LABELS[state] ?? state;
    chip.className = `state-chip ${state}`;
    title.textContent = current?.title ?? '';
    subtitle.textContent = current?.subtitle ?? '';
    resultLine.textContent = current?.error
      ? `错误：${current.error}`
      : (current?.state === 'done' && current?.result?.file ? `已保存：${current.result.file}` : '');

    const p = current?.state === 'done' ? 1 : (percent ?? current?.progress ?? null);
    if (p != null) bar.set(p);
    else if (state === 'running' || state === 'retrying') bar.indeterminate(true);
    else bar.set(0);
    if (p != null) bar.indeterminate(false);

    stats.set('percent', p != null ? `${(p * 100).toFixed(1)}%` : (progressText ?? '—'));
    stats.set('speed', formatSpeed(speed));
    stats.set('connections', connections != null ? String(connections) : '—');
    stats.set('elapsed', formatDuration(elapsedMs()));

    const running = state === 'running' || state === 'retrying';
    btnPause.hidden = !running;
    btnCancel.hidden = !running;
    btnResume.hidden = !(state === 'paused' || state === 'interrupted');
    btnRetry.hidden = state !== 'failed';
    btnReveal.hidden = !(state === 'done' && current?.result?.file);
    btnRemove.hidden = running;

    if (!running && elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    } else if (running && !elapsedTimer) {
      elapsedTimer = setInterval(() => stats.set('elapsed', formatDuration(elapsedMs())), 1000);
    }
  }

  function onEngineEvent(event) {
    if (!event) return;
    switch (event.type) {
      case 'progress': {
        const snap = event.snapshot ?? {};
        percent = snap.percent ?? event.percent ?? percent;
        speed = snap.bytesPerSec ?? speed;
        connections = snap.connections ?? event.connections ?? connections;
        if (snap.segments) {
          for (const seg of snap.segments) {
            workers.update({
              id: `seg-${seg.index}`,
              label: `分片 ${seg.index + 1}`,
              fraction: seg.length ? seg.done / seg.length : 0,
              text: `${((seg.length ? seg.done / seg.length : 0) * 100).toFixed(0)}%`,
            });
          }
        }
        if (event.text) {
          progressText = event.text;
          workers.update({ id: 'phase', label: event.text, fraction: percent, text: percent != null ? `${(percent * 100).toFixed(0)}%` : '' });
        }
        break;
      }
      case 'phase':
        progressText = event.text;
        if (event.text) log.append(`— ${event.text}`);
        break;
      case 'worker':
        workers.update({
          id: event.id,
          label: event.label ?? event.id,
          fraction: event.state === 'done' ? 1 : 0,
          text: event.state === 'done' ? '完成' : '进行中',
          active: event.state !== 'done',
        });
        break;
      case 'log':
        log.append(`${event.level === 'error' ? '✗ ' : event.level === 'warn' ? '! ' : ''}${event.text}`,
          event.level === 'error' ? 'err' : '');
        break;
      case 'fallback':
        log.append(`⚠ ${event.text}`, '');
        break;
      case 'task': // batch sub-task updates are rendered by the view
        handlers.onSubTask?.(event);
        break;
      case 'aggregate': {
        const agg = event.aggregate ?? {};
        percent = agg.percent ?? percent;
        speed = agg.speed ?? speed;
        connections = agg.active ?? connections;
        progressText = `完成 ${agg.done}/${agg.total}${agg.failed ? ` · 失败 ${agg.failed}` : ''}`;
        break;
      }
      default:
        break;
    }
    render();
  }

  function update(nextTask) {
    current = nextTask;
    if (nextTask?.state === 'done') {
      percent = 1;
      speed = null;
      connections = 0;
    }
    render();
  }

  render();

  return {
    el,
    update,
    onEngineEvent,
    get task() {
      return current;
    },
    destroy() {
      if (elapsedTimer) clearInterval(elapsedTimer);
      el.remove();
    },
  };
}
