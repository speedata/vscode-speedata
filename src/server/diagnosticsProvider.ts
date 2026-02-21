import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel, ElementDeclaration } from './contentModel';

interface TagInfo {
  name: string;
  line: number;
  character: number;
  attributes: Map<string, { value: string; line: number; character: number }>;
  selfClosing: boolean;
}

export function validateDocument(doc: TextDocument, model: ContentModel): Diagnostic[] {
  const text = doc.getText();
  const diagnostics: Diagnostic[] = [];

  // Parse all tags with their positions
  const tags = parseTags(text, doc);

  // Build a simple tree structure for validation
  const stack: { name: string; decl: ElementDeclaration | undefined }[] = [];

  for (const tag of tags) {
    if (tag.name.startsWith('/')) {
      // Closing tag
      const closeName = tag.name.substring(1);
      if (stack.length > 0 && stack[stack.length - 1].name === closeName) {
        stack.pop();
      }
      continue;
    }

    const decl = model.elements.get(tag.name);

    // Check if element is known
    if (!decl) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: createRange(tag.line, tag.character, tag.name.length),
        message: `Unbekanntes Element: <${tag.name}>`,
        source: 'speedata',
      });
    }

    // Check if element is allowed as child of parent
    if (stack.length > 0) {
      const parent = stack[stack.length - 1];
      if (parent.decl && decl) {
        if (!parent.decl.allowedChildren.includes(tag.name)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: createRange(tag.line, tag.character, tag.name.length),
            message: `<${tag.name}> ist kein erlaubtes Kind-Element von <${parent.name}>`,
            source: 'speedata',
          });
        }
      }
    }

    if (decl) {
      // Check attributes
      for (const [attrName, attrInfo] of tag.attributes) {
        // Skip XML namespace declarations
        if (attrName === 'xmlns' || attrName.startsWith('xmlns:')) continue;

        const attrDecl = decl.attributes.find(a => a.name === attrName);
        if (!attrDecl) {
          diagnostics.push({
            severity: DiagnosticSeverity.Warning,
            range: createRange(attrInfo.line, attrInfo.character, attrName.length),
            message: `Unbekanntes Attribut "${attrName}" für <${tag.name}>`,
            source: 'speedata',
          });
          continue;
        }

        // Check attribute values against allowed values
        if (attrDecl.values && attrDecl.values.length > 0 && attrInfo.value) {
          const allowedVals = attrDecl.values.map(v => v.value);
          if (!allowedVals.includes(attrInfo.value)) {
            // Check if there's a pattern to match against
            if (attrDecl.pattern) {
              try {
                const regex = new RegExp(`^(?:${attrDecl.pattern})$`);
                if (!regex.test(attrInfo.value)) {
                  diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: createRange(attrInfo.line, attrInfo.character, attrName.length),
                    message: `Ungültiger Wert "${attrInfo.value}" für Attribut "${attrName}"`,
                    source: 'speedata',
                  });
                }
              } catch {
                // Invalid regex, skip validation
              }
            } else {
              diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: createRange(attrInfo.line, attrInfo.character, attrName.length),
                message: `Ungültiger Wert "${attrInfo.value}" für Attribut "${attrName}". Erlaubt: ${allowedVals.join(', ')}`,
                source: 'speedata',
              });
            }
          }
        }
      }

      // Check required attributes
      for (const attrDecl of decl.attributes) {
        if (attrDecl.required && !tag.attributes.has(attrDecl.name)) {
          diagnostics.push({
            severity: DiagnosticSeverity.Error,
            range: createRange(tag.line, tag.character, tag.name.length),
            message: `Pflichtattribut "${attrDecl.name}" fehlt bei <${tag.name}>`,
            source: 'speedata',
          });
        }
      }
    }

    // Push to stack if not self-closing
    if (!tag.selfClosing) {
      stack.push({ name: tag.name, decl });
    }
  }

  return diagnostics;
}

function parseTags(text: string, doc: TextDocument): TagInfo[] {
  const tags: TagInfo[] = [];
  // Match opening tags, closing tags, and self-closing tags
  const tagRegex = /<(\/?[a-zA-Z_][\w:.-]*)([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    // Skip processing instructions and comments
    if (text[match.index + 1] === '?' || text[match.index + 1] === '!') continue;

    const name = match[1];
    const attrsStr = match[2];
    const selfClosing = match[3] === '/';
    const pos = doc.positionAt(match.index + 1); // +1 to skip <

    const attributes = new Map<string, { value: string; line: number; character: number }>();

    if (!name.startsWith('/')) {
      // Parse attributes
      const attrRegex = /(\w[\w:.-]*)\s*=\s*["']([^"']*)["']/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
        const attrOffset = match.index + 1 + name.length + attrMatch.index;
        const attrPos = doc.positionAt(attrOffset);
        attributes.set(attrMatch[1], {
          value: attrMatch[2],
          line: attrPos.line,
          character: attrPos.character,
        });
      }
    }

    tags.push({
      name,
      line: pos.line,
      character: pos.character,
      attributes,
      selfClosing,
    });
  }

  return tags;
}

function createRange(line: number, character: number, length: number): Range {
  return {
    start: { line, character },
    end: { line, character: character + length },
  };
}
