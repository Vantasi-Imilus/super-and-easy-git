// Optional URL rewriting for git remotes: an ordered list of prefix rules
// (e.g. https://github.com/ -> https://my-mirror.example/). The first matching
// rule wins; URLs that match nothing are returned unchanged. Rules are user-
// supplied in the settings panel, never bundled, so no third-party service is
// silently trusted.
export function applyMirrorRules(url, rules) {
  const text = String(url ?? '');
  if (!Array.isArray(rules) || rules.length === 0) return text;
  for (const rule of rules) {
    const from = String(rule?.from ?? '').trim();
    const to = String(rule?.to ?? '').trim();
    if (!from || !to || !from.includes('://')) continue;
    if (text.startsWith(from)) return to + text.slice(from.length);
  }
  return text;
}

// Parses the settings textarea format: one "from -> to" pair per line.
export function parseMirrorRules(text) {
  const rules = [];
  for (const rawLine of String(text ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(\S+)\s*->\s*(\S+)$/.exec(line);
    if (m) rules.push({ from: m[1], to: m[2] });
  }
  return rules;
}

export function formatMirrorRules(rules) {
  return (rules ?? []).map((r) => `${r.from} -> ${r.to}`).join('\n');
}
