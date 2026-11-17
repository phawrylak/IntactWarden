// @ts-check
/**
 * ESLint rule `no-literal-ui-strings`: user-visible text in the extension
 * UI must come from the i18n catalogue (`t()`, `tn()`), never from a string
 * literal. The rule reports a string or template literal that contains a
 * letter when it is used as visible text:
 *
 * - assigned to `textContent`, `innerText`, `title`, `placeholder`, `alt`,
 *   `ariaLabel`, `label` (including `document.title`);
 * - passed to `alert`, `confirm` or `prompt`, `createTextNode`, `append`,
 *   `prepend`, or as a text-bearing attribute to `setAttribute`;
 * - passed in a text position of the UI's DOM helpers (ui/shared/dom.ts):
 *   children of `el(tag, props, ...children)`, the label of `button`,
 *   `checkbox`, `link` and `section`, the children of `mount`;
 * - as a text-bearing attribute in an `attrs` object (`title`,
 *   `placeholder`, `alt`, `aria-label`, ...).
 *
 * Literals without letters (" · ", " — ", "") are allowed: they carry no
 * language. Data shown as data (origins, paths, hashes) is never a literal.
 */

const LETTER = /\p{L}/u;

const TEXT_PROPERTIES = new Set([
  'textContent',
  'innerText',
  'title',
  'placeholder',
  'alt',
  'ariaLabel',
  'label',
]);
const TEXT_ATTRIBUTES = new Set([
  'title',
  'placeholder',
  'alt',
  'aria-label',
  'aria-description',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
]);
const DIALOGS = new Set(['alert', 'confirm', 'prompt']);
const TEXT_METHODS = new Set(['createTextNode', 'append', 'prepend']);

/** Helper name → index of the first argument that is visible text (all later arguments too). */
const DEFAULT_HELPERS = {el: 2, mount: 1, button: 0, checkbox: 1, link: 1, section: 1};

/** @param {import('estree').Node | null | undefined} node */
function textLiteral(node) {
  if (!node) return false;
  if (node.type === 'Literal') return typeof node.value === 'string' && LETTER.test(node.value);
  if (node.type === 'TemplateLiteral')
    return node.quasis.some(q => LETTER.test(q.value.cooked ?? q.value.raw));
  if (node.type === 'ArrayExpression')
    return node.elements.some(e => e !== null && e.type !== 'SpreadElement' && textLiteral(e));
  if (node.type === 'ConditionalExpression')
    return textLiteral(node.consequent) || textLiteral(node.alternate);
  if (node.type === 'LogicalExpression') return textLiteral(node.left) || textLiteral(node.right);
  return false;
}

/** @param {import('estree').Node} callee */
function calleeName(callee) {
  if (callee.type === 'Identifier') return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.property.type === 'Identifier'
  ) {
    return callee.property.name;
  }
  return null;
}

/** @param {import('estree').Property['key']} key */
function keyName(key) {
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'User-visible UI text must come from the i18n catalogue (t/tn), not from string literals.',
    },
    schema: [],
    messages: {
      literal:
        'UI text must come from the i18n catalogue (t/tn), not a string literal (no-literal-ui-strings).',
    },
  },
  create(context) {
    const helpers = DEFAULT_HELPERS;
    /** @param {import('estree').Node} node */
    const report = node => context.report({node, messageId: 'literal'});
    return {
      AssignmentExpression(node) {
        const left = node.left;
        if (
          left.type !== 'MemberExpression' ||
          left.computed ||
          left.property.type !== 'Identifier'
        )
          return;
        if (TEXT_PROPERTIES.has(left.property.name) && textLiteral(node.right)) report(node.right);
      },
      CallExpression(node) {
        const name = calleeName(node.callee);
        if (name === null) return;
        const args = node.arguments;
        if (DIALOGS.has(name) && node.callee.type === 'Identifier') {
          for (const a of args)
            if (textLiteral(/** @type {import('estree').Node} */ (a))) report(a);
          return;
        }
        if (TEXT_METHODS.has(name) && node.callee.type === 'MemberExpression') {
          for (const a of args)
            if (textLiteral(/** @type {import('estree').Node} */ (a))) report(a);
          return;
        }
        if (name === 'setAttribute' && args.length >= 2) {
          const attr = args[0];
          if (
            attr &&
            attr.type === 'Literal' &&
            typeof attr.value === 'string' &&
            TEXT_ATTRIBUTES.has(attr.value.toLowerCase())
          ) {
            if (textLiteral(/** @type {import('estree').Node} */ (args[1]))) report(args[1]);
          }
          return;
        }
        if (node.callee.type === 'Identifier' && Object.hasOwn(helpers, name)) {
          const from = helpers[name] ?? 0;
          args.forEach((a, i) => {
            if (i >= from && textLiteral(/** @type {import('estree').Node} */ (a))) report(a);
          });
        }
      },
      Property(node) {
        // Text-bearing attributes inside an `attrs: {...}` object.
        const parent = /** @type {import('estree').Node & {parent?: import('estree').Node}} */ (
          node
        ).parent;
        const grand = parent && /** @type {{parent?: import('estree').Node}} */ (parent).parent;
        if (!grand || grand.type !== 'Property' || keyName(grand.key) !== 'attrs') return;
        const name = keyName(node.key);
        if (
          name !== null &&
          TEXT_ATTRIBUTES.has(name.toLowerCase()) &&
          textLiteral(/** @type {import('estree').Node} */ (node.value))
        ) {
          report(node.value);
        }
      },
    };
  },
};

export default rule;
