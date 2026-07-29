// External bindings on a field (tasks 5.1–5.3).
//
// Some annotations tie a field to a name that lives OUTSIDE the codebase: a deployment
// configuration key, a JSON wire name, a database column. Change or remove such a field and the
// consequence is invisible to every mechanism this tool has — it is not in the diff, not in the call
// graph, and not in any test. Measured on sedai-simulation-server#244, two removed fields were
// annotated `@Value("${REUSE_SESSION:false}")` and `@Value("${RESET_CORE:false}")`, so the deletion
// retires two deployment keys and nothing in the review says so.
//
// This module extracts the bound name and nothing more. It deliberately does NOT search for the
// consumers of that name: a grep across charts and environment files yields name matches, and R6
// forbids presenting name matches in the same visual language as resolved edges. The disclosure is
// valuable on its own — "this retires the key REUSE_SESSION, whose consumers are outside this
// analysis" is the sentence the reviewer needs.
//
// The recognised set is DATA, not logic. Extending it is one row, and an unrecognised annotation
// simply produces no disclosure rather than a guess.

const SINGLE = String.raw`\(\s*(?:value\s*=\s*)?"([^"]*)"\s*\)`;
const NAMED = (attr) => new RegExp(String.raw`\(\s*(?:.*?,\s*)?${attr}\s*=\s*"([^"]*)"`, 's');

const RECOGNISED = [
  {
    annotation: 'Value',
    kind: 'CONFIG_KEY',
    what: 'deployment configuration key',
    // `@Value("${KEY:default}")`. The default is part of the contract: removing a field whose key
    // defaulted to false is a different risk from one that had no default at all.
    extract: (args) => {
      const m = /^\$\{([^:}]+)(?::(.*))?\}$/s.exec(args.value ?? '');
      if (!m) return args.value ? [{ key: args.value, fallback: null }] : [];
      return [{ key: m[1].trim(), fallback: m[2] ?? null }];
    },
  },
  {
    annotation: 'ConfigurationProperties',
    kind: 'CONFIG_PREFIX',
    what: 'configuration property prefix',
    extract: (args) => {
      const v = args.prefix ?? args.value;
      return v ? [{ key: v, fallback: null }] : [];
    },
  },
  { annotation: 'JsonProperty', kind: 'WIRE_NAME', what: 'JSON wire name' },
  { annotation: 'JsonAlias', kind: 'WIRE_NAME', what: 'accepted JSON alias', many: true },
  { annotation: 'SerializedName', kind: 'WIRE_NAME', what: 'serialised name' },
  { annotation: 'Column', kind: 'DB_COLUMN', what: 'database column', attr: 'name' },
  { annotation: 'JoinColumn', kind: 'DB_COLUMN', what: 'database join column', attr: 'name' },
];

/** Pull `value` and any `name = "..."`-style attributes out of one annotation's argument list. */
function argsOf(text, attr) {
  const out = {};
  const single = new RegExp(`^@[A-Za-z_$][\\w$]*${SINGLE}$`, 's').exec(text.trim());
  if (single) out.value = single[1];
  for (const a of ['prefix', 'value', attr].filter(Boolean)) {
    const m = NAMED(a).exec(text);
    if (m) out[a] = m[1];
  }
  return out;
}

/**
 * Every external binding a field's annotations declare. Returns [] for a field with none, which is
 * the common case and must stay silent rather than producing an empty disclosure.
 */
export function externalBindings(symbol) {
  if (!symbol || symbol.kind !== 'FIELD') return [];
  const out = [];
  for (const raw of symbol.annotations ?? []) {
    const name = /^@([A-Za-z_$][\w$]*)/.exec(String(raw).trim())?.[1];
    if (!name) continue;
    const rule = RECOGNISED.find((r) => r.annotation === name);
    if (!rule) continue;

    const args = argsOf(String(raw), rule.attr);
    let found;
    if (rule.extract) {
      found = rule.extract(args);
    } else if (rule.many) {
      // `@JsonAlias({"a", "b"})` — every alias is part of the accepted wire contract.
      const inner = /\(\s*\{?([^)]*?)\}?\s*\)/s.exec(String(raw))?.[1] ?? '';
      found = [...inner.matchAll(/"([^"]*)"/g)].map((m) => ({ key: m[1], fallback: null }));
    } else {
      const v = rule.attr ? (args[rule.attr] ?? args.value) : args.value;
      found = v ? [{ key: v, fallback: null }] : [];
    }

    for (const f of found) {
      if (!f.key) continue;
      out.push({
        annotation: name, kind: rule.kind, what: rule.what,
        key: f.key, fallback: f.fallback,
      });
    }
  }
  return out;
}

/**
 * What a change to this field does to its external contract. A REMOVED field retires its key; a
 * MODIFIED one may have renamed it, which is a wire-compatibility break rather than a code break.
 *
 * `reach` is always stated: no resolution reaches the consumers of these names, and a disclosure
 * that did not say so would imply the empty consumer list was a finding.
 */
export function bindingChange(unit) {
  const after = externalBindings(unit?.symbol);
  const before = externalBindings(unit?.from?.symbol ?? null);
  if (!after.length && !before.length) return null;

  const keyOf = (b) => `${b.annotation}:${b.key}`;
  const afterKeys = new Set(after.map(keyOf));
  const beforeKeys = new Set(before.map(keyOf));

  const retired = before.filter((b) => !afterKeys.has(keyOf(b)));
  const introduced = after.filter((b) => !beforeKeys.has(keyOf(b)));

  let effect = 'UNCHANGED';
  if (unit?.changeKind === 'REMOVED') effect = 'RETIRED';
  else if (unit?.changeKind === 'ADDED') effect = 'INTRODUCED';
  else if (retired.length && introduced.length) effect = 'RENAMED';
  else if (retired.length) effect = 'RETIRED';
  else if (introduced.length) effect = 'INTRODUCED';

  return {
    effect,
    bindings: effect === 'RETIRED' && unit?.changeKind === 'REMOVED' ? after : (after.length ? after : before),
    retired,
    introduced,
    reach: 'consumers of these names are outside this analysis — no resolution reaches them',
  };
}
