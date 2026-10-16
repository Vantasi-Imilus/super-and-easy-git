// Renderer entry point: tab router, status bar, engine event fan-out.
// Views are loaded on demand from ./views/<name>.js so that a view that does
// not exist yet degrades to a placeholder instead of breaking the app.
import { h, clear } from './components/dom.js';
import { mountSettings } from './components/settings.js';

const root = document.getElementById('view-root');
const statusText = document.getElementById('status-text');
const statusRight = document.getElementById('status-right');
const gitBadge = document.getElementById('git-badge');

let currentInstance = null;

export function setStatus(text, right) {
  statusText.textContent = text ?? '';
  if (right !== undefined) statusRight.textContent = right ?? '';
}

const PLACEHOLDERS = {
  single: ['单仓库加速', '通过多连接并行抓取 ref 组 + 浅克隆/部分克隆加速单仓库下载（引擎接入中）。'],
  batch: ['批量下载', '一次粘贴多个仓库地址，按并发队列并行克隆（引擎接入中）。'],
  bigfile: ['大文件分发', '把大文件切片推送到 git 仓库，客户端并行拉取分片重组（引擎接入中）。'],
  http: ['HTTP 下载', 'Range 分段多线程下载，支持断点续传（引擎接入中）。'],
};

function placeholder(name) {
  const [title, desc] = PLACEHOLDERS[name] ?? ['未实现', ''];
  return h('div', { class: 'view' },
    h('h2', { text: title }),
    h('p', { class: 'lead', text: desc }),
    h('div', { class: 'empty', text: '该模式将在后续里程碑接入引擎与界面。' }));
}

async function show(name) {
  if (currentInstance?.unmount) {
    try { currentInstance.unmount(); } catch { /* view teardown must never block switching */ }
  }
  currentInstance = null;
  clear(root);
  let mount = null;
  try {
    ({ mount } = await import(`./views/${name}.js`));
  } catch {
    mount = null; // view module not present yet
  }
  if (typeof mount !== 'function') {
    root.append(placeholder(name));
    return;
  }
  currentInstance = mount(root, { setStatus }) ?? null;
}

document.getElementById('tabs').addEventListener('click', (event) => {
  const tab = event.target.closest('.tab');
  if (!tab) return;
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('is-active', t === tab);
  show(tab.dataset.view);
});

const settings = mountSettings(document.getElementById('settings-root'), {
  onSaved: () => refreshGitBadge(),
});
document.getElementById('settings-btn').addEventListener('click', () => {
  settings.open();
});

// Engine events are pushed by the main process; forward them to the active view.
window.gitdl?.onEngineEvent?.((payload) => {
  currentInstance?.onEngineEvent?.(payload);
});

async function refreshGitBadge() {
  try {
    const det = await window.gitdl.detectGit();
    if (det?.ok) {
      gitBadge.textContent = `git: ${det.version}`;
      gitBadge.title = det.path ?? 'git';
      gitBadge.classList.remove('err');
      gitBadge.classList.add('ok');
    } else if (det) {
      gitBadge.textContent = 'git: 不可用';
      gitBadge.title = det.error ?? '';
      gitBadge.classList.remove('ok');
      gitBadge.classList.add('err');
    }
  } catch {
    gitBadge.textContent = 'git: —';
  }
}

async function boot() {
  // Prove the contextBridge + IPC path works, and surface runtime versions.
  try {
    const info = await window.gitdl.appInfo();
    setStatus('就绪', `Electron ${info.electron} · Node ${info.node} · ${info.platform}`);
  } catch (err) {
    setStatus('IPC 不可用', String(err));
  }
  await refreshGitBadge();
}

show('single');
boot();
