export interface ContentModel {
  elements: Map<string, ElementDeclaration>;
  // HTML/XHTML elements defined inline within the schema's `html` pattern
  // (p, div, span, table, …). Kept separate from `elements` so they only
  // surface as completions inside <HTML> and its descendants.
  htmlElements: Map<string, ElementDeclaration>;
  namespace: string;
}

export interface ElementDeclaration {
  name: string;
  documentation: string;
  attributes: AttributeDeclaration[];
  allowedChildren: string[];
  allowsText: boolean;
}

export interface AttributeDeclaration {
  name: string;
  documentation: string;
  required: boolean;
  values?: { value: string; documentation?: string }[];
  pattern?: string;
}
