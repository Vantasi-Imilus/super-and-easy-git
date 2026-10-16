// Tiny DOM helper. Always uses textContent (never innerHTML) so URLs or file
// names coming from the network can never be injected as markup.

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value);
    } else if (key in el && typeof value !== 'object') {
      el[key] = value; // value, checked, disabled, title, ...
    } else {
      el.setAttribute(key, value);
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function field(label, control, hint) {
  return h('div', { class: 'field' },
    h('label', { text: label }),
    control,
    hint ? h('span', { class: 'hint', text: hint }) : null);
}

export function checkbox(label, checked = false, onchange) {
  const input = h('input', { type: 'checkbox', checked, onchange: (e) => onchange?.(e.target.checked) });
  return h('label', { class: 'checkline' }, input, label);
}
