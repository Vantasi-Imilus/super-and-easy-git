// Settings dialog: git binary, default concurrency, proxy and mirror rules.
import { h, field } from './dom.js';

export function mountSettings(container, { onSaved } = {}) {
  const gitPath = h('input', { type: 'text', placeholder: '留空 = 使用 PATH 中的 git' });
  const browseGit = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await window.gitdl.pickFile('选择 git 可执行文件');
      if (picked) gitPath.value = picked;
    },
  });
  const detectBtn = h('button', { class: 'btn', text: '检测' });
  const detectInfo = h('div', { class: 'hint mono' });
  const proxy = h('input', { type: 'text', placeholder: '如 http://127.0.0.1:7890（git 与 HTTP 下载共用）' });
  const concurrency = h('input', { type: 'number', min: 1, max: 64, value: '4' });
  const mirrors = h('textarea', {
    placeholder: 'https://github.com/ -> https://你的镜像前缀/\n每行一条，仅对 git 仓库地址生效；留空则不重写。',
  });
  mirrors.style.minHeight = '90px';
  const saveBtn = h('button', { class: 'btn primary', text: '保存' });
  const closeBtn = h('button', { class: 'btn', text: '关闭' });
  const savedNote = h('span', { class: 'hint' });

  const form = h('div', { class: 'settings-form' },
    h('h2', { text: '设置' }),
    field('git 可执行文件', h('div', { class: 'input-with-button' }, gitPath, browseGit), undefined),
    h('div', { class: 'actions' }, detectBtn, detectInfo),
    field('默认并发数', concurrency, '新建任务时的默认连接数'),
    field('HTTP 代理', proxy, 'git 抓取与 HTTP 下载都会使用'),
    field('镜像重写规则', mirrors, '按前缀替换，可用于加速访问；规则仅保存在本机'),
    h('div', { class: 'dialog-actions' }, savedNote, closeBtn, saveBtn));
  container.append(form);

  detectBtn.addEventListener('click', async () => {
    detectBtn.disabled = true;
    detectInfo.textContent = '检测中…';
    try {
      const det = await window.gitdl.detectGit(gitPath.value.trim() || undefined);
      detectInfo.textContent = det.ok
        ? `git ${det.version}（${det.path}）`
        : `不可用：${det.error}`;
    } finally {
      detectBtn.disabled = false;
    }
  });

  saveBtn.addEventListener('click', async () => {
    await window.gitdl.setSettings({
      gitPath: gitPath.value.trim(),
      proxy: proxy.value.trim(),
      concurrency: Number(concurrency.value) || 4,
      mirrorRulesText: mirrors.value,
    });
    savedNote.textContent = '已保存';
    setTimeout(() => { savedNote.textContent = ''; }, 1500);
    onSaved?.();
  });

  closeBtn.addEventListener('click', () => {
    container.closest('dialog')?.close();
  });

  return {
    async open() {
      const s = await window.gitdl.getSettings();
      gitPath.value = s.gitPath ?? '';
      proxy.value = s.proxy ?? '';
      concurrency.value = String(s.concurrency ?? 4);
      mirrors.value = s.mirrorRulesText ?? '';
      detectInfo.textContent = '';
      container.closest('dialog')?.showModal();
    },
  };
}
