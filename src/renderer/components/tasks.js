// Per-view task manager: creates cards for a mode, wires their action buttons
// to the preload API, and routes engine events to the right card.
import { h, clear } from './dom.js';
import { createTaskCard } from './taskcard.js';

export function createTaskManager(mode, listContainer, { onCard } = {}) {
  const cards = new Map();
  const empty = h('div', { class: 'empty', text: '暂无任务' });
  listContainer.append(empty);

  function refreshEmpty() {
    empty.hidden = cards.size > 0;
  }

  function attach(task) {
    const existing = cards.get(task.id);
    if (existing) {
      existing.update(task);
      return existing;
    }
    const card = createTaskCard(task, {
      onPause: () => window.gitdl.pauseTask(task.id),
      onResume: () => window.gitdl.resumeTask(task.id).then((t) => t && card.update(t)),
      onRetry: () => window.gitdl.resumeTask(task.id).then((t) => t && card.update(t)),
      onCancel: () => window.gitdl.cancelTask(task.id).then((t) => t && card.update(t)),
      onRemove: () => window.gitdl.removeTask(task.id).then(() => {
        card.destroy();
        cards.delete(task.id);
        refreshEmpty();
      }),
      onReveal: () => {
        const latest = cards.get(task.id)?.task ?? task;
        const target = latest?.result?.file ?? latest?.optsSummary?.dir ?? '';
        if (target) window.gitdl.revealPath(target);
      },
      onSubTask: (event) => onCard?.(card, event),
    });
    listContainer.prepend(card.el);
    cards.set(task.id, card);
    refreshEmpty();
    onCard?.(card, { type: 'attached' });
    return card;
  }

  return {
    cards,
    attach,
    async start(opts) {
      const task = await window.gitdl.startTask(mode, opts);
      return attach(task);
    },
    async restore() {
      const tasks = await window.gitdl.listTasks();
      for (const task of tasks) {
        if (task.mode === mode) attach(task);
      }
    },
    onEngineEvent(payload) {
      if (!payload) return;
      if (!payload.taskId) {
        // Top-level task update.
        if (payload.type === 'task' && payload.task) {
          const card = cards.get(payload.task.id);
          if (card) card.update(payload.task);
        }
        return;
      }
      const card = cards.get(payload.taskId);
      if (!card) return;
      if (payload.type === 'task' && payload.task) {
        // Sub-task update (batch mode): delegate to the view's row renderer.
        onCard?.(card, payload);
        return;
      }
      card.onEngineEvent(payload);
    },
    destroy() {
      for (const card of cards.values()) card.destroy();
      cards.clear();
      clear(listContainer);
    },
  };
}

// Small helper shared by the views: a text input with a "browse" button.
export function pathField({ label, placeholder, hint, pick, onPick }) {
  const input = h('input', { type: 'text', placeholder: placeholder ?? '' });
  const button = h('button', {
    class: 'btn',
    text: '浏览…',
    onclick: async () => {
      const picked = await onPick();
      if (picked) input.value = picked;
    },
  });
  const control = h('div', { class: 'input-with-button' }, input, button);
  return { input, control, label, hint, pick };
}
