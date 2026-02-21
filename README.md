# vscode-speedata

VS Code extension providing XML language support powered by RelaxNG schemas. Built for the [speedata Publisher](https://www.speedata.de), but usable with any RNG schema.

## Features

### Language Server (LSP)
- **Hover documentation** — displays `a:documentation` from the RNG schema for elements and attributes
- **Completion** — suggestions for elements, attributes and enum values (with snippets)
- **Diagnostics** — validation against the schema (unknown elements/attributes, required attributes, invalid values)
- **Linked editing** — rename opening and closing tags in sync

### Editor Features
- **Auto-close tag** — typing `<Foo>` automatically inserts `</Foo>`
- **Smart commenting** (`Cmd+/`) — nested comments are escaped (`<!--` → `<!-/-`)
- **Select element** (`Cmd+Shift+A`) — selects the entire element including children, press again to expand to the parent

### XML Tree Navigation

| Shortcut | Action |
|---|---|
| `Ctrl+Up` | Jump to parent element |
| `Ctrl+Down` | Jump to child / next element (pre-order) |
| `Ctrl+Shift+Down` | Jump to next sibling element |
| `Ctrl+Shift+Up` | Jump to previous sibling element |

## Schema Association

### Processing Instruction (takes precedence)
```xml
<?xml-model href="path/to/schema.rng" type="application/xml"
            schematypens="http://relaxng.org/ns/structure/1.0"?>
<Layout xmlns="urn:speedata.de:2009/publisher/en">
```

### XML Catalog (setting)
```jsonc
{ "speedata.catalog": "/path/to/catalog.xml" }
```
```xml
<catalog xmlns="urn:oasis:names:tc:entity:xmlns:xml:catalog">
  <uri name="urn:speedata.de:2009/publisher/en" uri="layoutschema-de.rng"/>
</catalog>
```

## Development

```bash
npm install
npm run compile    # Build (esbuild)
npm run watch      # Watch mode
```

Press F5 in VS Code to launch the Extension Development Host.

## Packaging

```bash
npx vsce package
```
