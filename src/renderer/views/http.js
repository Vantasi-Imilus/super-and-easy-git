// HTTP 多线程下载：Range 分段 + 断点续传，服务器不支持时自动回退单连接。
import { h, field } from '../components/dom.js';
import { createTaskManager } from '../components/tasks.js';

export function mount(root) {
  const view = h('div', { class: 'view' });
  view.append(
    h('h2', { text: 'HTTP 下载' }),
    h('p', { class: 'lead', text: '把文件切成多段并行下载（Range），中断后从断点继续；不支持 Range 的服务器自动回退为单连接。' }),
  );

  const url = h('input', { type: 'text', placeholder: 'https://example.com/big-file.iso' });
  const dir = h('input', { type: 'text', placeholder: '默认：系统下载目录' });
  const browse = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickDirectory('选择保存目录');
      if (picked) dir.value = picked;
    },
  });
  const concurrency = h('input', { type: 'number', min: 1, max: 64, value: '4' });
  const filename = h('input', { type: 'text', placeholder: '留空 = 使用服务器提供的文件名' });
  const sha256 = h('input', { type: 'text', placeholder: '可选：下载完成后校验' });
  const overwrite = h('input', { type: 'checkbox' });
  const proxy = h('input', { type: 'text', placeholder: '如 http://127.0.0.1:7890（可选）' });
  const start = h('button', { class: 'btn primary', text: '开始下载' });

  const form = h('div', { class: 'card' },
    field('下载地址', url),
    field('保存目录', h('div', { class: 'input-with-button' }, dir, browse)),
    h('div', { class: 'row' },
      field('并发连接数', concurrency),
      field('文件名（可选）', filename)),
    field('sha256 校验（可选）', sha256),
    h('label', { class: 'checkline' }, overwrite, '覆盖已存在的文件'),
    h('details', { class: 'advanced' },
      h('summary', { text: '高级选项' }),
      field('HTTP 代理', proxy)),
    h('div', { class: 'actions' }, start));

  const taskList = h('div', { class: 'tasklist' });
  view.append(form, h('div', { class: 'card' }, h('h3', { text: '任务' }), taskList));
  root.append(view);

  const manager = createTaskManager('http', taskList);
  manager.restore();

  start.addEventListener('click', async () => {
    start.disabled = true;
    try {
      await manager.start({
        url: url.value.trim(),
        dir: dir.value.trim() || undefined,
        concurrency: Number(concurrency.value) || 4,
        filename: filename.value.trim() || undefined,
        expectedSha256: sha256.value.trim() || undefined,
        overwrite: overwrite.checked,
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
