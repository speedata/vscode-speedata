import { TextEdit, FormattingOptions, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const PRESERVED_ELEMENTS = new Set(['Value']);

export function formatDocument(doc: TextDocument, options: FormattingOptions): TextEdit[] {
  const text = doc.getText();
  const formatted = formatXml(text, options);
  if (formatted === text) return [];

  const range: Range = {
    start: doc.positionAt(0),
    end: doc.positionAt(text.length),
  };
  return [TextEdit.replace(range, formatted)];
}

function formatXml(text: string, options: FormattingOptions): string {
  const indent = options.insertSpaces ? ' '.repeat(options.tabSize) : '\t';
  const out: string[] = [];
  let depth = 0;
  let i = 0;
  let preserveDepth = 0; // >0 means we are inside a preserved element

  while (i < text.length) {
    // Skip whitespace between tokens (when not preserving)
    if (preserveDepth === 0) {
      if (isWhitespace(text[i])) {
        i++;
        continue;
      }
    }

    // Processing instruction: <?...?>
    if (text.startsWith('<?', i)) {
      const end = text.indexOf('?>', i);
      if (end === -1) {
        out.push(text.substring(i));
        break;
      }
      const pi = text.substring(i, end + 2);
      if (preserveDepth > 0) {
        out.push(pi);
      } else {
        out.push(pi);
        out.push('\n');
      }
      i = end + 2;
      continue;
    }

    // Comment: <!--...-->
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i);
      if (end === -1) {
        if (preserveDepth > 0) {
          out.push(text.substring(i));
        } else {
          out.push(indentStr(indent, depth) + text.substring(i));
        }
        break;
      }
      const comment = text.substring(i, end + 3);
      if (preserveDepth > 0) {
        out.push(comment);
      } else {
        out.push(indentStr(indent, depth) + comment + '\n');
      }
      i = end + 3;
      continue;
    }

    // CDATA: <![CDATA[...]]>
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i);
      if (end === -1) {
        if (preserveDepth > 0) {
          out.push(text.substring(i));
        } else {
          out.push(indentStr(indent, depth) + text.substring(i));
        }
        break;
      }
      const cdata = text.substring(i, end + 3);
      if (preserveDepth > 0) {
        out.push(cdata);
      } else {
        out.push(indentStr(indent, depth) + cdata + '\n');
      }
      i = end + 3;
      continue;
    }

    // Closing tag: </...>
    if (text.startsWith('</', i)) {
      const end = text.indexOf('>', i);
      if (end === -1) {
        out.push(text.substring(i));
        break;
      }
      const tag = text.substring(i, end + 1);
      const tagName = extractTagName(tag.substring(2));

      if (preserveDepth > 0) {
        if (PRESERVED_ELEMENTS.has(tagName)) {
          preserveDepth--;
          if (preserveDepth === 0) {
            // End of preserved block: closing tag gets indented
            // Remove trailing whitespace/newline that might come from preserved content
            depth--;
            out.push(indentStr(indent, depth) + tag + '\n');
            i = end + 1;
            continue;
          }
        }
        // Still inside a preserved element
        out.push(tag);
        i = end + 1;
        continue;
      }

      depth = Math.max(0, depth - 1);
      out.push(indentStr(indent, depth) + tag + '\n');
      i = end + 1;
      continue;
    }

    // Opening or self-closing tag: <...> or <.../>
    if (text[i] === '<' && i + 1 < text.length && isNameStartChar(text[i + 1])) {
      const end = findTagEnd(text, i);
      if (end === -1) {
        out.push(text.substring(i));
        break;
      }
      const tag = text.substring(i, end + 1);
      const tagName = extractTagName(tag.substring(1));
      const selfClosing = tag.endsWith('/>');

      if (preserveDepth > 0) {
        out.push(tag);
        if (!selfClosing) {
          if (PRESERVED_ELEMENTS.has(tagName)) {
            preserveDepth++;
          }
        }
        i = end + 1;
        continue;
      }

      if (selfClosing) {
        out.push(indentStr(indent, depth) + normalizeSelfClosingTag(tag) + '\n');
      } else if (PRESERVED_ELEMENTS.has(tagName)) {
        // Capture everything inside the preserved element verbatim
        i = end + 1;
        const closeTag = '</' + tagName + '>';
        const preserved = capturePreservedContent(text, i, closeTag);
        if (preserved !== null) {
          out.push(indentStr(indent, depth) + tag + preserved.content + closeTag + '\n');
          i = preserved.endIndex;
        } else {
          out.push(indentStr(indent, depth) + tag + '\n');
          depth++;
        }
        continue;
      } else {
        out.push(indentStr(indent, depth) + tag + '\n');
        depth++;
      }
      i = end + 1;
      continue;
    }

    // Text content
    if (preserveDepth > 0) {
      out.push(text[i]);
      i++;
      continue;
    }

    // Collect text content
    const textStart = i;
    while (i < text.length && text[i] !== '<') {
      i++;
    }
    const textContent = text.substring(textStart, i);
    const trimmed = textContent.trim();
    if (trimmed.length > 0) {
      out.push(indentStr(indent, depth) + trimmed + '\n');
    }
  }

  // Remove trailing newlines, add exactly one
  let result = out.join('');
  result = result.replace(/\n+$/, '\n');
  return result;
}

function capturePreservedContent(text: string, startIndex: number, closeTag: string): { content: string; endIndex: number } | null {
  // Find the close tag, respecting nesting of same-named elements
  const tagName = closeTag.substring(2, closeTag.length - 1);
  const openPattern = '<' + tagName;
  let depth = 1;
  let i = startIndex;

  while (i < text.length) {
    if (text.startsWith(closeTag, i)) {
      depth--;
      if (depth === 0) {
        return {
          content: text.substring(startIndex, i),
          endIndex: i + closeTag.length,
        };
      }
      i += closeTag.length;
      continue;
    }
    if (text.startsWith(openPattern, i)) {
      // Check it's actually a tag (not a prefix of another tag name)
      const afterName = i + openPattern.length;
      if (afterName < text.length && (text[afterName] === ' ' || text[afterName] === '>' || text[afterName] === '/' || text[afterName] === '\t' || text[afterName] === '\n' || text[afterName] === '\r')) {
        // Check if self-closing
        const tagEnd = findTagEnd(text, i);
        if (tagEnd !== -1) {
          const tag = text.substring(i, tagEnd + 1);
          if (!tag.endsWith('/>')) {
            depth++;
          }
          i = tagEnd + 1;
          continue;
        }
      }
    }
    i++;
  }
  return null;
}

function findTagEnd(text: string, start: number): number {
  let inQuote: string | null = null;
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function extractTagName(s: string): string {
  let end = 0;
  while (end < s.length && !isWhitespace(s[end]) && s[end] !== '>' && s[end] !== '/') {
    end++;
  }
  return s.substring(0, end);
}

function indentStr(indent: string, depth: number): string {
  if (depth <= 0) return '';
  return indent.repeat(depth);
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function normalizeSelfClosingTag(tag: string): string {
  // Ensure exactly one space before />
  return tag.replace(/\s*\/>$/, ' />');
}

function isNameStartChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
