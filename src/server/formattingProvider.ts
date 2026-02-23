import { TextEdit, FormattingOptions, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

const PRESERVED_ELEMENTS = new Set(['Value']);
const SECTION_ELEMENTS = new Set(['Section']);

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
  let preserveDepth = 0;
  const elementStack: string[] = [];

  // Instead of emitting blank lines immediately, we track whether a blank
  // line is pending and what type the previous sibling was.
  let pendingBlank = false;
  let prevSiblingSelfClosing = false;

  // Buffer for comments that appear between elements at blank-line-eligible
  // depths.  They get flushed right before the next element so the blank
  // line can be placed *before* the comment block rather than between the
  // comment and the element.
  let commentBuffer: string[] = [];

  function flushBeforeElement(currentIsSelfClosing: boolean) {
    if (!isBlankLineDepth(depth, elementStack)) {
      // Not at a depth where we insert blank lines – just flush comments.
      for (const c of commentBuffer) out.push(c);
      commentBuffer = [];
      return;
    }

    const bothSelfClosing = prevSiblingSelfClosing && currentIsSelfClosing;

    if (pendingBlank && !bothSelfClosing) {
      // Emit the blank line *before* any buffered comments.
      out.push('\n');
    }

    for (const c of commentBuffer) out.push(c);
    commentBuffer = [];
  }

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
      } else if (isBlankLineDepth(depth, elementStack)) {
        // Check if this comment is standalone (blank line after it in source)
        // or attached to the next element (no blank line).
        if (hasBlankLineAfter(text, end + 3)) {
          // Standalone comment: emit immediately with blank line logic.
          flushBeforeElement(false);
          out.push(indentStr(indent, depth) + comment + '\n');
          pendingBlank = true;
          prevSiblingSelfClosing = false;
        } else {
          // Attached to next element: buffer it.
          commentBuffer.push(indentStr(indent, depth) + comment + '\n');
        }
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
            depth--;
            elementStack.pop();
            out.push(indentStr(indent, depth) + tag + '\n');
            pendingBlank = true;
            prevSiblingSelfClosing = false;
            i = end + 1;
            continue;
          }
        }
        out.push(tag);
        i = end + 1;
        continue;
      }

      depth = Math.max(0, depth - 1);
      elementStack.pop();
      // Flush any buffered comments before the closing tag
      for (const c of commentBuffer) out.push(c);
      commentBuffer = [];
      out.push(indentStr(indent, depth) + tag + '\n');
      pendingBlank = true;
      prevSiblingSelfClosing = false;
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
        flushBeforeElement(true);
        out.push(indentStr(indent, depth) + normalizeSelfClosingTag(tag) + '\n');
        pendingBlank = true;
        prevSiblingSelfClosing = true;
      } else if (PRESERVED_ELEMENTS.has(tagName)) {
        flushBeforeElement(false);
        i = end + 1;
        const closeTag = '</' + tagName + '>';
        const preserved = capturePreservedContent(text, i, closeTag);
        if (preserved !== null) {
          out.push(indentStr(indent, depth) + tag + preserved.content + closeTag + '\n');
          pendingBlank = true;
          prevSiblingSelfClosing = false;
          i = preserved.endIndex;
        } else {
          out.push(indentStr(indent, depth) + tag + '\n');
          elementStack.push(tagName);
          depth++;
          pendingBlank = false;
          prevSiblingSelfClosing = false;
        }
        continue;
      } else {
        flushBeforeElement(false);
        out.push(indentStr(indent, depth) + tag + '\n');
        elementStack.push(tagName);
        depth++;
        // Reset blank line state when entering a child scope
        pendingBlank = false;
        prevSiblingSelfClosing = false;
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

  // Flush any remaining buffered comments
  for (const c of commentBuffer) out.push(c);
  commentBuffer = [];

  // Remove trailing newlines, add exactly one
  let result = out.join('');
  // Remove blank lines before closing tags (trailing blank line inside an element)
  result = result.replace(/\n\n(\s*<\/)/g, '\n$1');
  result = result.replace(/\n+$/, '\n');
  return result;
}

function capturePreservedContent(text: string, startIndex: number, closeTag: string): { content: string; endIndex: number } | null {
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
      const afterName = i + openPattern.length;
      if (afterName < text.length && (text[afterName] === ' ' || text[afterName] === '>' || text[afterName] === '/' || text[afterName] === '\t' || text[afterName] === '\n' || text[afterName] === '\r')) {
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
  return tag.replace(/\s*\/>$/, ' />');
}

function isNameStartChar(ch: string): boolean {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

// Check if there is a blank line (two newlines) in the source text between
// position `pos` and the next non-whitespace character.
function hasBlankLineAfter(text: string, pos: number): boolean {
  let newlineCount = 0;
  for (let i = pos; i < text.length; i++) {
    if (text[i] === '\n') {
      newlineCount++;
      if (newlineCount >= 2) return true;
    } else if (!isWhitespace(text[i])) {
      break;
    }
  }
  return false;
}

// Blank lines are inserted between sibling elements at top level (depth 1)
// or inside a Section (depth 2).
function isBlankLineDepth(depth: number, elementStack: string[]): boolean {
  if (depth === 1) return true;
  if (depth === 2 && elementStack.length >= 1 && SECTION_ELEMENTS.has(elementStack[elementStack.length - 1])) return true;
  return false;
}
