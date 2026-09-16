import { DocumentSymbol, SymbolKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel, SymbolHint } from './contentModel';

/**
 * Document symbols (outline) for every element the schema marks with
 * <lsp:symbol>. Symbols nest according to the element structure: a symbol
 * element inside another symbol element becomes its child.
 */
export function getDocumentSymbols(doc: TextDocument, model?: ContentModel): DocumentSymbol[] {
  const hints = symbolHints(model);
  if (hints.size === 0) return [];

  const text = doc.getText();
  const topLevel: DocumentSymbol[] = [];

  interface Open {
    name: string;
    symbol?: DocumentSymbol;
  }
  const stack: Open[] = [];
  const parentSymbol = (): DocumentSymbol | undefined => {
    for (let i = stack.length - 1; i >= 0; i--) {
      if (stack[i].symbol) return stack[i].symbol;
    }
    return undefined;
  };

  const tagRegex = /<(\/?)([a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(text)) !== null) {
    if (m[2] === undefined) continue; // comment, CDATA or PI
    const isClose = m[1] === '/';
    const name = m[2];
    const selfClosing = m[0].endsWith('/>');
    const start = m.index;
    const end = m.index + m[0].length;

    if (isClose) {
      const idx = stack.map(o => o.name).lastIndexOf(name);
      if (idx < 0) continue;
      const closed = stack.splice(idx);
      // Extend the range of every symbol closed here to the closing tag.
      for (const o of closed) {
        if (o.symbol) o.symbol.range.end = doc.positionAt(end);
      }
      continue;
    }

    const hint = hints.get(name);
    let symbol: DocumentSymbol | undefined;
    if (hint) {
      const attrs = parseAttributes(m[3]);
      const label = substitute(hint.label, attrs);
      if (label) {
        const detail = hint.detail ? substitute(hint.detail, attrs) : '';
        const range = { start: doc.positionAt(start), end: doc.positionAt(end) };
        symbol = DocumentSymbol.create(label, detail || undefined, symbolKind(hint.kind), range, { ...range });
        symbol.children = [];
        const parent = parentSymbol();
        if (parent) parent.children!.push(symbol);
        else topLevel.push(symbol);
      }
    }

    if (!selfClosing) stack.push({ name, symbol });
  }

  return topLevel;
}

function symbolHints(model?: ContentModel): Map<string, SymbolHint> {
  const hints = new Map<string, SymbolHint>();
  for (const el of model?.elements.values() ?? []) {
    if (el.symbol) hints.set(el.name, el.symbol);
  }
  return hints;
}

/** Replace every `{@attr}` in the template by the attribute's value (empty if absent). */
function substitute(template: string, attrs: Map<string, string>): string {
  return template.replace(/\{@([\w:.-]+)\}/g, (_, attr: string) => attrs.get(attr) ?? '').trim();
}

/** `namespace` → SymbolKind.Namespace, `typeParameter` → SymbolKind.TypeParameter, … */
function symbolKind(name: string): SymbolKind {
  const key = name.charAt(0).toUpperCase() + name.slice(1);
  const kind = (SymbolKind as unknown as Record<string, SymbolKind | undefined>)[key];
  return typeof kind === 'number' ? kind : SymbolKind.Object;
}

function parseAttributes(attrsStr: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRegex = /(\w[\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(attrsStr)) !== null) {
    attrs.set(match[1], match[2] ?? match[3]);
  }
  return attrs;
}
