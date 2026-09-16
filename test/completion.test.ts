import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CompletionItem } from 'vscode-languageserver/node';
import { getCompletions } from '../src/server/completionProvider';
import { contextAfter, doc, layout, publisher, xts, PUBLISHER_NS, XTS_NS } from './helpers';

const labels = (items: CompletionItem[]) => items.map(i => i.label);

test('attribute value: names defined in the document plus built-in names', () => {
  const d = layout(XTS_NS, `
    <DefineColor name="brand" model="rgb" r="1" g="2" b="3"/>
    <DefineColor name="{$dynamic}" model="rgb" r="1" g="2" b="3"/>
    <PlaceObject><Box background-color="" width="1" height="1"/></PlaceObject>`);
  const items = getCompletions(contextAfter(d, 'background-color="'), xts(), d);
  const l = labels(items);
  assert.ok(l.includes('brand'));
  assert.ok(!l.includes('{$dynamic}'), 'dynamic names are skipped');
  assert.ok(l.includes('black'), 'built-in color');
  assert.equal(items.find(i => i.label === 'brand')!.detail, '(from DefineColor)');
  assert.equal(items.find(i => i.label === 'black')!.detail, '(built-in)');
});

test('xpath-string definitions: only string literals define a mark', () => {
  const d = layout(PUBLISHER_NS, `
    <Mark select="'chapter1'"/>
    <Mark select="concat('a', $b)"/>
    <Record element="x"><Paragraph><A link=""/></Paragraph></Record>`);
  const items = getCompletions(contextAfter(d, 'link="'), publisher(), d);
  assert.deepEqual(labels(items), ['chapter1']);
});

test('xpath-variable references insert $name and replace a typed $prefix', () => {
  const d = layout(PUBLISHER_NS, `
    <SetVariable variable="counter" select="1"/>
    <Loop select="3" variable="idx"><Value/></Loop>
    <Bookmark select="$co" level="1"/>`);
  const items = getCompletions(contextAfter(d, 'select="$co'), publisher(), d);
  assert.deepEqual(labels(items).sort(), ['$counter', '$idx']);
  const counter = items.find(i => i.label === '$counter')!;
  const edit = counter.textEdit as { range: { start: { character: number }; end: { character: number } }; newText: string };
  assert.equal(edit.newText, '$counter');
  assert.equal(edit.range.end.character - edit.range.start.character, 3, 'replaces "$co"');
});

test('attribute names: xmlns prefixes from the schema namespaces', () => {
  const d = doc(`<Layout xmlns="${XTS_NS}" `);
  const items = getCompletions(contextAfter(d, '" '), xts(), d);
  const sd = items.find(i => i.label === 'xmlns:sd')!;
  assert.equal(sd.insertText, 'xmlns:sd="urn:speedata.de/2021/xtsfunctions/en"');
  assert.ok(labels(items).includes('xmlns:map'));

  const p = doc(`<Layout xmlns="${PUBLISHER_NS}" `);
  const pItems = getCompletions(contextAfter(p, '" '), publisher(), p);
  assert.equal(pItems.find(i => i.label === 'xmlns:sd')!.insertText, 'xmlns:sd="urn:speedata:2009/publisher/functions/en"');
});

test('attribute names: when rules hide forbidden and mark required attributes', () => {
  const d = layout(XTS_NS, '<DefineColor name="c" model="cmyk" ');
  const items = getCompletions(contextAfter(d, 'model="cmyk" '), xts(), d);
  const l = labels(items);
  for (const req of ['c', 'm', 'y', 'k']) {
    assert.equal(items.find(i => i.label === req)!.detail, '(required)');
  }
  for (const forbidden of ['r', 'g', 'b', 'value', 'colorname']) {
    assert.ok(!l.includes(forbidden), `${forbidden} hidden for cmyk`);
  }

  // Without model: value is required, the component attributes are hidden.
  const d2 = layout(XTS_NS, '<DefineColor name="c" ');
  const items2 = getCompletions(contextAfter(d2, 'name="c" '), xts(), d2);
  assert.equal(items2.find(i => i.label === 'value')!.detail, '(required)');
  assert.ok(!labels(items2).includes('r'));
});

test('attribute names: exclusive rules hide alternatives once one is set', () => {
  const d = layout(XTS_NS, '<Message select="1" ');
  const items = getCompletions(contextAfter(d, 'select="1" '), xts(), d);
  assert.ok(!labels(items).includes('select'));
});

test('element completion snippets are unaffected by annotations', () => {
  const d = layout(XTS_NS, '<');
  const items = getCompletions(contextAfter(d, '\n<'), xts(), d);
  const dc = items.find(i => i.label === 'DefineColor')!;
  assert.match(String(dc.insertText), /^DefineColor name="\$\{1:\}"/);
});
