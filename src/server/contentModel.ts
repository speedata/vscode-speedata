export interface ContentModel {
  elements: Map<string, ElementDeclaration>;
  // HTML/XHTML elements defined inline within the schema's `html` pattern
  // (p, div, span, table, …). Kept separate from `elements` so they only
  // surface as completions inside <HTML> and its descendants.
  htmlElements: Map<string, ElementDeclaration>;
  namespace: string;
  // Index of `<lsp:defines symbol="…">` annotations: symbol → the
  // element/attribute pairs whose values define names of that symbol.
  symbolDefinitions: Map<string, SymbolDefinition[]>;
  // `<lsp:namespace prefix="…" uri="…">` (grammar level): prefixes worth
  // offering when completing xmlns: on the root element.
  namespaces: NamespaceHint[];
  // `<lsp:builtin symbol="…" names="…">` (grammar level): names of a symbol
  // that exist without a definition in the layout.
  builtins: Map<string, string[]>;
}

export interface NamespaceHint {
  prefix: string;
  uri: string;
}

export interface ElementDeclaration {
  name: string;
  documentation: string;
  attributes: AttributeDeclaration[];
  allowedChildren: string[];
  allowsText: boolean;
  // The content model contains a wildcard element (<anyName/> or <nsName/>
  // outside an <except>), so arbitrary child elements are permitted and are
  // not validated.
  allowsAnyChildren: boolean;
  // `<lsp:format …>` annotation on the element, if any.
  format?: FormatHints;
  // `<lsp:doc href="…">`: reference page of the command in the online manual.
  docUrl?: string;
  // `<lsp:symbol …>`: the element is a document symbol (outline entry).
  symbol?: SymbolHint;
  // `<lsp:exclusive …>` rules on the element.
  exclusives?: ExclusiveRule[];
  // `<lsp:when …>` rules on the element.
  whens?: WhenRule[];
}

/** `<lsp:symbol kind="…" label="…" detail="…">`. */
export interface SymbolHint {
  // LSP SymbolKind name in lower camel case (namespace, struct, function, …).
  kind: string;
  // Templates; `{@attr}` is replaced by the value of that attribute.
  label: string;
  detail?: string;
}

/** At most one of `attributes` and, with `content`, the element content may be present. */
export interface ExclusiveRule {
  attributes: string[];
  content: boolean;
}

/**
 * When `attribute` has `value` (or is absent, if `value` is undefined), the
 * attributes in `requires` must be present and those in `forbids` absent.
 */
export interface WhenRule {
  attribute: string;
  value?: string;
  requires: string[];
  forbids: string[];
}

export interface AttributeDeclaration {
  name: string;
  documentation: string;
  required: boolean;
  values?: { value: string; documentation?: string }[];
  pattern?: string;
  // `<lsp:defines symbol="…">`: values of this attribute introduce a name.
  defines?: SymbolAnnotation;
  // `<lsp:references symbol="…">`: values of this attribute refer to a
  // name introduced by a `defines` annotation with the same symbol.
  references?: SymbolAnnotation;
}

/**
 * Annotation from the `urn:xml-lsp:annotations` namespace on an attribute.
 * `form` describes how the name is embedded in the attribute value:
 *   - undefined        → the value is the plain name
 *   - 'xpath-string'   → the value is an XPath string literal ('name')
 *   - 'xpath-variable' → the value is an XPath expression using $name
 */
export interface SymbolAnnotation {
  symbol: string;
  form?: 'xpath-string' | 'xpath-variable' | string;
}

export interface SymbolDefinition {
  element: string;
  attribute: string;
  form?: string;
}

/** `<lsp:format>` hints controlling the document formatter. */
export interface FormatHints {
  // Keep the element's content verbatim (e.g. <Value>).
  preserve?: boolean;
  // Separate the element's children by blank lines (e.g. <Section>).
  blankLines?: boolean;
  // The element holds inline flow content (e.g. <HTML>); text-only
  // descendants stay on one line and whitespace runs collapse.
  inline?: boolean;
}
