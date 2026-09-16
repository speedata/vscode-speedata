import * as fs from 'fs';
import * as path from 'path';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ContentModel } from '../src/server/contentModel';
import { parseRng } from '../src/server/rngParser';
import { analyzeDocument, CursorContext } from '../src/server/xmlDocumentAnalyzer';

const cache = new Map<string, ContentModel>();

/** Parse one of the bundled schemas (cached per test run). */
export function loadModel(file: 'layoutschema-en.rng' | 'layoutschema-de.rng' | 'xts-layoutschema-en.rng' | 'xts-layoutschema-de.rng'): ContentModel {
  let model = cache.get(file);
  if (!model) {
    model = parseRng(fs.readFileSync(path.resolve('schemas', file), 'utf-8'));
    cache.set(file, model);
  }
  return model;
}

export const publisher = () => loadModel('layoutschema-en.rng');
export const xts = () => loadModel('xts-layoutschema-en.rng');

export const PUBLISHER_NS = 'urn:speedata.de:2009/publisher/en';
export const XTS_NS = 'urn:speedata.de/2021/xts/en';

/** A layout document wrapping `body` in a <Layout> root of the given namespace. */
export function layout(ns: string, body: string): TextDocument {
  return doc(`<Layout xmlns="${ns}">\n${body}\n</Layout>`);
}

export function doc(xml: string): TextDocument {
  return TextDocument.create('file:///test/layout.xml', 'xml', 1, xml);
}

/**
 * Cursor context at the position right after the first occurrence of `needle`
 * in the document. Fails if the needle is not found.
 */
export function contextAfter(document: TextDocument, needle: string): CursorContext {
  const text = document.getText();
  const idx = text.indexOf(needle);
  if (idx < 0) throw new Error(`needle not found: ${needle}`);
  return analyzeDocument(document, document.positionAt(idx + needle.length));
}
