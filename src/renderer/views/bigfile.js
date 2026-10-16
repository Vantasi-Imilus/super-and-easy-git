// 大文件分发：把大文件切片提交到 git 仓库的分片分支，客户端并行拉取重组。
import { h, field } from '../components/dom.js';
import { createTaskManager } from '../components/tasks.js';

function pullForm() {
  const repoUrl = h('input', { type: 'text', placeholder: 'https://github.com/user/file-channel.git' });
  const file = h('input', { type: 'text', placeholder: '发布时的文件名，如 dataset.bin' });
  const out = h('input', { type: 'text', placeholder: '保存到……' });
  const browse = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickSaveFile(out.value.trim() || undefined);
      if (picked) out.value = picked;
    },
  });
  const concurrency = h('input', { type: 'number', min: 1, max: 32, value: '8' });
  const overwrite = h('input', { type: 'checkbox' });
  const proxy = h('input', { type: 'text', placeholder: '如 http://127.0.0.1:7890（可选）' });
  const start = h('button', { class: 'btn primary', text: '开始拉取' });
  const form = h('div', { class: 'card' },
    field('仓库地址', repoUrl),
    field('文件名', file),
    field('保存到', h('div', { class: 'input-with-button' }, out, browse)),
    h('div', { class: 'row' },
      field('并发连接数', concurrency)),
    h('label', { class: 'checkline' }, overwrite, '覆盖已存在的文件'),
    h('details', { class: 'advanced' },
      h('summary', { text: '高级选项' }),
      field('HTTP 代理', proxy)),
    h('div', { class: 'actions' }, start));
  return { form, start, opts: () => ({
    repoUrl: repoUrl.value.trim(),
    file: file.value.trim(),
    out: out.value.trim(),
    concurrency: Number(concurrency.value) || 8,
    overwrite: overwrite.checked,
    proxy: proxy.value.trim() || undefined,
  }) };
}

function pushForm() {
  const file = h('input', { type: 'text', placeholder: '本地待发布的文件' });
  const browse = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickFile('选择要发布的文件');
      if (picked) file.value = picked;
    },
  });
  const repoUrl = h('input', { type: 'text', placeholder: 'https://github.com/user/file-channel.git（需有推送权限）' });
  const shards = h('input', { type: 'number', min: 1, max: 64, value: '8' });
  const chunkSize = h('input', { type: 'number', min: 1, max: 512, value: '32' });
  const start = h('button', { class: 'btn primary', text: '发布到仓库' });
  const form = h('div', { class: 'card' },
    field('本地文件', h('div', { class: 'input-with-button' }, file, browse)),
    field('目标仓库', repoUrl, '分片会推送到该仓库的 dl/manifest 与 dl/shard-* 分支（强制更新这些分支）'),
    h('div', { class: 'row' },
      field('分片数（分支数）', shards),
      field('分块大小（MiB）', chunkSize)),
    h('div', { class: 'actions' }, start));
  return { form, start, opts: () => ({
    file: file.value.trim(),
    repoUrl: repoUrl.value.trim(),
    shards: Number(shards.value) || 8,
    chunkSize: (Number(chunkSize.value) || 32) * 1024 * 1024,
  }) };
}

export function mount(root) {
  const view = h('div', { class: 'view' });
  view.append(
    h('h2', { text: '大文件分发' }),
    h('p', { class: 'lead', text: '把大文件切片，每片一个 blob；拉取端用多个连接并行取分片，按 sha256 校验后重组。适用于把 git 仓库当作分发通道。' }),
  );

  const pull = pullForm();
  const push = pushForm();

  const tabPull = h('button', { class: 'subtab is-active', text: '拉取' });
  const tabPush = h('button', { class: 'subtab', text: '发布' });
  const subtabs = h('div', { class: 'subtabs' }, tabPull, tabPush);
  const slot = h('div');
  slot.append(pull.form);

  tabPull.addEventListener('click', () => {
    tabPull.classList.add('is-active');
    tabPush.classList.remove('is-active');
    slot.replaceChildren(pull.form);
  });
  tabPush.addEventListener('click', () => {
    tabPush.classList.add('is-active');
    tabPull.classList.remove('is-active');
    slot.replaceChildren(push.form);
  });

  const pullList = h('div', { class: 'tasklist' });
  const pushList = h('div', { class: 'tasklist' });
  view.append(
    subtabs, slot,
    h('div', { class: 'card' }, h('h3', { text: '拉取任务' }), pullList),
    h('div', { class: 'card' }, h('h3', { text: '发布任务' }), pushList),
  );
  root.append(view);

  const pullManager = createTaskManager('bigfile-pull', pullList);
  const pushManager = createTaskManager('bigfile-push', pushList);
  pullManager.restore();
  pushManager.restore();

  async function guard(button, fn) {
    button.disabled = true;
    try {
      await fn();
    } catch (err) {
      window.alert(`无法开始任务：${err.message}`);
    } finally {
      button.disabled = false;
    }
  }

  pull.start.addEventListener('click', () => guard(pull.start, () => pullManager.start(pull.opts())));
  push.start.addEventListener('click', () => guard(push.start, () => pushManager.start(push.opts())));

  return {
    onEngineEvent(payload) {
      pullManager.onEngineEvent(payload);
      pushManager.onEngineEvent(payload);
    },
    unmount() {
      pullManager.destroy();
      pushManager.destroy();
    },
  };
}
