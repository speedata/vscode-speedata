import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel, ElementDeclaration } from './contentModel';
import { CustomDiagnostic, validateCustomConstraints } from './customConstraints';

interface TagInfo {
  name: string;
  line: number;
  character: number;
  attributes: Map<string, { value: string; line: number; character: number }>;
  selfClosing: boolean;
  offset: number; // start of the tag in the text
  end: number;    // just past the closing >
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
  }
  const stack: StackEntry[] = [];
  const lookup = (name: string) => model.elements.get(name) ?? model.htmlElements.get(name);
  // Inside an element whose schema content model contains a wildcard
  // (allowsAnyChildren), children are not validated. Nesting of the same
  // element is tracked so the matching closing tag is found.
  const isPreserved = preservedElementCheck(model);
  let preserveName = '';
  let preserveDepth = 0;
  let foreignDepth = 0;

  const runCustomConstraints = (entry: StackEntry, closeTag: TagInfo) => {
    const attrMap = new Map<string, string>();
    for (const [k, v] of entry.tag.attributes) {
      attrMap.set(k, v.value);
    }
    const hasContent = hasElementContent(text, entry.tag.end, closeTag.offset);
    pushCustomDiagnostics(validateCustomConstraints(model, entry.name, attrMap, hasContent), entry.tag, diagnostics);
  };

  for (const tag of tags) {
    if (tag.name.startsWith('/')) {
      // Closing tag
      const closeName = tag.name.substring(1);

      if (foreignDepth > 0) {
        if (closeName.includes(':')) foreignDepth--;
        continue;
      }

      if (preserveDepth > 0) {
        if (closeName === preserveName) {
          preserveDepth--;
        }
        if (preserveDepth > 0) continue;
        // preserveDepth just hit 0 — pop the preserved entry from the stack
        if (stack.length > 0 && stack[stack.length - 1].name === closeName) {
          runCustomConstraints(stack.pop()!, tag);
        }
        continue;
      }

      if (stack.length > 0 && stack[stack.length - 1].name === closeName) {
        runCustomConstraints(stack.pop()!, tag);
      }
      continue;
    }

    // Skip validation inside foreign-namespaced elements
    if (foreignDepth > 0) {
      if (!tag.selfClosing && tag.name.includes(':')) foreignDepth++;
      continue;
    }

    // Skip validation inside preserved elements
    if (preserveDepth > 0) {
      if (!tag.selfClosing && tag.name === preserveName) {
        preserveDepth++;
      }
      continue;
    }

    // Foreign-namespaced element: skip it and its children
    if (tag.name.includes(':')) {
      if (!tag.selfClosing) foreignDepth = 1;
      continue;
    }

    const decl = lookup(tag.name);

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
        // Skip validation for values containing {...} (XPath expressions)
        if (attrDecl.values && attrDecl.values.length > 0 && attrInfo.value && !attrInfo.value.includes('{')) {
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
      pushCustomDiagnostics(validateCustomConstraints(model, tag.name, attrMap, false), tag, diagnostics);
    } else {
      stack.push({ name: tag.name, decl, tag });
      if (isPreserved(tag.name, decl)) {
        preserveName = tag.name;
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

// Elements whose content is not validated when the schema declares no
// wildcard at all. The Publisher schema's html pattern is incomplete (no
// <body>, <div>, …) and has no wildcard, so skipping its content is the only
// way to avoid false warnings. Remove once that schema carries a wildcard.
const LEGACY_PRESERVED = new Set(['Value', 'HTML']);

function preservedElementCheck(model: ContentModel): (name: string, decl: ElementDeclaration | undefined) => boolean {
  const hasWildcards = [...model.elements.values()].some(e => e.allowsAnyChildren);
  return hasWildcards
    ? (_name, decl) => decl?.allowsAnyChildren === true
    : (name) => LEGACY_PRESERVED.has(name);
}

function pushCustomDiagnostics(custom: CustomDiagnostic[], tag: TagInfo, diagnostics: Diagnostic[]): void {
  for (const cd of custom) {
    diagnostics.push({
      severity: cd.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
      range: createRange(tag.line, tag.character, tag.name.length),
      message: cd.message,
      source: 'speedata',
    });
  }
}

/** Whether the text between an opening and its closing tag holds anything but whitespace and comments. */
function hasElementContent(text: string, from: number, to: number): boolean {
  if (to <= from) return false;
  const between = text.substring(from, to).replace(/<!--[\s\S]*?-->/g, '');
  return /\S/.test(between);
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

  // Pre-compute comment and CDATA ranges to skip
  const skipRanges: { start: number; end: number }[] = [];
  const skipRegex = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
  let skipMatch: RegExpExecArray | null;
  while ((skipMatch = skipRegex.exec(text)) !== null) {
    skipRanges.push({ start: skipMatch.index, end: skipMatch.index + skipMatch[0].length });
  }

  // Match opening tags, closing tags, and self-closing tags
  // The middle group skips over quoted strings so that '>' inside attribute values is not treated as tag end
  const tagRegex = /<(\/?[a-zA-Z_][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    // Skip processing instructions and comments
    if (text[match.index + 1] === '?' || text[match.index + 1] === '!') continue;

    // Skip tags inside comments or CDATA sections
    if (skipRanges.some(r => match!.index >= r.start && match!.index < r.end)) continue;

    const name = match[1];
    const attrsStr = match[2];
    const selfClosing = match[0].endsWith('/>');
    const pos = doc.positionAt(match.index + 1); // +1 to skip <

    const attributes = new Map<string, { value: string; line: number; character: number }>();

    if (!name.startsWith('/')) {
      // Parse attributes. The value alternation must distinguish quote kinds:
      // a "…"-value may contain ', and a '…'-value may contain " — otherwise
      // XPath snippets like  test="… $firma = 'GN' …"  get re-scanned as attrs.
      const attrRegex = /(\w[\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
      let attrMatch: RegExpExecArray | null;
      while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
        const attrOffset = match.index + 1 + name.length + attrMatch.index;
        const attrPos = doc.positionAt(attrOffset);
        attributes.set(attrMatch[1], {
          value: attrMatch[2] ?? attrMatch[3],
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
      offset: match.index,
      end: match.index + match[0].length,
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
