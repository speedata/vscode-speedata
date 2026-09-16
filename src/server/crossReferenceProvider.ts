import { CompletionItem, CompletionItemKind, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { AttributeDeclaration, ContentModel, SymbolDefinition } from './contentModel';


interface Reference {
  symbol: string;
  form?: string;
}

/** The symbol an attribute value refers to, from the schema annotation. */
function referenceFor(model: ContentModel, element: string, attributeName: string): Reference | undefined {
  const decl = model.elements.get(element);
  const attr: AttributeDeclaration | undefined = decl?.attributes.find(a => a.name === attributeName);
  return attr?.references;
}

function definitionsFor(model: ContentModel, symbol: string): SymbolDefinition[] {
  return model.symbolDefinitions.get(symbol) ?? [];
}

export function hasCrossReferenceTargets(model: ContentModel, element: string, attributeName: string): boolean {
  return referenceFor(model, element, attributeName) !== undefined;
}

/**
 * Completion items for an attribute value that references a symbol: every
 * name defined in the document by a `defines` annotation of that symbol,
 * plus the Publisher's built-in names.
 *
 * `valuePrefix` is the attribute value text before the cursor and `cursor`
 * the cursor position; both are needed to replace a partially typed `$var`
 * in XPath expressions.
 */
export function getCrossReferenceCompletions(
  model: ContentModel,
  element: string,
  attributeName: string,
  doc: TextDocument,
  valuePrefix: string,
  cursor: number,
): CompletionItem[] {
  const ref = referenceFor(model, element, attributeName);
  if (!ref) return [];

  const text = doc.getText();
  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  const add = (name: string, detail?: string) => {
    if (seen.has(name)) return;
    seen.add(name);
    items.push(makeItem(name, ref.form, detail, doc, valuePrefix, cursor));
  };

  for (const def of definitionsFor(model, ref.symbol)) {
    for (const name of collectDefinedNames(text, def)) {
      add(name, `(from ${def.element})`);
    }
  }
  for (const builtin of model.builtins.get(ref.symbol) ?? []) {
    add(builtin, '(built-in)');
  }

  return items;
}

function makeItem(
  name: string,
  form: string | undefined,
  detail: string | undefined,
  doc: TextDocument,
  valuePrefix: string,
  cursor: number,
): CompletionItem {
  const item: CompletionItem = {
    label: name,
    kind: CompletionItemKind.Reference,
    detail,
    sortText: `1${name}`,
  };

  if (form === 'xpath-variable') {
    // Insert `$name`, replacing a partially typed `$na` if the cursor sits on
    // one. `$` is not a word character, so without an explicit range VS Code
    // would keep the typed `$` and insert a second one.
    const typed = valuePrefix.match(/\$[\w.-]*$/);
    const start = typed ? cursor - typed[0].length : cursor;
    const range: Range = { start: doc.positionAt(start), end: doc.positionAt(cursor) };
    item.label = `$${name}`;
    item.filterText = `$${name}`;
    item.textEdit = { range, newText: `$${name}` };
  }

  return item;
}

/** Names defined in the document by `<Element attribute="…">` occurrences. */
function collectDefinedNames(text: string, def: SymbolDefinition): string[] {
  const regex = new RegExp(
    `<${def.element}\\b(?:[^>"']|"[^"]*"|'[^']*')*?\\s${def.attribute}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    'g'
  );
  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const raw = match[1] ?? match[2];
    const name = extractName(raw, def.form);
    if (name === undefined || seen.has(name)) continue;
    seen.add(name);
    names.push(name);
  }

  return names;
}

/** The defined name inside an attribute value, or undefined when it is dynamic. */
function extractName(value: string, form: string | undefined): string | undefined {
  if (form === 'xpath-string') {
    // The value is an XPath expression; only a bare string literal yields a
    // static name. In a double-quoted attribute the literal uses single
    // quotes (or &quot;).
    const literal = value.trim().match(/^(?:'([^']*)'|&quot;([^&]*)&quot;)$/);
    return literal ? (literal[1] ?? literal[2]) : undefined;
  }
  // Skip dynamic names containing attribute value templates: name="{$x}"
  if (value.includes('{')) return undefined;
  return value;
}
