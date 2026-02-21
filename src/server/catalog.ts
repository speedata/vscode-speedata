import * as sax from 'sax';

/**
 * Parse an OASIS XML Catalog file.
 * Returns a Map from namespace URI (or name) to schema URI.
 *
 * Supports:
 * - <uri name="..." uri="..." />
 * - <system systemId="..." uri="..." />
 * - <public publicId="..." uri="..." />
 */
export function parseCatalog(content: string): Map<string, string> {
  const catalog = new Map<string, string>();
  const parser = sax.parser(true, { trim: true });

  parser.onopentag = (node) => {
    const tag = localName(node.name);
    const attrs = node.attributes as Record<string, string>;

    switch (tag) {
      case 'uri':
        if (attrs['name'] && attrs['uri']) {
          catalog.set(attrs['name'], attrs['uri']);
        }
        break;
      case 'system':
        if (attrs['systemId'] && attrs['uri']) {
          catalog.set(attrs['systemId'], attrs['uri']);
        }
        break;
      case 'public':
        if (attrs['publicId'] && attrs['uri']) {
          catalog.set(attrs['publicId'], attrs['uri']);
        }
        break;
    }
  };

  parser.onerror = () => {
    parser.resume();
  };

  parser.write(content).close();
  return catalog;
}

function localName(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.substring(idx + 1) : name;
}
