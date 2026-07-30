// Java symbol extraction via tree-sitter (tasks 4.2, 4.3).
//
// Produces a SymbolTable: every declared type and member with the facts the differ needs —
// FQN, range, signature, visibility, modifiers, annotations, throws, and a body hash.
//
// NOTE: this lives in the host for Phase A. It moves behind the plugin contract in Phase B.
// See design.md D9. Do not let anything outside src/java/ import tree-sitter directly.

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';
import { createHash } from 'node:crypto';

const parser = new Parser();
parser.setLanguage(Java);

// node-tree-sitter's default read buffer is 32KB. A larger file parses to an EMPTY tree with
// no error raised — silent data loss. Always size the buffer to the input.
const parse = (source) => parser.parse(source, undefined, { bufferSize: source.length + 4096 });

const TYPE_NODES = new Set([
  'class_declaration', 'interface_declaration', 'enum_declaration',
  'record_declaration', 'annotation_type_declaration',
]);
const MEMBER_NODES = new Set([
  'method_declaration', 'constructor_declaration', 'field_declaration',
  'compact_constructor_declaration',
  // Task 2.1a: an enum constant is a public static final member with references of its own — a
  // switch arm, a lookup table, a serialised name. It was absent from this map, so ENUM_CONSTANT
  // change units were never produced at all and the resolution path for them was unreachable.
  'enum_constant',
]);
const KIND_BY_NODE = {
  class_declaration: 'CLASS',
  interface_declaration: 'INTERFACE',
  enum_declaration: 'ENUM',
  record_declaration: 'RECORD',
  annotation_type_declaration: 'ANNOTATION_TYPE',
  method_declaration: 'METHOD',
  constructor_declaration: 'CONSTRUCTOR',
  compact_constructor_declaration: 'CONSTRUCTOR',
  field_declaration: 'FIELD',
  enum_constant: 'ENUM_CONSTANT',
};
const VISIBILITIES = ['public', 'protected', 'private'];

const sha = (s) => createHash('sha256').update(s).digest('hex').slice(0, 16);
const text = (node, src) => src.slice(node.startIndex, node.endIndex);

const rangeOf = (node) => ({
  start: { line: node.startPosition.row, character: node.startPosition.column },
  end: { line: node.endPosition.row, character: node.endPosition.column },
});

function modifiersOf(node, src) {
  const mods = node.children.find((c) => c.type === 'modifiers');
  const annotations = [];
  const keywords = [];
  if (mods) {
    for (const c of mods.children) {
      if (c.type === 'annotation' || c.type === 'marker_annotation') {
        annotations.push(text(c, src).replace(/\s+/g, ' '));
      } else {
        keywords.push(c.type);
      }
    }
  }
  return {
    annotations,
    modifiers: keywords,
    visibility: VISIBILITIES.find((v) => keywords.includes(v)) || 'package-private',
  };
}

// Erase parameter names and generics so a signature is comparable across images.
function paramSignature(node, src) {
  const params = node.childForFieldName('parameters');
  if (!params) return '';
  return params.namedChildren
    .filter((p) => p.type === 'formal_parameter' || p.type === 'spread_parameter')
    .map((p) => {
      const t = p.childForFieldName('type') || p.namedChildren[0];
      const spread = p.type === 'spread_parameter' ? '...' : '';
      return (t ? text(t, src).replace(/\s+/g, '') : '?') + spread;
    })
    .join(',');
}

function throwsOf(node, src) {
  const th = node.children.find((c) => c.type === 'throws');
  if (!th) return [];
  return th.namedChildren.map((c) => text(c, src).trim()).filter(Boolean);
}

function bodyOf(node, src) {
  const body = node.childForFieldName('body');
  if (!body) return { hash: null, size: 0 };
  // Normalise whitespace so reformatting alone is not a change (design: noise suppression).
  const norm = text(body, src).replace(/\s+/g, ' ').trim();
  // size excludes the braces: a trivial/empty body carries no identifying information and
  // must not be treated as evidence of a rename (see diff.mjs similarity).
  return { hash: sha(norm), size: norm.replace(/^\{|\}$/g, '').trim().length };
}

function packageOf(root, src) {
  const pkg = root.namedChildren.find((c) => c.type === 'package_declaration');
  if (!pkg) return '';
  return text(pkg, src).replace(/^package\s+/, '').replace(/;\s*$/, '').trim();
}

export function parseImports(source) {
  const tree = parse(source);
  const out = [];
  for (const c of tree.rootNode.namedChildren) {
    if (c.type !== 'import_declaration') continue;
    const fqn = text(c, source).replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
    out.push({ fqn, line: c.startPosition.row + 1, static: /^import\s+static/.test(text(c, source)) });
  }
  return out;
}

// Returns { package, symbols[], parseError }
export function parseSymbols(source, path) {
  let tree;
  try {
    tree = parse(source);
  } catch (e) {
    return { package: '', symbols: [], parseError: { path, message: e.message } };
  }
  if (tree.rootNode.hasError) {
    // A syntax error does not stop us — tree-sitter recovers. Record it and keep the
    // symbols it did find, rather than dropping the whole file (task 4.3).
    const bad = firstErrorNode(tree.rootNode);
    var parseError = {
      path,
      message: 'syntax error',
      line: bad ? bad.startPosition.row + 1 : null,
    };
  }

  const pkg = packageOf(tree.rootNode, source);
  const symbols = [];

  const walkType = (node, outerFqn) => {
    const nameNode = node.childForFieldName('name');
    if (!nameNode) return;
    const simple = text(nameNode, source);
    const fqn = outerFqn ? `${outerFqn}.${simple}` : (pkg ? `${pkg}.${simple}` : simple);
    const { annotations, modifiers, visibility } = modifiersOf(node, source);

    symbols.push({
      fqn,
      simpleName: simple,
      kind: KIND_BY_NODE[node.type],
      path,
      range: rangeOf(node),
      selectionRange: rangeOf(nameNode),
      signature: typeSignature(node, source, simple),
      visibility,
      modifiers,
      annotations,
      throws: [],
      // Deliberately NOT the body: a type is MODIFIED only when its own declaration changes
      // (extends/implements/type params). Member changes are reported as their own units.
      body: sha(typeSignature(node, source, simple)),
      bodySize: 0,
      declText: declarationLine(node, source),
    });

    const body = node.childForFieldName('body');
    if (!body) return;
    for (const child of memberChildren(body)) {
      if (TYPE_NODES.has(child.type)) { walkType(child, fqn); continue; }
      if (!MEMBER_NODES.has(child.type)) continue;
      collectMember(child, fqn);
    }
  };

  const collectMember = (node, ownerFqn) => {
    const { annotations, modifiers, visibility } = modifiersOf(node, source);
    const kind = KIND_BY_NODE[node.type];

    if (kind === 'FIELD') {
      const typeNode = node.childForFieldName('type');
      const typeText = typeNode ? text(typeNode, source).replace(/\s+/g, '') : '?';
      for (const d of node.namedChildren.filter((c) => c.type === 'variable_declarator')) {
        const nameNode = d.childForFieldName('name');
        if (!nameNode) continue;
        const simple = text(nameNode, source);
        symbols.push({
          fqn: `${ownerFqn}#${simple}`,
          simpleName: simple,
          kind: 'FIELD',
          owner: ownerFqn,
          path,
          range: rangeOf(node),
          selectionRange: rangeOf(nameNode),
          signature: `${typeText} ${simple}`,
          visibility,
          modifiers,
          annotations,
          throws: [],
          body: sha(text(d, source).replace(/\s+/g, ' ')),
          bodySize: text(d, source).replace(/\s+/g, ' ').trim().length,
          // The hash above can only say *that* the declarator changed. A verdict of VALUE_CHANGED has
          // to show the reviewer `false → true`, so the initializer is kept as text (4.4).
          initText: initializerOf(d, source),
          declText: declarationLine(node, source),
        });
      }
      return;
    }

    // An enum constant's "initializer" is its constructor argument list: `TRIAL("trial", 14)`.
    // Changing it changes what every reader of that constant observes, exactly as a field's
    // initializer does, so it travels in the same slot (2.1a).
    if (kind === 'ENUM_CONSTANT') {
      const nameNode = node.childForFieldName('name');
      if (!nameNode) return;
      const simple = text(nameNode, source);
      const args = node.childForFieldName('arguments');
      symbols.push({
        fqn: `${ownerFqn}#${simple}`,
        simpleName: simple,
        kind: 'ENUM_CONSTANT',
        owner: ownerFqn,
        path,
        range: rangeOf(node),
        selectionRange: rangeOf(nameNode),
        signature: `${ownerFqn.split('.').pop()} ${simple}`,
        // An enum constant carries no modifiers of its own: it is implicitly public static final,
        // and reporting 'package-private' here would make every constant look narrower than it is.
        visibility: 'public',
        modifiers: ['static', 'final'],
        annotations,
        throws: [],
        body: sha(text(node, source).replace(/\s+/g, ' ')),
        bodySize: text(node, source).replace(/\s+/g, ' ').trim().length,
        initText: args ? text(args, source).replace(/\s+/g, ' ').trim() : null,
        declText: declarationLine(node, source),
      });
      return;
    }

    const nameNode = node.childForFieldName('name');
    const simple = nameNode ? text(nameNode, source) : ownerFqn.split(/[.#]/).pop();
    const params = paramSignature(node, source);
    const retNode = node.childForFieldName('type');
    symbols.push({
      fqn: `${ownerFqn}#${simple}(${params})`,
      simpleName: simple,
      kind,
      owner: ownerFqn,
      path,
      range: rangeOf(node),
      selectionRange: nameNode ? rangeOf(nameNode) : rangeOf(node),
      signature: `${retNode ? text(retNode, source).replace(/\s+/g, '') + ' ' : ''}${simple}(${params})`,
      visibility,
      modifiers,
      annotations,
      throws: throwsOf(node, source),
      body: bodyOf(node, source).hash,
      bodySize: bodyOf(node, source).size,
      declText: declarationLine(node, source),
    });
  };

  for (const child of tree.rootNode.namedChildren) {
    if (TYPE_NODES.has(child.type)) walkType(child, null);
  }

  // A4 (from F8): the 32KB buffer bug produced empty tables with no error. Any file with a
  // type declaration in it must yield at least one symbol; zero means the parser failed.
  let completeness = null;
  if (symbols.length === 0 && /\b(class|interface|enum|record)\s+\w/.test(source)) {
    completeness = {
      path,
      bytes: source.length,
      message: 'file declares a type but parsed to zero symbols — parser failure, not an empty file',
    };
  }

  return {
    package: pkg,
    symbols,
    parseError: typeof parseError !== 'undefined' ? parseError : null,
    completeness,
  };
}

// Enum bodies nest declarations one level deeper than class bodies.
function memberChildren(body) {
  const out = [];
  for (const c of body.namedChildren) {
    if (c.type === 'enum_body_declarations') out.push(...c.namedChildren);
    else out.push(c);
  }
  return out;
}

// A type's own declaration: kind, name, type params, extends, implements, permits.
function typeSignature(node, src, simple) {
  const parts = [node.type.replace('_declaration', ''), simple];
  for (const field of ['type_parameters', 'superclass', 'interfaces', 'permits']) {
    const c = node.childForFieldName(field) || node.children.find((x) => x.type === field);
    if (c) parts.push(text(c, src).replace(/\s+/g, ''));
  }
  return parts.join(' ');
}

// The right-hand side of one declarator, whitespace-normalised. `null` for a declaration with no
// initializer at all, which is a different fact from an initializer whose text is empty.
function initializerOf(declarator, src) {
  const v = declarator.childForFieldName('value');
  return v ? text(v, src).replace(/\s+/g, ' ').trim() : null;
}

function declarationLine(node, src) {
  const body = node.childForFieldName('body');
  const end = body ? body.startIndex : node.endIndex;
  return src.slice(node.startIndex, end).replace(/\s+/g, ' ').trim().slice(0, 200);
}

function firstErrorNode(node) {
  if (node.type === 'ERROR' || node.isMissing) return node;
  for (const c of node.children) {
    if (!c.hasError && c.type !== 'ERROR') continue;
    const found = firstErrorNode(c);
    if (found) return found;
  }
  return null;
}

// Extract the source text of a symbol from its file, for before/after display.
export function sliceSymbol(source, range) {
  const lines = source.split('\n');
  return lines.slice(range.start.line, range.end.line + 1).join('\n');
}
