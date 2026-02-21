export interface ContentModel {
  elements: Map<string, ElementDeclaration>;
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
