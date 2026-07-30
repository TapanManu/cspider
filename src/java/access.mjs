// Read/write classification of a resolved field reference (tasks 3.1, 3.2).
//
// The division of labour, from D2:
//
//   JDT LS  answers WHERE the references are. It is the only authority for that — a grep for a
//           field name matches locals, unrelated fields of the same name, and strings.
//   this    answers WHAT KIND of reference each one is, from the tree-sitter ancestor chain of the
//           identifier at that exact offset. Purely syntactic, purely local to one file.
//
// The rule that shapes everything here: there is no default of READ. A position we cannot reason
// about is UNKNOWN. A field written in five places is a materially different risk from one that is
// only read, and quietly calling an undetermined site a read understates exactly that difference.

import Parser from 'tree-sitter';
import Java from 'tree-sitter-java';

const parser = new Parser();
parser.setLanguage(Java);

// Same 32KB buffer trap as parse.mjs: oversize input parses to an EMPTY tree with no error raised.
const parse = (source) => parser.parse(source, undefined, { bufferSize: source.length + 4096 });

export const DIRECTIONS = ['READ', 'WRITE', 'BOTH', 'UNKNOWN'];

// `=` alone is a pure write. Every compound form reads the old value before storing the new one,
// which makes it genuinely both and not a write that happens to look like one.
const COMPOUND = new Set(['+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '>>>=']);

/** The reference-carrying node at a position: an identifier, or the field_access that owns it. */
function targetAt(root, line, character) {
  const point = { row: line, column: character };
  let node = root.descendantForPosition(point);
  if (!node) return null;
  // A resolved reference position always points at the name itself, so an identifier is what must be
  // there. A position landing on `.` or on whitespace gives back a parent or an anonymous node —
  // descend to a name only when one genuinely covers the offset, and never guess a sibling.
  if (node.type !== 'identifier') {
    const named = node.namedChildren?.find((c) =>
      c.type === 'identifier' && c.startPosition.row === line
      && c.startPosition.column <= character && c.endPosition.column >= character);
    if (!named) return null;
    node = named;
  }
  // `this.flag = x` and `other.flag = x`: the assignment's left operand is the field_access, not
  // the identifier, so the chain has to be lifted through it before the parent is inspected.
  while (node.parent && node.parent.type === 'field_access'
         && node.parent.childForFieldName('field') === node) {
    node = node.parent;
  }
  return node;
}

const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * The direction implied by a JavaBeans accessor name for `field`, or null if the name is not one.
 *
 * Deliberately exact — `getFooBar` is not an accessor for `foo`. A loose prefix match here would
 * attribute an unrelated method's direction to this field, which is worse than UNKNOWN.
 */
function accessorDirection(refName, field) {
  if (!refName || !field) return null;
  const cap = capitalise(field);
  if (refName === `set${cap}`) return 'WRITE';
  if (refName === `get${cap}` || refName === `is${cap}`) return 'READ';
  // Lombok's fluent/chain accessors: `foo(v)` writes, `foo()` reads — indistinguishable by name
  // alone, so they are not claimed here.
  return null;
}

/** Does this offset fall inside a comment? Javadoc `{@link #field}` resolves as a reference. */
function inComment(root, line, character) {
  const node = root.descendantForPosition({ row: line, column: character });
  for (let n = node; n; n = n.parent) {
    if (n.type === 'comment' || n.type === 'line_comment' || n.type === 'block_comment') return true;
  }
  return false;
}

/**
 * Classify one resolved reference.
 *
 * @param source    full text of the file the reference is in
 * @param line      1-based line, as `references` reports it
 * @param character 0-based column
 * @param name      the field's simple name; used only to confirm we are on the right identifier
 * @returns { direction: READ|WRITE|BOTH|UNKNOWN, reason: string|null }
 *
 * `reason` is populated only for UNKNOWN, and is required there: "we could not tell" has to travel
 * with why, or it reads as an internal glitch rather than a limit of the analysis.
 */
export function classifyAccess(source, line, character, name = null) {
  if (typeof source !== 'string' || !source.length) {
    return { direction: 'UNKNOWN', reason: 'source for the using file was not available' };
  }
  let root;
  try {
    root = parse(source).rootNode;
  } catch (e) {
    return { direction: 'UNKNOWN', reason: `using file could not be parsed: ${e.message}` };
  }
  if (!root || root.childCount === 0) {
    return { direction: 'UNKNOWN', reason: 'using file parsed to an empty tree' };
  }

  const node = targetAt(root, line - 1, character);
  if (!node) {
    // Measured on sedai-simulation-server#244: `{@link #defaultVersion}` in a Javadoc block resolves
    // as a reference. It is a real reference and genuinely neither a read nor a write, so it stays
    // UNKNOWN — but the reason has to say documentation, or it reads as a classifier failure.
    if (inComment(root, line - 1, character)) {
      return { direction: 'UNKNOWN', reason: 'documentation reference, not a read or a write' };
    }
    return { direction: 'UNKNOWN', reason: 'no identifier at the resolved position' };
  }
  // A mismatch means the source has moved relative to the position we were given — a stale index, or
  // the wrong image. Reporting READ from the wrong offset would be a fabricated fact.
  // `node` is the identifier, or the field_access that owns it once the chain has been lifted.
  const refName = node.type === 'field_access'
    ? node.childForFieldName('field')?.text : node.text;
  if (name && refName !== name) {
    // An accessor generated by an annotation processor has no source declaration, so JDT resolves a
    // call to it back to the FIELD — the position then lands on `getFoo`/`setFoo`, not on `foo`.
    // That is not a disagreement, it is the reference arriving through its accessor, and it carries
    // a direction: a setter writes and a getter reads. Measured on sedai-simulation-server#244,
    // where 5 of a field's 9 references arrive this way (F5b).
    const via = accessorDirection(refName, name);
    if (via) return { direction: via, reason: null, viaAccessor: refName };
    return {
      direction: 'UNKNOWN',
      reason: `resolved position holds \`${refName ?? '?'}\`, not \`${name}\` — position and source disagree`,
    };
  }

  const parent = node.parent;
  if (!parent) return { direction: 'UNKNOWN', reason: 'reference has no enclosing expression' };

  if (parent.type === 'assignment_expression' && parent.childForFieldName('left') === node) {
    const op = parent.children.find((c) => c.type === '=' || COMPOUND.has(c.type));
    if (!op) {
      return { direction: 'UNKNOWN', reason: 'assignment operator could not be identified' };
    }
    return { direction: op.type === '=' ? 'WRITE' : 'BOTH', reason: null };
  }

  // `++x`, `x--`. tree-sitter-java models both as update_expression with the operand unnamed by
  // field, so containment is the test rather than a field lookup.
  if (parent.type === 'update_expression') return { direction: 'BOTH', reason: null };

  // A declaration's own name is not a usage of it. `references` is asked with
  // includeDeclaration: false, so reaching here means a *different* declaration shadowing the name.
  if (parent.type === 'variable_declarator' && parent.childForFieldName('name') === node) {
    return { direction: 'UNKNOWN', reason: 'position is a declaration name, not a reference' };
  }

  // Everything else evaluates the field: an argument, a condition, a return, a comparison, the
  // right-hand side of somebody else's assignment.
  return { direction: 'READ', reason: null };
}

/**
 * Task 4.9 — `this.x = x` in a constructor or setter.
 *
 * This is a real WRITE and is classified as one; it just carries no information for a reviewer.
 * Suppression happens through the existing disclosed noise mechanism (counted, named, and
 * reversible with --show-noise) rather than by dropping the site, because a write that vanished
 * from the trace would make the write count wrong.
 */
export function selfAssignmentNoise(source, line, name) {
  if (typeof source !== 'string' || !name) return null;
  const text = source.split('\n')[line - 1];
  if (!text) return null;
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(String.raw`^\s*this\.${esc}\s*=\s*${esc}\s*;`).test(text)
    ? 'constructor-parameter-assignment'
    : null;
}
