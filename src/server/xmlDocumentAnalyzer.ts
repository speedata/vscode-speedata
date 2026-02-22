import { Position } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

export type CursorContextType =
  | 'elementOpen'      // inside <|  or <foo|
  | 'attributeName'    // after element name, before = : <foo |
  | 'attributeValue'   // inside attribute value: <foo bar="|"
  | 'content'          // between tags: <foo>|</foo>
  | 'elementHover'     // cursor on element name (for hover)
  | 'attributeHover'   // cursor on attribute name (for hover)
  | 'unknown';

export interface CursorContext {
  type: CursorContextType;
  elementStack: string[];     // ancestor elements from root to current
  currentElement: string;     // innermost element name
  attributeName?: string;     // current attribute name (for value completion or hover)
  attributePrefix?: string;   // partial attribute name being typed
  elementPrefix?: string;     // partial element name being typed
  existingAttributes?: Map<string, string>; // attributes already present on current tag (name → value)
}

export function analyzeDocument(doc: TextDocument, position: Position): CursorContext {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  // Check if cursor is inside a comment or CDATA
  if (isInsideCommentOrCDATA(text, offset)) {
    return {
      type: 'unknown',
      elementStack: [],
      currentElement: '',
    };
  }

  // Build element stack by scanning from start to offset
  const elementStack = buildElementStack(text, offset);
  const currentElement = elementStack.length > 0 ? elementStack[elementStack.length - 1] : '';

  // Determine what's at the cursor
  const contextType = determineCursorContext(text, offset);

  return contextType;

  function determineCursorContext(text: string, offset: number): CursorContext {
    // Find the last < before offset that isn't closed by >
    let lastOpenBracket = -1;
    let inTag = false;

    for (let i = offset - 1; i >= 0; i--) {
      if (text[i] === '>') {
        // We're outside a tag
        break;
      }
      if (text[i] === '<') {
        lastOpenBracket = i;
        inTag = true;
        break;
      }
    }

    if (!inTag) {
      // We're in element content
      return {
        type: 'content',
        elementStack,
        currentElement,
      };
    }

    // We're inside a tag starting at lastOpenBracket
    // Read full tag content up to closing > (for correct element name parsing)
    let tagEnd = text.indexOf('>', lastOpenBracket);
    if (tagEnd === -1) tagEnd = text.length;
    const fullTagContent = text.substring(lastOpenBracket, tagEnd + 1);
    const tagContentToCursor = text.substring(lastOpenBracket, offset);

    // Check if this is a closing tag
    if (fullTagContent.startsWith('</')) {
      return { type: 'unknown', elementStack, currentElement };
    }

    // Check if this is a PI
    if (fullTagContent.startsWith('<?')) {
      return { type: 'unknown', elementStack, currentElement };
    }

    // Parse the full tag content to determine context
    // <ElementName attr1="val1" attr2="val2" ...
    const afterBracket = fullTagContent.substring(1); // remove <

    // Extract element name from full tag
    const elemNameMatch = afterBracket.match(/^([a-zA-Z_][\w:.-]*)/);
    if (!elemNameMatch) {
      // Typing element name: <|
      const partialAfter = tagContentToCursor.substring(1);
      return {
        type: 'elementOpen',
        elementStack,
        currentElement,
        elementPrefix: partialAfter.trim(),
      };
    }

    const tagElementName = elemNameMatch[1];
    const afterName = afterBracket.substring(elemNameMatch[0].length);

    // Check if cursor is still on the element name
    if (offset <= lastOpenBracket + 1 + elemNameMatch[0].length) {
      return {
        type: 'elementHover',
        elementStack,
        currentElement: tagElementName,
        elementPrefix: tagElementName.substring(0, offset - lastOpenBracket - 1),
      };
    }

    // Parse existing attributes
    const existingAttrs = extractAttributes(afterName);

    // Determine if we're in an attribute value or name
    const posInAfterName = offset - (lastOpenBracket + 1 + elemNameMatch[0].length);
    const textBeforeCursor = afterName.substring(0, posInAfterName);

    // Check if inside attribute value (after = and inside quotes)
    const attrValueMatch = textBeforeCursor.match(/(\w[\w:.-]*)=["']([^"']*)$/);
    if (attrValueMatch) {
      return {
        type: 'attributeValue',
        elementStack: [...elementStack.slice(0, -1), tagElementName],
        currentElement: tagElementName,
        attributeName: attrValueMatch[1],
        existingAttributes: existingAttrs,
      };
    }

    // Check if on an attribute name (for hover)
    const attrHoverMatch = textBeforeCursor.match(/\s(\w[\w:.-]*)$/);
    const charAfterCursor = offset < text.length ? text[offset] : '';
    const restAfterCursor = text.substring(offset);
    const attrContinues = restAfterCursor.match(/^[\w:.-]*/);
    if (attrHoverMatch) {
      const fullAttrName = attrHoverMatch[1] + (attrContinues ? attrContinues[0] : '');
      // Check if this attr has a = after it (it's a complete attribute name)
      const afterFullAttr = text.substring(offset + (attrContinues ? attrContinues[0].length : 0));
      if (afterFullAttr.match(/^\s*=/)) {
        return {
          type: 'attributeHover',
          elementStack: [...elementStack.slice(0, -1), tagElementName],
          currentElement: tagElementName,
          attributeName: fullAttrName,
          existingAttributes: existingAttrs,
        };
      }
    }

    // We're in attribute name position
    const partialAttr = textBeforeCursor.match(/\s(\w[\w:.-]*)$/);
    return {
      type: 'attributeName',
      elementStack: [...elementStack.slice(0, -1), tagElementName],
      currentElement: tagElementName,
      attributePrefix: partialAttr ? partialAttr[1] : '',
      existingAttributes: existingAttrs,
    };
  }
}

function buildElementStack(text: string, offset: number): string[] {
  const stack: string[] = [];
  // Simple regex-based approach scanning for open/close tags
  const tagRegex = /<\/?([a-zA-Z_][\w:.-]*)[^>]*?\/?>/g;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(text)) !== null) {
    if (match.index >= offset) break;

    const fullMatch = match[0];
    const tagName = match[1];

    if (fullMatch.startsWith('</')) {
      // Closing tag
      const idx = stack.lastIndexOf(tagName);
      if (idx >= 0) {
        stack.splice(idx);
      }
    } else if (fullMatch.endsWith('/>')) {
      // Self-closing
      // Don't add to stack
    } else {
      // Opening tag
      stack.push(tagName);
    }
  }

  return stack;
}

function isInsideCommentOrCDATA(text: string, offset: number): boolean {
  let i = 0;
  while (i < offset) {
    if (text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      if (end === -1 || end + 3 > offset) return true;
      i = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const end = text.indexOf(']]>', i + 9);
      if (end === -1 || end + 3 > offset) return true;
      i = end + 3;
      continue;
    }
    i++;
  }
  return false;
}

function extractAttributes(tagContent: string): Map<string, string> {
  const attrs = new Map<string, string>();
  const attrRegex = /(\w[\w:.-]*)\s*=\s*["']([^"']*)["']/g;
  let match: RegExpExecArray | null;
  while ((match = attrRegex.exec(tagContent)) !== null) {
    attrs.set(match[1], match[2]);
  }
  return attrs;
}
