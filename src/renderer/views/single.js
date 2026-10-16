// 单仓库加速：多连接并行抓取 ref 组 + 浅克隆/部分克隆，支持断点续传。
import { h, field, checkbox } from '../components/dom.js';
import { createTaskManager } from '../components/tasks.js';

export function mount(root) {
  const view = h('div', { class: 'view' });
  view.append(
    h('h2', { text: '单仓库加速' }),
    h('p', { class: 'lead', text: '先抓取默认分支，再用多个连接并行抓取其余 ref；可选浅克隆、部分克隆与稀疏检出。' }),
  );

  const url = h('input', { type: 'text', placeholder: 'https://github.com/user/repo.git' });
  const baseDir = h('input', { type: 'text', placeholder: '默认：当前工作目录' });
  const browse = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickDirectory('选择保存目录');
      if (picked) baseDir.value = picked;
    },
  });

  const depth = h('input', { type: 'number', min: 0, value: '0', placeholder: '0 = 完整历史' });
  const filter = h('select', {},
    h('option', { value: '', text: '不使用（完整对象）' }),
    h('option', { value: 'blob:none', text: 'blob:none（只取提交/目录，推荐）' }),
    h('option', { value: 'tree:0', text: 'tree:0（最省，按需取目录与文件）' }),
    h('option', { value: 'blob:limit=1m', text: 'blob:limit=1m（大文件按需）' }));
  const branches = h('select', {},
    h('option', { value: 'all', text: '全部分支与标签' }),
    h('option', { value: 'default', text: '仅默认分支' }));
  const jobs = h('input', { type: 'number', min: 1, max: 64, value: '4' });
  const tags = h('input', { type: 'checkbox', checked: true });
  const submodules = h('input', { type: 'checkbox' });
  const checkoutRef = h('input', { type: 'text', placeholder: '留空 = 默认分支；可填分支 / 标签 / 提交' });
  const proxy = h('input', { type: 'text', placeholder: '如 http://127.0.0.1:7890（可选）' });

  const start = h('button', { class: 'btn primary', text: '开始下载' });
  const form = h('div', { class: 'card' },
    field('仓库地址', url),
    field('保存到', h('div', { class: 'input-with-button' }, baseDir, browse)),
    h('div', { class: 'row' },
      field('深度（--depth）', depth, '0 为完整历史，1 为仅最新提交'),
      field('并发连接数', jobs, 'ref 组的分片数量')),
    field('部分克隆过滤（--filter）', filter, '大幅减小首次下载体积，文件在检出时按需获取'),
    field('分支范围', branches),
    h('label', { class: 'checkline' }, tags, '抓取标签'),
    h('label', { class: 'checkline' }, submodules, '递归初始化子模块'),
    h('details', { class: 'advanced' },
      h('summary', { text: '高级选项' }),
      field('检出指定引用', checkoutRef),
      field('HTTP 代理', proxy)),
    h('div', { class: 'actions' }, start));

  const taskList = h('div', { class: 'tasklist' });
  view.append(form, h('div', { class: 'card' }, h('h3', { text: '任务' }), taskList));
  root.append(view);

  const manager = createTaskManager('single', taskList);
  manager.restore();

  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      await manager.start({
        url: url.value.trim(),
        baseDir: baseDir.value.trim() || undefined,
        depth: Number(depth.value) || 0,
        filter: filter.value || 'none',
        branches: branches.value,
        jobs: Number(jobs.value) || 4,
        includeTags: tags.checked,
        recursiveSubmodules: submodules.checked,
        checkoutRef: checkoutRef.value.trim(),
        proxy: proxy.value.trim() || undefined,
      });
    } catch (err) {
      window.alert(`无法开始任务：${err.message}`);
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
