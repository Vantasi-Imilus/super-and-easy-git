// 批量下载：一次粘贴多个仓库地址，按并发队列并行克隆。
import { h, field } from '../components/dom.js';
import { createTaskManager } from '../components/tasks.js';

const STATE_TEXT = {
  pending: '排队中',
  running: '下载中',
  retrying: '重试中',
  done: '完成',
  failed: '失败',
  paused: '已暂停',
};

export function mount(root) {
  const view = h('div', { class: 'view' });
  view.append(
    h('h2', { text: '批量下载' }),
    h('p', { class: 'lead', text: '每行一个仓库地址（# 开头为注释）。仓库之间并发下载，单个仓库内部按单仓库策略加速。' }),
  );

  const urls = h('textarea', { placeholder: 'https://github.com/user/a.git\nhttps://github.com/user/b.git' });
  const baseDir = h('input', { type: 'text', placeholder: '默认：当前工作目录' });
  const browse = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickDirectory('选择保存目录');
      if (picked) baseDir.value = picked;
    },
  });
  const concurrency = h('input', { type: 'number', min: 1, max: 32, value: '3' });
  const depth = h('input', { type: 'number', min: 0, value: '1' });
  const filter = h('select', {},
    h('option', { value: '', text: '不使用' }),
    h('option', { value: 'blob:none', text: 'blob:none（推荐）' }),
    h('option', { value: 'tree:0', text: 'tree:0' }));
  const jobs = h('input', { type: 'number', min: 1, max: 32, value: '4' });
  const start = h('button', { class: 'btn primary', text: '开始批量下载' });

  const form = h('div', { class: 'card' },
    field('仓库地址列表', urls),
    field('保存到', h('div', { class: 'input-with-button' }, baseDir, browse)),
    h('div', { class: 'row' },
      field('并发仓库数', concurrency),
      field('深度（--depth）', depth),
      field('每仓库连接数', jobs)),
    field('部分克隆过滤（--filter）', filter),
    h('div', { class: 'actions' }, start));

  const taskList = h('div', { class: 'tasklist' });
  view.append(form, h('div', { class: 'card' }, h('h3', { text: '任务' }), taskList));
  root.append(view);

  // Batch cards carry a per-repository table fed by sub-task events.
  const rowsByCard = new Map();
  function rowsFor(card) {
    if (!rowsByCard.has(card)) {
      const container = h('div', { class: 'task-row-list' });
      card.el.append(container);
      rowsByCard.set(card, { container, rows: new Map() });
    }
    return rowsByCard.get(card);
  }

  function upsertRow(card, sub) {
    const { container, rows } = rowsFor(card);
    let row = rows.get(sub.id);
    if (!row) {
      const name = h('span', { class: 'name' });
      const state = h('span');
      const note = h('span', { class: 'name' });
      row = { el: h('div', { class: 'task-row' }, state, name, note), name, state, note };
      rows.set(sub.id, row);
      container.append(row.el);
    }
    const shortName = (() => {
      try {
        return decodeURIComponent(new URL(sub.url).pathname.split('/').filter(Boolean).pop() ?? sub.url);
      } catch {
        return sub.url;
      }
    })();
    row.name.textContent = shortName;
    row.state.textContent = STATE_TEXT[sub.state] ?? sub.state;
    row.state.className = sub.state === 'failed' ? 'err' : '';
    row.note.textContent = sub.state === 'failed'
      ? (sub.error ?? '').slice(0, 80)
      : (sub.attempts > 1 ? `第 ${sub.attempts} 次尝试` : '');
  }

  const manager = createTaskManager('batch', taskList, {
    onCard(card, event) {
      if (event.type === 'task' && event.task) upsertRow(card, event.task);
    },
  });
  manager.restore();

  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      await manager.start({
        urls: urls.value,
        baseDir: baseDir.value.trim() || undefined,
        concurrency: Number(concurrency.value) || 3,
        depth: Number(depth.value) || 0,
        filter: filter.value || 'none',
        jobs: Number(jobs.value) || 4,
      });
    } catch (err) {
      window.alert(`无法开始批量任务：${err.message}`);
    } finally {
      start.disabled = false;
    }
  });

  return {
    onEngineEvent(payload) {
      manager.onEngineEvent(payload);
    },
    unmount() {
      manager.destroy();
    },
  };
}
