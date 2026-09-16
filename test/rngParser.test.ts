import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publisher, xts } from './helpers';

test('grammar-level annotations: namespaces and builtins', () => {
  const m = xts();
  assert.deepEqual(m.namespaces.map(n => n.prefix), ['sd', 'map', 'array']);
  assert.equal(m.namespaces[0].uri, 'urn:speedata.de/2021/xtsfunctions/en');
  assert.ok(m.builtins.get('color')!.includes('rebeccapurple'));
  assert.deepEqual(m.builtins.get('variable'), ['_lastpage']);

  const p = publisher();
  assert.equal(p.namespaces.find(n => n.prefix === 'sd')?.uri, 'urn:speedata:2009/publisher/functions/en');
  assert.deepEqual(p.builtins.get('textformat'), ['text', 'justified', 'centered', 'left', 'right']);
});

test('defines/references with form, indexed by symbol', () => {
  const m = publisher();
  const mark = m.symbolDefinitions.get('mark');
  assert.deepEqual(mark, [{ element: 'Mark', attribute: 'select', form: 'xpath-string' }]);
  assert.deepEqual(m.symbolDefinitions.get('color'), [{ element: 'DefineColor', attribute: 'name', form: undefined }]);

  const loop = m.elements.get('Loop')!;
  assert.deepEqual(loop.attributes.find(a => a.name === 'select')!.references, { symbol: 'variable', form: 'xpath-variable' });
  assert.deepEqual(loop.attributes.find(a => a.name === 'variable')!.defines, { symbol: 'variable', form: undefined });
});

test('element-level annotations: format, doc, symbol, exclusive, when', () => {
  const m = xts();
  assert.deepEqual(m.elements.get('Value')!.format, { preserve: true });
  assert.deepEqual(m.elements.get('Section')!.format, { blankLines: true });
  assert.deepEqual(m.elements.get('HTML')!.format, { inline: true });
  assert.equal(m.elements.get('DefineColor')!.docUrl, 'https://doc.speedata.de/xts/reference/commands/definecolor/');
  assert.deepEqual(m.elements.get('Record')!.symbol, { kind: 'struct', label: '{@match}', detail: '{@mode}' });
  assert.deepEqual(m.elements.get('Value')!.exclusives, [{ attributes: ['select'], content: true }]);

  const whens = m.elements.get('DefineColor')!.whens!;
  assert.equal(whens.length, 7);
  assert.deepEqual(whens.find(w => w.value === 'cmyk'), {
    attribute: 'model', value: 'cmyk', requires: ['c', 'm', 'y', 'k'], forbids: ['r', 'g', 'b', 'value', 'colorname'],
  });
  // A rule without value applies when the attribute is absent.
  const absent = whens.find(w => w.value === undefined)!;
  assert.deepEqual(absent.requires, ['value']);
});

test('allowsAnyChildren comes from wildcards, but not from the foreign-nodes except pattern', () => {
  const m = xts();
  assert.equal(m.elements.get('Value')!.allowsAnyChildren, true);
  assert.equal(m.elements.get('HTML')!.allowsAnyChildren, true);
  // Layout references foreign-nodes (<anyName><except>…) — that is not a wildcard for own elements.
  assert.equal(m.elements.get('Layout')!.allowsAnyChildren, false);
  assert.equal(m.elements.get('DefineColor')!.allowsAnyChildren, false);

  const p = publisher();
  assert.ok([...p.elements.values()].every(e => !e.allowsAnyChildren), 'publisher schema declares no wildcard');
});

test('German and English schema carry identical annotations', () => {
  const en = xts();
  const de = require('./helpers').loadModel('xts-layoutschema-de.rng');
  assert.deepEqual([...de.symbolDefinitions.keys()].sort(), [...en.symbolDefinitions.keys()].sort());
  assert.deepEqual(de.elements.get('DefineColor')!.whens, en.elements.get('DefineColor')!.whens);
  assert.deepEqual(de.builtins.get('color'), en.builtins.get('color'));
});
