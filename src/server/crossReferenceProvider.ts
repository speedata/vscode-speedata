import { CompletionItem, CompletionItemKind } from 'vscode-languageserver/node';

interface CrossReferenceMapping {
  sourceElement: string;
  sourceAttribute: string;
  targetElement: string;
  targetAttribute: string;
  extraValues?: string[];
}

const mappings: CrossReferenceMapping[] = [
  // DefineTextformat name → Paragraph/Textblock textformat
  { sourceElement: 'DefineTextformat', sourceAttribute: 'name', targetElement: 'Paragraph', targetAttribute: 'textformat', extraValues: ['text', 'centered', 'left', 'right'] },
  { sourceElement: 'DefineTextformat', sourceAttribute: 'name', targetElement: 'Textblock', targetAttribute: 'textformat', extraValues: ['text', 'centered', 'left', 'right'] },
  // DefineColor name → any element with color
  { sourceElement: 'DefineColor', sourceAttribute: 'name', targetElement: '*', targetAttribute: 'color' },
  { sourceElement: 'DefineColor', sourceAttribute: 'name', targetElement: '*', targetAttribute: 'background-color' },
  // DefineFontfamily name → any element with fontfamily
  { sourceElement: 'DefineFontfamily', sourceAttribute: 'name', targetElement: '*', targetAttribute: 'fontfamily', extraValues: ['text'] },
  // LoadFontfile name → font style elements fontface
  { sourceElement: 'LoadFontfile', sourceAttribute: 'name', targetElement: 'Bold', targetAttribute: 'fontface' },
  { sourceElement: 'LoadFontfile', sourceAttribute: 'name', targetElement: 'Regular', targetAttribute: 'fontface' },
  { sourceElement: 'LoadFontfile', sourceAttribute: 'name', targetElement: 'Italic', targetAttribute: 'fontface' },
  { sourceElement: 'LoadFontfile', sourceAttribute: 'name', targetElement: 'BoldItalic', targetAttribute: 'fontface' },
];

export function hasCrossReferenceTargets(currentElement: string, attributeName: string): boolean {
  return mappings.some(m =>
    (m.targetElement === '*' || m.targetElement === currentElement) &&
    m.targetAttribute === attributeName
  );
}

export function getCrossReferenceCompletions(currentElement: string, attributeName: string, documentText: string): CompletionItem[] {
  const matching = mappings.filter(m =>
    (m.targetElement === '*' || m.targetElement === currentElement) &&
    m.targetAttribute === attributeName
  );

  if (matching.length === 0) return [];

  const items: CompletionItem[] = [];
  const seen = new Set<string>();

  for (const m of matching) {
    const names = collectDefinedNames(documentText, m.sourceElement, m.sourceAttribute);
    for (const name of names) {
      if (seen.has(name)) continue;
      seen.add(name);
      items.push({
        label: name,
        kind: CompletionItemKind.Reference,
        detail: `(from ${m.sourceElement})`,
        sortText: `1${name}`,
      });
    }
    if (m.extraValues) {
      for (const extra of m.extraValues) {
        if (seen.has(extra)) continue;
        seen.add(extra);
        items.push({
          label: extra,
          kind: CompletionItemKind.Reference,
          sortText: `1${extra}`,
        });
      }
    }
  }

  return items;
}

function collectDefinedNames(text: string, sourceElement: string, sourceAttribute: string): string[] {
  const regex = new RegExp(
    `<${sourceElement}\\b(?:[^>"']|"[^"]*"|'[^']*')*\\b${sourceAttribute}\\s*=\\s*"([^"]*)"`,
    'g'
  );
  const names: string[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const value = match[1];
    // Skip dynamic names containing {
    if (value.includes('{')) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    names.push(value);
  }

  return names;
}
