import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions, TransportKind } from 'vscode-languageclient/node';

let client: LanguageClient;

export function activate(context: vscode.ExtensionContext): void {
  const serverModule = context.asAbsolutePath(path.join('dist', 'server', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: { module: serverModule, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'xml' }],
    synchronize: {},
    initializationOptions: {
      language: vscode.env.language,
    },
  };

  client = new LanguageClient('speedata', 'Speedata Publisher', serverOptions, clientOptions);
  client.start();

  context.subscriptions.push(
    vscode.languages.setLanguageConfiguration('xml', {
      onEnterRules: [
        {
          // Between > and </: indent cursor line, outdent closing tag line
          beforeText: />\s*$/,
          afterText: /^\s*<\//,
          action: { indentAction: vscode.IndentAction.IndentOutdent },
        },
      ],
    }),
    vscode.workspace.onDidChangeTextDocument(onDocumentChange),
    vscode.commands.registerCommand('speedata.selectElement', selectElement),
    vscode.commands.registerCommand('speedata.toggleComment', toggleComment),
    vscode.commands.registerCommand('speedata.goToParent', goToParent),
    vscode.commands.registerCommand('speedata.goToFirstChild', goToFirstChild),
    vscode.commands.registerCommand('speedata.goToNextSibling', goToNextSibling),
    vscode.commands.registerCommand('speedata.goToPrevSibling', goToPrevSibling)
  );
}

function selectElement(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const text = doc.getText();
  const offset = doc.offsetAt(editor.selection.active);

  // Find the innermost element that encloses the cursor.
  // If cursor is already on/inside an opening or closing tag, use that element.
  // If selection already spans an element, expand to the parent.
  const currentSelection = editor.selection;
  const selStart = doc.offsetAt(currentSelection.start);
  const selEnd = doc.offsetAt(currentSelection.end);

  // Collect all tag positions
  const tagRegex = /<(\/?([a-zA-Z_][\w:.-]*))[^>]*?\/?>/g;
  interface TagEntry { index: number; end: number; name: string; isClose: boolean; isSelfClose: boolean }
  const tags: TagEntry[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRegex.exec(text)) !== null) {
    // Skip PIs and comments
    if (text[m.index + 1] === '?' || text[m.index + 1] === '!') continue;
    tags.push({
      index: m.index,
      end: m.index + m[0].length,
      name: m[2],
      isClose: m[1].startsWith('/'),
      isSelfClose: m[0].endsWith('/>'),
    });
  }

  // Build a list of element ranges (open tag start → close tag end)
  // by matching open/close tags with a stack
  interface ElementRange { name: string; start: number; end: number; openEnd: number; closeStart: number }
  const elements: ElementRange[] = [];
  const stack: { name: string; index: number; tagEnd: number }[] = [];

  for (const tag of tags) {
    if (tag.isSelfClose) {
      elements.push({ name: tag.name, start: tag.index, end: tag.end, openEnd: tag.end, closeStart: tag.index });
      continue;
    }
    if (!tag.isClose) {
      stack.push({ name: tag.name, index: tag.index, tagEnd: tag.end });
    } else {
      // Find matching open tag on stack
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === tag.name) {
          const open = stack[i];
          elements.push({ name: tag.name, start: open.index, end: tag.end, openEnd: open.tagEnd, closeStart: tag.index });
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  // Sort by size (smallest first) so we find the innermost element
  elements.sort((a, b) => (a.end - a.start) - (b.end - b.start));

  // Find the smallest element that encloses the cursor.
  // If the current selection already matches that element, go one level up.
  for (const el of elements) {
    if (el.start <= offset && el.end >= offset) {
      // Check if current selection already covers this element
      if (selStart === el.start && selEnd === el.end) {
        continue; // Already selected → expand to parent
      }
      const startPos = doc.positionAt(el.start);
      const endPos = doc.positionAt(el.end);
      editor.selection = new vscode.Selection(startPos, endPos);
      editor.revealRange(new vscode.Range(startPos, endPos));
      return;
    }
  }
}

function toggleComment(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const selection = editor.selection;

  // Determine text range: use selection, or expand to full line if no selection
  let range: vscode.Range;
  if (selection.isEmpty) {
    const line = doc.lineAt(selection.active.line);
    range = line.range;
  } else {
    range = new vscode.Range(selection.start, selection.end);
  }

  const text = doc.getText(range);
  const trimmed = text.trim();

  // Check if the selection is already a comment → uncomment
  if (trimmed.startsWith('<!--') && trimmed.endsWith('-->')) {
    // Find the actual positions of the outer <!-- and -->
    const fullText = doc.getText();
    const startOffset = doc.offsetAt(range.start);

    const commentOpenIdx = text.indexOf('<!--');
    const commentCloseIdx = text.lastIndexOf('-->');

    if (commentOpenIdx === -1 || commentCloseIdx === -1) return;

    // Extract the inner content (between <!-- and -->)
    const inner = text.substring(commentOpenIdx + 4, commentCloseIdx);

    // Unescape nested comments: <!-/- → <!--  and -/-> → -->
    const unescaped = inner.replace(/<!-\/-/g, '<!--').replace(/-\/->/g, '-->');

    const replaceRange = new vscode.Range(
      doc.positionAt(startOffset + commentOpenIdx),
      doc.positionAt(startOffset + commentCloseIdx + 3)
    );

    editor.edit(editBuilder => {
      editBuilder.replace(replaceRange, unescaped);
    });
  } else {
    // Comment: escape inner <!-- and -->, then wrap
    const escaped = text.replace(/<!--/g, '<!-/-').replace(/-->/g, '-/->');
    editor.edit(editBuilder => {
      editBuilder.replace(range, `<!-- ${escaped} -->`);
    });
  }
}

interface TagInfo {
  index: number;
  end: number;
  name: string;
  isClose: boolean;
  isSelfClose: boolean;
}

interface ElementNode {
  name: string;
  start: number;     // offset of '<' of opening tag
  openEnd: number;   // offset after '>' of opening tag
  closeEnd: number;  // offset after '>' of closing tag (= start for self-closing)
  children: ElementNode[];
  parent: ElementNode | null;
}

function buildElementTree(text: string): ElementNode[] {
  const tagRegex = /<(\/?([a-zA-Z_][\w:.-]*))[^>]*?\/?>/g;
  const tags: TagInfo[] = [];
  let m: RegExpExecArray | null;

  while ((m = tagRegex.exec(text)) !== null) {
    if (text[m.index + 1] === '?' || text[m.index + 1] === '!') continue;
    tags.push({
      index: m.index,
      end: m.index + m[0].length,
      name: m[2],
      isClose: m[1].startsWith('/'),
      isSelfClose: m[0].endsWith('/>'),
    });
  }

  const roots: ElementNode[] = [];
  const stack: ElementNode[] = [];

  for (const tag of tags) {
    if (tag.isSelfClose) {
      const node: ElementNode = {
        name: tag.name,
        start: tag.index,
        openEnd: tag.end,
        closeEnd: tag.end,
        children: [],
        parent: stack.length > 0 ? stack[stack.length - 1] : null,
      };
      if (node.parent) {
        node.parent.children.push(node);
      } else {
        roots.push(node);
      }
      continue;
    }
    if (!tag.isClose) {
      const node: ElementNode = {
        name: tag.name,
        start: tag.index,
        openEnd: tag.end,
        closeEnd: -1,
        children: [],
        parent: stack.length > 0 ? stack[stack.length - 1] : null,
      };
      if (node.parent) {
        node.parent.children.push(node);
      } else {
        roots.push(node);
      }
      stack.push(node);
    } else {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === tag.name) {
          stack[i].closeEnd = tag.end;
          stack.splice(i, 1);
          break;
        }
      }
    }
  }

  return roots;
}

function findNodeAtOffset(nodes: ElementNode[], offset: number): ElementNode | null {
  for (const node of nodes) {
    if (offset >= node.start && offset <= node.closeEnd) {
      // Check children first (innermost match)
      const child = findNodeAtOffset(node.children, offset);
      return child || node;
    }
  }
  return null;
}

function goToParent(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const text = doc.getText();
  const offset = doc.offsetAt(editor.selection.active);

  const roots = buildElementTree(text);
  const current = findNodeAtOffset(roots, offset);
  if (!current) return;

  // If cursor is already at the start of current element, go to parent
  const target = (offset === current.start && current.parent) ? current.parent : current.parent ?? current;

  if (target) {
    jumpTo(editor, doc, target.start);
  }
}

function getNextSibling(node: ElementNode): ElementNode | null {
  if (!node.parent) return null;
  const siblings = node.parent.children;
  const idx = siblings.indexOf(node);
  if (idx >= 0 && idx < siblings.length - 1) {
    return siblings[idx + 1];
  }
  return null;
}

function getPrevSibling(node: ElementNode): ElementNode | null {
  if (!node.parent) return null;
  const siblings = node.parent.children;
  const idx = siblings.indexOf(node);
  if (idx > 0) {
    return siblings[idx - 1];
  }
  return null;
}

function goToNextSibling(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const text = doc.getText();
  const offset = doc.offsetAt(editor.selection.active);

  const roots = buildElementTree(text);
  const current = findNodeAtOffset(roots, offset);
  if (!current) return;

  const next = getNextSibling(current);
  if (next) {
    jumpTo(editor, doc, next.start);
  }
}

function goToPrevSibling(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const text = doc.getText();
  const offset = doc.offsetAt(editor.selection.active);

  const roots = buildElementTree(text);
  const current = findNodeAtOffset(roots, offset);
  if (!current) return;

  const prev = getPrevSibling(current);
  if (prev) {
    jumpTo(editor, doc, prev.start);
  }
}

function goToFirstChild(): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.languageId !== 'xml') return;

  const doc = editor.document;
  const text = doc.getText();
  const offset = doc.offsetAt(editor.selection.active);

  const roots = buildElementTree(text);
  const current = findNodeAtOffset(roots, offset);
  if (!current) return;

  // 1. Has children → go to first child
  if (current.children.length > 0) {
    jumpTo(editor, doc, current.children[0].start);
    return;
  }

  // 2. Has next sibling → go to next sibling
  const nextSibling = getNextSibling(current);
  if (nextSibling) {
    jumpTo(editor, doc, nextSibling.start);
    return;
  }

  // 3. Walk up ancestors until one has a next sibling
  let ancestor = current.parent;
  while (ancestor) {
    const ancestorSibling = getNextSibling(ancestor);
    if (ancestorSibling) {
      jumpTo(editor, doc, ancestorSibling.start);
      return;
    }
    ancestor = ancestor.parent;
  }
}

function jumpTo(editor: vscode.TextEditor, doc: vscode.TextDocument, offset: number): void {
  const pos = doc.positionAt(offset);
  editor.selection = new vscode.Selection(pos, pos);
  editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
}

let isInserting = false;

function autoCloseOnSlash(doc: vscode.TextDocument, change: vscode.TextDocumentChangeEvent['contentChanges'][0]): void {
  const offset = doc.offsetAt(change.range.start) + 1;
  if (offset < 2) return;

  // Only trigger when / follows <
  const twoChars = doc.getText(new vscode.Range(doc.positionAt(offset - 2), doc.positionAt(offset)));
  if (twoChars !== '</') return;

  // Don't insert if there's already a tag name after /
  const charAfter = offset < doc.getText().length ? doc.getText().charAt(offset) : '';
  if (/[a-zA-Z_]/.test(charAfter)) return;

  // Build element stack from start to just before </, tracking opening tag offsets
  const textBefore = doc.getText(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(offset - 2)));
  const stack: { name: string; offset: number }[] = [];
  const tagRegex = /<\/?([a-zA-Z_][\w:.-]*)[^>]*?\/?>/g;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(textBefore)) !== null) {
    if (m[0].startsWith('</')) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].name === m[1]) {
          stack.splice(i);
          break;
        }
      }
    } else if (!m[0].endsWith('/>')) {
      stack.push({ name: m[1], offset: m.index });
    }
  }

  if (stack.length === 0) return;

  const entry = stack[stack.length - 1];
  const elementToClose = entry.name;
  const pos = doc.positionAt(offset);
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc) return;

  // Check if </ is at the start of the line (only whitespace before it)
  const currentLine = doc.lineAt(pos.line);
  const textBeforeOnLine = currentLine.text.substring(0, pos.character);
  const isAtLineStart = /^\s*<\/$/.test(textBeforeOnLine);

  isInserting = true;

  if (isAtLineStart) {
    // Adjust indentation to match the opening tag
    const openLine = doc.lineAt(doc.positionAt(entry.offset).line);
    const openIndent = openLine.text.match(/^(\s*)/)![1];
    const currentIndent = currentLine.text.match(/^(\s*)/)![1];

    editor.edit(editBuilder => {
      editBuilder.insert(pos, elementToClose + '>');
      if (currentIndent !== openIndent) {
        editBuilder.replace(
          new vscode.Range(new vscode.Position(pos.line, 0), new vscode.Position(pos.line, currentIndent.length)),
          openIndent,
        );
      }
    }, { undoStopBefore: false, undoStopAfter: false })
    .then(() => { isInserting = false; }, () => { isInserting = false; });
  } else {
    editor.insertSnippet(
      new vscode.SnippetString(`${elementToClose}>`),
      pos,
      { undoStopBefore: false, undoStopAfter: false }
    ).then(() => { isInserting = false; }, () => { isInserting = false; });
  }
}

function onDocumentChange(event: vscode.TextDocumentChangeEvent): void {
  if (isInserting) return;
  if (event.document.languageId !== 'xml') return;
  if (event.contentChanges.length === 0) return;

  const change = event.contentChanges[0];
  const doc = event.document;

  if (change.text === '/') {
    autoCloseOnSlash(doc, change);
    return;
  }

  if (!change.text.endsWith('>')) return;

  // Compute position right after the inserted ">" from the change itself
  const offset = doc.offsetAt(change.range.start) + change.text.length;
  const pos = doc.positionAt(offset);

  // Get text from the line start up to (and including) the ">"
  const lineText = doc.getText(new vscode.Range(new vscode.Position(pos.line, 0), pos));

  // Must not be: self-closing />, comment -->, PI ?>, closing tag </...>
  if (lineText.endsWith('/>')) return;
  if (lineText.endsWith('-->')) return;
  if (lineText.endsWith('?>')) return;

  // Find the opening < for this >
  const tagMatch = lineText.match(/<([a-zA-Z_][\w:.-]*)[^<]*>$/);
  if (!tagMatch) return;

  // Check it's not a closing tag
  if (tagMatch[0].startsWith('</')) return;

  const tagName = tagMatch[1];

  // Check if there's already a closing tag right after
  const restOfLine = doc.getText(new vscode.Range(pos, new vscode.Position(pos.line, pos.character + tagName.length + 3)));
  if (restOfLine === `</${tagName}>`) return;

  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document !== doc) return;

  isInserting = true;
  editor.insertSnippet(
    new vscode.SnippetString(`$0</${tagName}>`),
    pos,
    { undoStopBefore: false, undoStopAfter: false }
  ).then(() => { isInserting = false; }, () => { isInserting = false; });
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }
  return client.stop();
}
