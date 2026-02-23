import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionParams,
  CompletionItem,
  HoverParams,
  Hover,
  TextDocumentChangeEvent,
  DidChangeConfigurationNotification,
  LinkedEditingRangeParams,
  LinkedEditingRanges,
  Position,
  DocumentSymbol,
  SymbolKind,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel } from './contentModel';
import { parseRng } from './rngParser';
import { parseCatalog } from './catalog';
import { analyzeDocument, CursorContext } from './xmlDocumentAnalyzer';
import { getCompletions } from './completionProvider';
import { getHover } from './hoverProvider';
import { validateDocument } from './diagnosticsProvider';
import { formatDocument } from './formattingProvider';
import * as fs from 'fs';
import * as path from 'path';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);

interface SpeedataSettings {
  catalog: string;
  schemaLanguage: 'auto' | 'de' | 'en';
}

let globalSettings: SpeedataSettings = { catalog: '', schemaLanguage: 'auto' };
let clientLanguage = 'en';

// Cache: schema URI → ContentModel
const schemaCache = new Map<string, ContentModel>();

// Cache: catalog path → parsed catalog
const catalogCache = new Map<string, Map<string, string>>();

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const initOptions = params.initializationOptions as { language?: string } | undefined;
  if (initOptions?.language) {
    clientLanguage = initOptions.language;
  }
  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Full,
      completionProvider: { triggerCharacters: ['<', ' ', '"', '='] },
      hoverProvider: true,
      linkedEditingRangeProvider: true,
      documentFormattingProvider: true,
      documentSymbolProvider: true,
    },
  };
});

connection.onInitialized(async () => {
  connection.client.register(DidChangeConfigurationNotification.type);
  // Load initial settings
  await pullSettings();
});

async function pullSettings(): Promise<void> {
  const config = await connection.workspace.getConfiguration('speedata');
  if (config) {
    const prev = globalSettings;
    globalSettings = {
      catalog: config.catalog || '',
      schemaLanguage: config.schemaLanguage || 'auto',
    };
    // Clear schema cache when language setting changes so the correct schema is loaded
    if (prev.schemaLanguage !== globalSettings.schemaLanguage) {
      schemaCache.clear();
    }
  }
  documents.all().forEach(validateOpenDocument);
}

connection.onDidChangeConfiguration(async () => {
  await pullSettings();
});

function resolveSchemaForDocument(doc: TextDocument): ContentModel | undefined {
  const text = doc.getText();

  // 1. Check for xml-model processing instruction
  const piMatch = text.match(/<\?xml-model\s+href="([^"]+)"[^?]*\?>/);
  if (piMatch) {
    const href = piMatch[1];
    const docUri = doc.uri.startsWith('file://') ? doc.uri.slice(7) : doc.uri;
    const schemaPath = path.resolve(path.dirname(docUri), href);
    return loadSchema(schemaPath);
  }

  // 2. Check catalog by namespace
  if (globalSettings.catalog) {
    const nsMatch = text.match(/xmlns="([^"]+)"/);
    if (nsMatch) {
      const ns = nsMatch[1];
      const catalog = loadCatalog(globalSettings.catalog);
      if (catalog) {
        const schemaUri = catalog.get(ns);
        if (schemaUri) {
          const catalogDir = path.dirname(globalSettings.catalog);
          const schemaPath = path.resolve(catalogDir, schemaUri);
          return loadSchema(schemaPath);
        }
      }
    }
  }

  // 3. Built-in schema by namespace
  const nsMatch = text.match(/xmlns="([^"]+)"/);
  if (nsMatch && nsMatch[1] === 'urn:speedata.de:2009/publisher/en') {
    const lang = resolveLanguage();
    const schemaFile = lang.startsWith('de')
      ? 'layoutschema-de.rng'
      : 'layoutschema-en.rng';
    const schemaPath = path.resolve(__dirname, '..', '..', 'schemas', schemaFile);
    return loadSchema(schemaPath);
  }

  return undefined;
}

function resolveLanguage(): string {
  return globalSettings.schemaLanguage === 'auto'
    ? clientLanguage
    : globalSettings.schemaLanguage;
}

function loadSchema(schemaPath: string): ContentModel | undefined {
  const cached = schemaCache.get(schemaPath);
  if (cached) {
    return cached;
  }
  try {
    if (!fs.existsSync(schemaPath)) {
      connection.console.warn(`Schema not found: ${schemaPath}`);
      return undefined;
    }
    const content = fs.readFileSync(schemaPath, 'utf-8');
    const model = parseRng(content);
    schemaCache.set(schemaPath, model);
    return model;
  } catch (e) {
    connection.console.error(`Error loading schema ${schemaPath}: ${e}`);
    return undefined;
  }
}

function loadCatalog(catalogPath: string): Map<string, string> | undefined {
  const cached = catalogCache.get(catalogPath);
  if (cached) {
    return cached;
  }
  try {
    if (!fs.existsSync(catalogPath)) {
      return undefined;
    }
    const content = fs.readFileSync(catalogPath, 'utf-8');
    const catalog = parseCatalog(content);
    catalogCache.set(catalogPath, catalog);
    return catalog;
  } catch (e) {
    connection.console.error(`Error loading catalog ${catalogPath}: ${e}`);
    return undefined;
  }
}

function validateOpenDocument(doc: TextDocument): void {
  const model = resolveSchemaForDocument(doc);
  if (!model) {
    // No schema → clear diagnostics
    connection.sendDiagnostics({ uri: doc.uri, diagnostics: [] });
    return;
  }
  const diagnostics = validateDocument(doc, model);
  connection.sendDiagnostics({ uri: doc.uri, diagnostics });
}

documents.onDidChangeContent((change: TextDocumentChangeEvent<TextDocument>) => {
  validateOpenDocument(change.document);
});

documents.onDidClose((event) => {
  connection.sendDiagnostics({ uri: event.document.uri, diagnostics: [] });
});

connection.onCompletion((params: CompletionParams): CompletionItem[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  const model = resolveSchemaForDocument(doc);
  if (!model) return [];
  const context = analyzeDocument(doc, params.position);
  return getCompletions(context, model);
});

connection.onHover((params: HoverParams): Hover | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  const model = resolveSchemaForDocument(doc);
  if (!model) return null;
  const context = analyzeDocument(doc, params.position);
  return getHover(context, model, resolveLanguage());
});

connection.onDocumentFormatting((params) => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return formatDocument(doc, params.options);
});

connection.onDocumentSymbol((params): DocumentSymbol[] => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return [];
  return getDocumentSymbols(doc);
});

connection.onRequest('textDocument/linkedEditingRange', (params: LinkedEditingRangeParams): LinkedEditingRanges | null => {
  const doc = documents.get(params.textDocument.uri);
  if (!doc) return null;
  return getLinkedEditingRanges(doc, params.position);
});

function getDocumentSymbols(doc: TextDocument): DocumentSymbol[] {
  const text = doc.getText();
  const topLevel: DocumentSymbol[] = [];

  // First pass: collect all Section symbols
  const sectionRegex = /<Section\b([^>]*?)(\/?)>/g;
  const sections: { symbol: DocumentSymbol; startOffset: number; endOffset: number }[] = [];
  let sMatch: RegExpExecArray | null;

  while ((sMatch = sectionRegex.exec(text)) !== null) {
    const attrsStr = sMatch[1];
    const selfClosing = sMatch[2] === '/';
    const tagStart = sMatch.index;

    const nameMatch = attrsStr.match(/\bname\s*=\s*"([^"]*)"/);
    if (!nameMatch) continue;

    const selectionStart = doc.positionAt(tagStart);
    const selectionEnd = doc.positionAt(tagStart + sMatch[0].length);

    let rangeEnd: Position;
    let endOffset: number;
    if (selfClosing) {
      rangeEnd = selectionEnd;
      endOffset = tagStart + sMatch[0].length;
    } else {
      const closeRange = findMatchingCloseTag(text, tagStart, 'Section', doc);
      if (closeRange) {
        const closeTagEndOffset = text.indexOf('>', doc.offsetAt(closeRange.end));
        endOffset = closeTagEndOffset !== -1 ? closeTagEndOffset + 1 : doc.offsetAt(closeRange.end);
        rangeEnd = doc.positionAt(endOffset);
      } else {
        rangeEnd = selectionEnd;
        endOffset = tagStart + sMatch[0].length;
      }
    }

    const sym = DocumentSymbol.create(
      nameMatch[1],
      undefined,
      SymbolKind.Namespace,
      { start: selectionStart, end: rangeEnd },
      { start: selectionStart, end: selectionEnd },
    );
    sym.children = [];
    sections.push({ symbol: sym, startOffset: tagStart, endOffset });
    topLevel.push(sym);
  }

  // Second pass: collect Record and Function symbols, nest inside Sections if applicable
  const symbolTagRegex = /<(Record|Function)\b([^>]*?)(\/?)>/g;
  let match: RegExpExecArray | null;

  while ((match = symbolTagRegex.exec(text)) !== null) {
    const tagName = match[1];
    const attrsStr = match[2];
    const selfClosing = match[3] === '/';
    const tagStart = match.index;

    let symbolName: string | undefined;
    if (tagName === 'Record') {
      const elementMatch = attrsStr.match(/\belement\s*=\s*"([^"]*)"/);
      if (!elementMatch) continue;
      symbolName = elementMatch[1];
      const modeMatch = attrsStr.match(/\bmode\s*=\s*"([^"]*)"/);
      if (modeMatch) {
        symbolName += ` (${modeMatch[1]})`;
      }
    } else {
      const nameMatch = attrsStr.match(/\bname\s*=\s*"([^"]*)"/);
      if (!nameMatch) continue;
      symbolName = nameMatch[1];
    }

    const selectionStart = doc.positionAt(tagStart);
    const selectionEnd = doc.positionAt(tagStart + match[0].length);

    let rangeEnd: Position;
    if (selfClosing) {
      rangeEnd = selectionEnd;
    } else {
      const closeRange = findMatchingCloseTag(text, tagStart, tagName, doc);
      if (closeRange) {
        const closeTagEndOffset = text.indexOf('>', doc.offsetAt(closeRange.end));
        rangeEnd = closeTagEndOffset !== -1
          ? doc.positionAt(closeTagEndOffset + 1)
          : closeRange.end;
      } else {
        rangeEnd = selectionEnd;
      }
    }

    const sym = DocumentSymbol.create(
      symbolName,
      undefined,
      tagName === 'Function' ? SymbolKind.Function : SymbolKind.Struct,
      { start: selectionStart, end: rangeEnd },
      { start: selectionStart, end: selectionEnd },
    );

    // Check if this symbol is inside a Section
    const parentSection = sections.find(s => tagStart > s.startOffset && tagStart < s.endOffset);
    if (parentSection) {
      parentSection.symbol.children!.push(sym);
    } else {
      topLevel.push(sym);
    }
  }

  return topLevel;
}

function getLinkedEditingRanges(doc: TextDocument, position: Position): LinkedEditingRanges | null {
  const text = doc.getText();
  const offset = doc.offsetAt(position);

  // Find the tag at cursor position by scanning backwards for <
  let bracketPos = -1;
  for (let i = offset; i >= 0; i--) {
    if (text[i] === '<') {
      bracketPos = i;
      break;
    }
    // If we hit > before <, cursor is not inside a tag name
    if (text[i] === '>' && i < offset) {
      return null;
    }
  }
  if (bracketPos === -1) return null;

  const isCloseTag = text[bracketPos + 1] === '/';
  const nameOffset = bracketPos + (isCloseTag ? 2 : 1);

  // Extract tag name starting at nameOffset
  const nameMatch = text.substring(nameOffset).match(/^([a-zA-Z_][\w:.-]*)/);
  if (!nameMatch) return null;

  const tagName = nameMatch[1];
  const nameStart = nameOffset;
  const nameEnd = nameOffset + tagName.length;

  // Check cursor is actually on the tag name
  if (offset < nameStart || offset > nameEnd) return null;

  const cursorRange = { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) };

  if (isCloseTag) {
    const partnerRange = findMatchingOpenTag(text, bracketPos, tagName, doc);
    if (!partnerRange) return null;
    return {
      ranges: [partnerRange, cursorRange],
      wordPattern: '[a-zA-Z_][\\w:.-]*',
    };
  } else {
    // Check if self-closing
    const tagEnd = text.indexOf('>', bracketPos);
    if (tagEnd !== -1 && text[tagEnd - 1] === '/') return null;

    const partnerRange = findMatchingCloseTag(text, bracketPos, tagName, doc);
    if (!partnerRange) return null;
    return {
      ranges: [cursorRange, partnerRange],
      wordPattern: '[a-zA-Z_][\\w:.-]*',
    };
  }
}

function findMatchingCloseTag(text: string, openTagOffset: number, tagName: string, doc: TextDocument): { start: Position; end: Position } | null {
  // Scan forward from after the opening tag, tracking nesting depth
  const startSearch = text.indexOf('>', openTagOffset);
  if (startSearch === -1) return null;

  // Check if self-closing
  if (text[startSearch - 1] === '/') return null;

  let depth = 1;
  const tagRegex = /<(\/?)(([a-zA-Z_][\w:.-]*))(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  tagRegex.lastIndex = startSearch + 1;

  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(text)) !== null) {
    const isClose = m[1] === '/';
    const isSelfClose = m[0].endsWith('/>');
    const name = m[3];

    if (name !== tagName) continue;
    if (isSelfClose) continue;

    if (isClose) {
      depth--;
      if (depth === 0) {
        const nameStart = m.index + 2; // after </
        const nameEnd = nameStart + name.length;
        return { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) };
      }
    } else {
      depth++;
    }
  }
  return null;
}

function findMatchingOpenTag(text: string, closeTagOffset: number, tagName: string, doc: TextDocument): { start: Position; end: Position } | null {
  // Scan backward from the closing tag, tracking nesting depth
  let depth = 1;

  // Collect all tags before closeTagOffset
  const tagRegex = /<(\/?)(([a-zA-Z_][\w:.-]*))(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const tags: { index: number; isClose: boolean; isSelfClose: boolean; name: string; nameLen: number }[] = [];

  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(text)) !== null) {
    if (m.index >= closeTagOffset) break;
    tags.push({
      index: m.index,
      isClose: m[1] === '/',
      isSelfClose: m[0].endsWith('/>'),
      name: m[3],
      nameLen: m[3].length,
    });
  }

  // Walk backwards
  for (let i = tags.length - 1; i >= 0; i--) {
    const t = tags[i];
    if (t.name !== tagName || t.isSelfClose) continue;

    if (t.isClose) {
      depth++;
    } else {
      depth--;
      if (depth === 0) {
        const nameStart = t.index + 1; // after <
        const nameEnd = nameStart + t.nameLen;
        return { start: doc.positionAt(nameStart), end: doc.positionAt(nameEnd) };
      }
    }
  }
  return null;
}

documents.listen(connection);
connection.listen();
