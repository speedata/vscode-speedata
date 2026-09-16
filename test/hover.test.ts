import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getHover } from '../src/server/hoverProvider';
import { contextAfter, layout, publisher, xts, PUBLISHER_NS, XTS_NS } from './helpers';

const hoverText = (h: ReturnType<typeof getHover>) => (h!.contents as { value: string }).value;

test('element hover links to the schema doc URL', () => {
  const d = layout(XTS_NS, '<DefineColor name="a" value="red"/>');
  const h = getHover(contextAfter(d, '<Define'), xts(), 'en');
  assert.ok(hoverText(h).includes('[Documentation](https://doc.speedata.de/xts/reference/commands/definecolor/)'));

  const p = layout(PUBLISHER_NS, '<DefineColor name="a" value="red"/>');
  const hp = getHover(contextAfter(p, '<Define'), publisher(), 'de');
  assert.ok(hoverText(hp).includes('[Dokumentation](https://doc.speedata.de/publisher/en/commandreference/definecolor/)'));
});
