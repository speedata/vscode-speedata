import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDocument } from '../src/server/diagnosticsProvider';
import { layout, publisher, xts, PUBLISHER_NS, XTS_NS } from './helpers';

const messages = (d: ReturnType<typeof layout>, m = xts()) => validateDocument(d, m).map(x => x.message);

test('when rules: required and forbidden attributes per model', () => {
  const msgs = messages(layout(XTS_NS, `
    <DefineColor name="a" model="cmyk" c="1" r="2"/>
    <DefineColor name="b"/>
    <DefineColor name="ok" model="gray" g="50"/>`));
  assert.ok(msgs.includes('Required attribute "m" is missing for model="cmyk"'));
  assert.ok(msgs.includes('Required attribute "y" is missing for model="cmyk"'));
  assert.ok(msgs.includes('Required attribute "k" is missing for model="cmyk"'));
  assert.ok(msgs.includes('Attribute "r" is not allowed for model="cmyk"'));
  assert.ok(msgs.includes('Required attribute "value" is missing when "model" is not set'));
  assert.ok(!msgs.some(m => m.includes('gray')), 'gray with g is valid');
  assert.equal(msgs.length, 5);
});

test('when rules also work with the Publisher schema', () => {
  const msgs = messages(layout(PUBLISHER_NS, '<DefineColor name="a" model="rgb" r="1" g="2"/>'), publisher());
  assert.deepEqual(msgs, ['Required attribute "b" is missing for model="rgb"']);
});

test('exclusive: select together with content is reported, comments do not count', () => {
  const body = `<Record match="x">
      <SetVariable variable="a" select="1">text</SetVariable>
      <SetVariable variable="b" select="1"><Value>1</Value></SetVariable>
      <SetVariable variable="c" select="1"> <!-- nothing --> </SetVariable>
      <SetVariable variable="d" select="1"/>
      <SetVariable variable="e"><Value>1</Value></SetVariable>
    </Record>`;
  const msgs = messages(layout(XTS_NS, body));
  const exclusive = msgs.filter(m => m.includes('either "select" or element content'));
  assert.equal(exclusive.length, 2);
});

test('wildcard content (xts HTML, Value) is not validated', () => {
  const msgs = messages(layout(XTS_NS, `<Record match="x">
      <PlaceObject><HTML><body><div class="x"><whatever/></div></body></HTML></PlaceObject>
      <Value><anything>x</anything></Value>
    </Record>`));
  assert.deepEqual(msgs, []);
});

test('nested wildcard elements close correctly and validation resumes afterwards', () => {
  const msgs = messages(layout(XTS_NS, `<Record match="x">
      <Value><Value>inner</Value><foo/></Value>
      <Bogus/>
    </Record>`));
  assert.deepEqual(msgs, ['Unknown element: <Bogus>']);
});

test('Publisher HTML content is skipped while its schema has no wildcard', () => {
  const msgs = messages(layout(PUBLISHER_NS, `<Record element="x">
      <Output><HTML><body><div class="x">text</div></body></HTML></Output>
    </Record>`), publisher());
  assert.deepEqual(msgs, []);
});

test('regular schema checks stay intact', () => {
  const msgs = messages(layout(XTS_NS, `<Record match="x" element="y"><Nope/></Record>`));
  assert.deepEqual(msgs.sort(), ['Unknown attribute "element" for <Record>', 'Unknown element: <Nope>']);
});
