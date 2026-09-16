import * as sax from 'sax';
import {
  ContentModel,
  ElementDeclaration,
  AttributeDeclaration,
  FormatHints,
  SymbolDefinition,
  NamespaceHint,
  SymbolHint,
  ExclusiveRule,
  WhenRule,
} from './contentModel';

// A node in the RNG content tree. A define's container is represented as a node
// with an empty elementName; each <element> (named or wildcard) is its own node.
interface RngNode {
  elementName: string;        // '' for define containers and wildcard elements
  isWildcard: boolean;        // <element> with <anyName>/<nsName> instead of name=""
  wildcardAny: boolean;       // wildcard admits arbitrary names (not only an <except> list)
  documentation: string;
  attributes: AttributeDeclaration[];
  childRefs: string[];        // <ref name="…"> directly under this node
  childElements: RngNode[];   // <element> directly nested under this node
  allowsText: boolean;
  format?: FormatHints;       // <lsp:format> annotation on this element
  docUrl?: string;            // <lsp:doc>
  symbol?: SymbolHint;        // <lsp:symbol>
  exclusives?: ExclusiveRule[]; // <lsp:exclusive>
  whens?: WhenRule[];         // <lsp:when>
}

interface ParseState {
  defines: Map<string, RngNode>;   // define name → container node
  startRef: string;
  namespace: string;
  namespaces: NamespaceHint[];     // <lsp:namespace> at grammar level
  builtins: Map<string, string[]>; // <lsp:builtin> at grammar level
  // Innermost open node is at the end (define container or element).
  nodeStack: RngNode[];
  inStart: boolean;
  currentAttribute: Partial<AttributeDeclaration> | null;
  currentValues: { value: string; documentation?: string }[];
  // Track if currently inside optional/zeroOrMore (attribute becomes not required)
  optionalDepth: number;
  // Nesting inside <except> of a name class (<anyName><except>…</except></anyName>)
  exceptDepth: number;
  // Text accumulation
  textBuffer: string;
  capturingText: 'documentation' | 'value' | 'pattern' | null;
}

function newNode(elementName: string, isWildcard: boolean): RngNode {
  return {
    elementName,
    isWildcard,
    wildcardAny: false,
    documentation: '',
    attributes: [],
    childRefs: [],
    childElements: [],
    allowsText: false,
  };
}

export function parseRng(content: string): ContentModel {
  const state: ParseState = {
    defines: new Map(),
    startRef: '',
    namespace: '',
    namespaces: [],
    builtins: new Map(),
    nodeStack: [],
    inStart: false,
    currentAttribute: null,
    currentValues: [],
    optionalDepth: 0,
    exceptDepth: 0,
    textBuffer: '',
    capturingText: null,
  };

  const parser = sax.parser(true, { trim: false });

  const topNode = (): RngNode | null =>
    state.nodeStack.length > 0 ? state.nodeStack[state.nodeStack.length - 1] : null;

  parser.onopentag = (node) => {
    const tag = localName(node.name);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) {
      attrs[k as string] = v as string;
    }

    switch (tag) {
      case 'grammar':
        if (attrs['ns']) {
          state.namespace = attrs['ns'];
        }
        break;

      case 'define': {
        const container = newNode('', false);
        state.defines.set(attrs['name'] || '', container);
        state.nodeStack = [container];
        break;
      }

      case 'start':
        state.inStart = true;
        break;

      case 'element': {
        // A named element, or a wildcard (<anyName>/<nsName>) element. Wildcard
        // nodes are still pushed so their inner attributes/refs don't leak to
        // the parent, but they contribute no completable name.
        const name = attrs['name'] || '';
        const node = newNode(name, !name);
        const parent = topNode();
        if (parent) {
          parent.childElements.push(node);
        }
        state.nodeStack.push(node);
        break;
      }

      case 'attribute':
        state.currentAttribute = {
          name: attrs['name'] || '',
          documentation: '',
          required: state.optionalDepth === 0,
          values: undefined,
          pattern: undefined,
        };
        state.currentValues = [];
        break;

      case 'ref': {
        const t = topNode();
        if (t) {
          t.childRefs.push(attrs['name'] || '');
        } else if (state.inStart) {
          state.startRef = attrs['name'] || '';
        }
        break;
      }

      case 'optional':
      case 'zeroOrMore':
        state.optionalDepth++;
        break;

      case 'oneOrMore':
        // children are still required (at least once), don't change optionalDepth
        break;

      case 'except': {
        // <anyName><except>…</except></anyName> excludes namespaces from the
        // wildcard (the "foreign elements" pattern); such a wildcard does not
        // admit elements of the schema's own namespace.
        const t = topNode();
        if (state.exceptDepth === 0 && t && t.isWildcard && !state.currentAttribute) {
          t.wildcardAny = false;
        }
        state.exceptDepth++;
        break;
      }

      case 'anyName':
      case 'nsName': {
        // Name class of a wildcard element. Inside <except> it only narrows
        // the wildcard; a name class on <attribute> is not an element.
        const t = topNode();
        if (t && t.isWildcard && state.exceptDepth === 0 && !state.currentAttribute) {
          t.wildcardAny = true;
        }
        break;
      }

      case 'text': {
        const t = topNode();
        if (t) t.allowsText = true;
        break;
      }

      case 'documentation':
        state.capturingText = 'documentation';
        state.textBuffer = '';
        break;

      case 'value':
        state.capturingText = 'value';
        state.textBuffer = '';
        break;

      case 'param':
        if (attrs['name'] === 'pattern') {
          state.capturingText = 'pattern';
          state.textBuffer = '';
        }
        break;

      // LSP annotations (xmlns:lsp="urn:xml-lsp:annotations").
      case 'defines':
      case 'references':
        if (state.currentAttribute && attrs['symbol']) {
          state.currentAttribute[tag] = {
            symbol: attrs['symbol'],
            form: attrs['form'] || undefined,
          };
        }
        break;

      case 'format': {
        const t = topNode();
        if (t) {
          const hints: FormatHints = {};
          if (attrs['preserve'] === 'true') hints.preserve = true;
          if (attrs['blank-lines'] === 'true') hints.blankLines = true;
          if (attrs['inline'] === 'true') hints.inline = true;
          t.format = { ...(t.format ?? {}), ...hints };
        }
        break;
      }

      case 'doc': {
        const t = topNode();
        if (t && attrs['href']) t.docUrl = attrs['href'];
        break;
      }

      case 'symbol': {
        const t = topNode();
        if (t && attrs['kind'] && attrs['label']) {
          t.symbol = {
            kind: attrs['kind'],
            label: attrs['label'],
            detail: attrs['detail'] || undefined,
          };
        }
        break;
      }

      case 'exclusive': {
        const t = topNode();
        if (t) {
          (t.exclusives ??= []).push({
            attributes: splitNames(attrs['attributes']),
            content: attrs['content'] === 'true',
          });
        }
        break;
      }

      case 'when': {
        const t = topNode();
        if (t && attrs['attribute']) {
          (t.whens ??= []).push({
            attribute: attrs['attribute'],
            value: attrs['value'],
            requires: splitNames(attrs['requires']),
            forbids: splitNames(attrs['forbids']),
          });
        }
        break;
      }

      // Grammar-level annotations (direct children of <grammar>).
      case 'namespace':
        if (!topNode() && attrs['prefix'] && attrs['uri']) {
          state.namespaces.push({ prefix: attrs['prefix'], uri: attrs['uri'] });
        }
        break;

      case 'builtin':
        if (!topNode() && attrs['symbol']) {
          state.builtins.set(attrs['symbol'], splitNames(attrs['names']));
        }
        break;
    }
  };

  parser.ontext = (text) => {
    if (state.capturingText) {
      state.textBuffer += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (state.capturingText) {
      state.textBuffer += cdata;
    }
  };

  parser.onclosetag = (name) => {
    const tag = localName(name);

    switch (tag) {
      case 'define':
        state.nodeStack = [];
        state.currentAttribute = null;
        break;

      case 'start':
        state.inStart = false;
        break;

      case 'element':
        if (state.nodeStack.length > 0) {
          state.nodeStack.pop();
        }
        break;

      case 'attribute': {
        const t = topNode();
        if (state.currentAttribute && state.currentAttribute.name && t) {
          if (state.currentValues.length > 0) {
            state.currentAttribute.values = [...state.currentValues];
          }
          t.attributes.push(state.currentAttribute as AttributeDeclaration);
        }
        state.currentAttribute = null;
        state.currentValues = [];
        break;
      }

      case 'optional':
      case 'zeroOrMore':
        state.optionalDepth--;
        break;

      case 'except':
        state.exceptDepth--;
        break;

      case 'documentation': {
        const docText = state.textBuffer.trim();
        state.capturingText = null;
        state.textBuffer = '';

        // In the speedata schema, <a:documentation> FOLLOWS the <value> it describes:
        //   <value>L</value>
        //   <a:documentation>Description of L</a:documentation>
        // So if we already have values collected, assign to the last one.
        if (state.currentAttribute && state.currentValues.length > 0) {
          const lastVal = state.currentValues[state.currentValues.length - 1];
          if (!lastVal.documentation) {
            lastVal.documentation = docText;
          }
        } else if (state.currentAttribute) {
          if (!state.currentAttribute.documentation) {
            state.currentAttribute.documentation = docText;
          }
        } else {
          const t = topNode();
          if (t && !t.documentation) {
            t.documentation = docText;
          }
        }
        break;
      }

      case 'value': {
        const val = state.textBuffer.trim();
        state.capturingText = null;
        state.textBuffer = '';
        state.currentValues.push({ value: val });
        break;
      }

      case 'param':
        if (state.capturingText === 'pattern') {
          const pattern = state.textBuffer.trim();
          if (state.currentAttribute) {
            state.currentAttribute.pattern = pattern;
          }
          state.capturingText = null;
          state.textBuffer = '';
        }
        break;
    }
  };

  parser.onerror = () => {
    // Continue parsing on error
    parser.resume();
  };

  parser.write(content).close();

  return buildContentModel(state);
}

function buildContentModel(state: ParseState): ContentModel {
  const defines = state.defines;

  // The element names that reside inside the `html` content pattern (and its
  // transitive table sub-patterns). These become the htmlElements map.
  const htmlNodes = collectInlineElements('html', defines);
  const htmlNames = new Set(htmlNodes.keys());

  const elements = new Map<string, ElementDeclaration>();
  // Speedata elements: any named element declared at a define container's top
  // level that is not part of the html pattern (e_A → A, e_HTML → HTML, …).
  for (const container of defines.values()) {
    for (const el of container.childElements) {
      if (!el.elementName || htmlNames.has(el.elementName)) continue;
      elements.set(el.elementName, declarationFor(el, defines));
    }
  }

  const htmlElements = new Map<string, ElementDeclaration>();
  for (const [name, node] of htmlNodes) {
    htmlElements.set(name, declarationFor(node, defines));
  }

  return {
    elements,
    htmlElements,
    namespace: state.namespace,
    symbolDefinitions: indexSymbolDefinitions(elements),
    namespaces: state.namespaces,
    builtins: state.builtins,
  };
}

/** Split a space-separated attribute value into names. */
function splitNames(value: string | undefined): string[] {
  return (value ?? '').split(/\s+/).filter(n => n.length > 0);
}

// symbol → every (element, attribute) whose values define a name of that symbol.
function indexSymbolDefinitions(
  elements: Map<string, ElementDeclaration>,
): Map<string, SymbolDefinition[]> {
  const index = new Map<string, SymbolDefinition[]>();
  for (const el of elements.values()) {
    for (const attr of el.attributes) {
      if (!attr.defines) continue;
      const list = index.get(attr.defines.symbol) ?? [];
      list.push({ element: el.name, attribute: attr.name, form: attr.defines.form });
      index.set(attr.defines.symbol, list);
    }
  }
  return index;
}

// Collect, by name, every named <element> reachable from a define's content
// pattern: its own nested elements plus those pulled in via <ref>.
function collectInlineElements(
  defineName: string,
  defines: Map<string, RngNode>,
): Map<string, RngNode> {
  const result = new Map<string, RngNode>();
  const visited = new Set<string>();

  const walkNode = (node: RngNode) => {
    for (const el of node.childElements) {
      if (el.elementName && !result.has(el.elementName)) {
        result.set(el.elementName, el);
      }
      walkNode(el);
    }
    for (const ref of node.childRefs) {
      walkDefine(ref);
    }
  };
  const walkDefine = (name: string) => {
    if (visited.has(name)) return;
    visited.add(name);
    const node = defines.get(name);
    if (node) walkNode(node);
  };

  walkDefine(defineName);
  return result;
}

function declarationFor(el: RngNode, defines: Map<string, RngNode>): ElementDeclaration {
  return {
    name: el.elementName,
    documentation: el.documentation,
    attributes: resolveAttributes(el, defines, new Set()),
    allowedChildren: [...directChildElements(el, defines, new Set())],
    allowsText: resolveAllowsText(el, defines, new Set()),
    allowsAnyChildren: resolveAllowsAnyChildren(el, defines, new Set()),
    format: el.format,
    docUrl: el.docUrl,
    symbol: el.symbol,
    exclusives: el.exclusives,
    whens: el.whens,
  };
}

// Names of elements that may appear as direct children of `node`: its own
// nested <element>s plus elements contributed by referenced defines.
function directChildElements(
  node: RngNode,
  defines: Map<string, RngNode>,
  visited: Set<string>,
): Set<string> {
  const out = new Set<string>();
  for (const el of node.childElements) {
    if (el.elementName) out.add(el.elementName);
  }
  for (const ref of node.childRefs) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const d = defines.get(ref);
    if (d) {
      for (const n of directChildElements(d, defines, visited)) out.add(n);
    }
  }
  return out;
}

// Attributes of an element: its own plus those from referenced pure
// attribute-group defines (containers with attributes and no elements, e.g.
// htmlclassidstyle). Element-producing refs are not followed.
function resolveAttributes(
  node: RngNode,
  defines: Map<string, RngNode>,
  visited: Set<string>,
): AttributeDeclaration[] {
  const byName = new Map<string, AttributeDeclaration>();
  for (const attr of node.attributes) {
    if (attr.name && !byName.has(attr.name)) byName.set(attr.name, attr);
  }
  for (const ref of node.childRefs) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const d = defines.get(ref);
    if (d && d.childElements.length === 0 && d.attributes.length > 0) {
      for (const attr of resolveAttributes(d, defines, visited)) {
        if (attr.name && !byName.has(attr.name)) byName.set(attr.name, attr);
      }
    }
  }
  return [...byName.values()];
}

// Whether a wildcard element admitting arbitrary names may appear as a direct
// child of `node` (own nested wildcards plus those from referenced defines).
function resolveAllowsAnyChildren(
  node: RngNode,
  defines: Map<string, RngNode>,
  visited: Set<string>,
): boolean {
  if (node.childElements.some(el => el.isWildcard && el.wildcardAny)) return true;
  for (const ref of node.childRefs) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const d = defines.get(ref);
    if (d && resolveAllowsAnyChildren(d, defines, visited)) return true;
  }
  return false;
}

function resolveAllowsText(
  node: RngNode,
  defines: Map<string, RngNode>,
  visited: Set<string>,
): boolean {
  if (node.allowsText) return true;
  for (const ref of node.childRefs) {
    if (visited.has(ref)) continue;
    visited.add(ref);
    const d = defines.get(ref);
    if (d && resolveAllowsText(d, defines, visited)) return true;
  }
  return false;
}

function localName(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.substring(idx + 1) : name;
}
