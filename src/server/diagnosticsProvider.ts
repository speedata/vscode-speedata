import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel, ElementDeclaration } from './contentModel';
import { validateCustomConstraints } from './customConstraints';

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
  interface StackEntry {
    name: string;
    decl: ElementDeclaration | undefined;
    tag: TagInfo;
    hasChildren: boolean;
  }
  const stack: StackEntry[] = [];
  const PRESERVED_ELEMENTS = new Set(['Value']);
  let preserveDepth = 0;

  for (const tag of tags) {
    if (tag.name.startsWith('/')) {
      // Closing tag
      const closeName = tag.name.substring(1);

      if (preserveDepth > 0) {
        if (PRESERVED_ELEMENTS.has(closeName)) {
          preserveDepth--;
        }
        if (preserveDepth > 0) continue;
        // preserveDepth just hit 0 — pop the Value entry from the stack
        if (stack.length > 0 && stack[stack.length - 1].name === closeName) {
          stack.pop();
        }
        continue;
      }

      if (stack.length > 0 && stack[stack.length - 1].name === closeName) {
        const entry = stack.pop()!;
        // Run custom constraints on the closing element
        const attrMap = new Map<string, string>();
        for (const [k, v] of entry.tag.attributes) {
          attrMap.set(k, v.value);
        }
        const customDiags = validateCustomConstraints(entry.name, attrMap, entry.hasChildren);
        for (const cd of customDiags) {
          diagnostics.push({
            severity: cd.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
            range: createRange(entry.tag.line, entry.tag.character, entry.name.length),
            message: cd.message,
            source: 'speedata',
          });
        }
      }
      continue;
    }

    // Skip validation inside preserved elements
    if (preserveDepth > 0) {
      if (!tag.selfClosing && PRESERVED_ELEMENTS.has(tag.name)) {
        preserveDepth++;
      }
      continue;
    }

    const decl = model.elements.get(tag.name);

    // Mark parent as having children
    if (stack.length > 0) {
      stack[stack.length - 1].hasChildren = true;
    }

    // Check if element is known
    if (!decl) {
      diagnostics.push({
        severity: DiagnosticSeverity.Warning,
        range: createRange(tag.line, tag.character, tag.name.length),
        message: `Unknown element: <${tag.name}>`,
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
            message: `<${tag.name}> is not an allowed child element of <${parent.name}>`,
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
            message: `Unknown attribute "${attrName}" for <${tag.name}>`,
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
                    message: `Invalid value "${attrInfo.value}" for attribute "${attrName}"`,
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
                message: `Invalid value "${attrInfo.value}" for attribute "${attrName}". Allowed: ${allowedVals.join(', ')}`,
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
            message: `Required attribute "${attrDecl.name}" is missing for <${tag.name}>`,
            source: 'speedata',
          });
        }
      }
    }

    // Self-closing tags: run custom constraints immediately
    if (tag.selfClosing) {
      const attrMap = new Map<string, string>();
      for (const [k, v] of tag.attributes) {
        attrMap.set(k, v.value);
      }
      const customDiags = validateCustomConstraints(tag.name, attrMap, false);
      for (const cd of customDiags) {
        diagnostics.push({
          severity: cd.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
          range: createRange(tag.line, tag.character, tag.name.length),
          message: cd.message,
          source: 'speedata',
        });
      }
    } else {
      stack.push({ name: tag.name, decl, tag, hasChildren: false });
      if (PRESERVED_ELEMENTS.has(tag.name)) {
        preserveDepth = 1;
      }
    }
  }

  // Remaining stack entries = unclosed tags
  for (const entry of stack) {
    diagnostics.push({
      severity: DiagnosticSeverity.Error,
      range: createRange(entry.tag.line, entry.tag.character, entry.name.length),
      message: `Unclosed element: <${entry.name}>`,
      source: 'speedata',
    });
  }

  // XML well-formedness checks
  checkWellFormedness(text, doc, diagnostics);

  return diagnostics;
}

function checkWellFormedness(text: string, doc: TextDocument, diagnostics: Diagnostic[]): void {
  let inTag = false;
  let inComment = false;
  let inPI = false;
  let inCDATA = false;
  let inQuote: string | null = null;
  let i = 0;

  while (i < text.length) {
    // Track whether we're inside markup (tags, comments, PIs, CDATA)
    if (inComment) {
      if (text.startsWith('-->', i)) {
        inComment = false;
        i += 3;
      } else {
        i++;
      }
      continue;
    }
    if (inPI) {
      if (text.startsWith('?>', i)) {
        inPI = false;
        i += 2;
      } else {
        i++;
      }
      continue;
    }
    if (inCDATA) {
      if (text.startsWith(']]>', i)) {
        inCDATA = false;
        i += 3;
      } else {
        i++;
      }
      continue;
    }
    if (inTag) {
      if (inQuote) {
        if (text[i] === inQuote) inQuote = null;
      } else if (text[i] === '"' || text[i] === "'") {
        inQuote = text[i];
      } else if (text[i] === '>') {
        inTag = false;
      }
      i++;
      continue;
    }

    // We're in text content
    if (text.startsWith('<!--', i)) {
      inComment = true;
      i += 4;
      continue;
    }
    if (text.startsWith('<?', i)) {
      inPI = true;
      i += 2;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      inCDATA = true;
      i += 9;
      continue;
    }
    if (text[i] === '<') {
      if (i + 1 < text.length && (text[i + 1] === '/' || /[a-zA-Z_]/.test(text[i + 1]))) {
        inTag = true;
        i++;
        continue;
      }
      // Bare '<'
      const pos = doc.positionAt(i);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: createRange(pos.line, pos.character, 1),
        message: `Invalid '<' in text content (use &lt; instead)`,
        source: 'speedata',
      });
      i++;
      continue;
    }
    if (text[i] === '&') {
      // Valid: &name; or &#digits; or &#xhex;
      const rest = text.substring(i);
      if (/^&#x[0-9a-fA-F]+;/.test(rest) || /^&#[0-9]+;/.test(rest) || /^&[a-zA-Z_][\w.-]*;/.test(rest)) {
        i++;
        continue;
      }
      const pos = doc.positionAt(i);
      diagnostics.push({
        severity: DiagnosticSeverity.Error,
        range: createRange(pos.line, pos.character, 1),
        message: `Invalid '&' in text content (use &amp; instead)`,
        source: 'speedata',
      });
      i++;
      continue;
    }
    i++;
  }
}

function parseTags(text: string, doc: TextDocument): TagInfo[] {
  const tags: TagInfo[] = [];
  // Match opening tags, closing tags, and self-closing tags
  // The middle group skips over quoted strings so that '>' inside attribute values is not treated as tag end
  const tagRegex = /<(\/?[a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    // Skip processing instructions and comments
    if (text[match.index + 1] === '?' || text[match.index + 1] === '!') continue;

    const name = match[1];
    const attrsStr = match[2];
    const selfClosing = match[0].endsWith('/>');
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
