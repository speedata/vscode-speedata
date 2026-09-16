import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SymbolKind } from 'vscode-languageserver/node';
import { getDocumentSymbols } from '../src/server/documentSymbolProvider';
import { layout, publisher, xts, PUBLISHER_NS, XTS_NS } from './helpers';

test('symbols follow lsp:symbol templates and nest by element structure', () => {
  const d = layout(XTS_NS, `
    <DefineMasterPage name="mp"/>
    <Section name="Setup">
      <!-- <Record match="commented out"/> -->
      <Record match="book" mode="toc"><Record match="inner"/></Record>
      <Function name="fn"/>
      <Template name="tpl"/>
    </Section>
    <Record match="noname"/>
    <Record/>`);
  const syms = getDocumentSymbols(d, xts());
  assert.deepEqual(syms.map(s => [s.name, s.kind]), [
    ['mp', SymbolKind.Object],
    ['Setup', SymbolKind.Namespace],
    ['noname', SymbolKind.Struct],
  ]);
  const setup = syms[1];
  assert.deepEqual(setup.children!.map(s => [s.name, s.detail, s.kind]), [
    ['book', 'toc', SymbolKind.Struct],
    ['fn', undefined, SymbolKind.Function],
    ['tpl', undefined, SymbolKind.Method],
  ]);
  assert.deepEqual(setup.children![0].children!.map(s => s.name), ['inner']);
  // Range of a container spans up to its closing tag.
  assert.ok(setup.range.end.line > setup.selectionRange.end.line);
});

test('Publisher Record uses element or match', () => {
  const d = layout(PUBLISHER_NS, '<Record element="data" mode="m"/><Record match="x"/>');
  const syms = getDocumentSymbols(d, publisher());
  assert.deepEqual(syms.map(s => [s.name, s.detail]), [['data', 'm'], ['x', undefined]]);
});

test('no schema or no symbol hints yields no symbols', () => {
  const d = layout(PUBLISHER_NS, '<Section name="x"/>');
  assert.deepEqual(getDocumentSymbols(d, undefined), []);
});
