import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatDocument } from '../src/server/formattingProvider';
import { doc, xts, publisher } from './helpers';

const opts = { tabSize: 2, insertSpaces: true };
const format = (xml: string, model = xts()) => formatDocument(doc(xml), opts, model)[0]?.newText ?? xml;

test('preserve, blank-lines and inline hints steer the formatter', () => {
  const out = format('<Layout xmlns="urn:speedata.de/2021/xts/en"><Section name="s"><DefineColor name="a" model="RGB" r="1" g="1" b="1"/><Record match="x"><Value>  keep   this  </Value><HTML><p>hello\n   world</p><b>x</b></HTML></Record></Section></Layout>');
  assert.equal(out, `<Layout xmlns="urn:speedata.de/2021/xts/en">
  <Section name="s">
    <DefineColor name="a" model="RGB" r="1" g="1" b="1" />

    <Record match="x">
      <Value>  keep   this  </Value>
      <HTML>
        <p>hello world</p>
        <b>x</b>
      </HTML>
    </Record>
  </Section>
</Layout>
`);
});

test('formatting is idempotent', () => {
  const once = format('<Layout xmlns="urn:speedata.de/2021/xts/en"><Record match="a"/><Record match="b"><Value>x</Value></Record></Layout>');
  assert.equal(format(once), once);
});

test('Publisher schema uses the same hints', () => {
  const out = format('<Layout xmlns="urn:speedata.de:2009/publisher/en"><Record element="x"><Value> a  b </Value></Record></Layout>', publisher());
  assert.ok(out.includes('<Value> a  b </Value>'));
});
