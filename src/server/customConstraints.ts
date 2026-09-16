import { AttributeDeclaration, ContentModel, ElementDeclaration, ExclusiveRule, WhenRule } from './contentModel';

export interface CustomDiagnostic {
  message: string;
  severity: 'error' | 'warning';
}

interface Rules {
  whens: WhenRule[];
  exclusives: ExclusiveRule[];
}

/** The <lsp:when> and <lsp:exclusive> rules of an element. */
function rulesFor(model: ContentModel, elementName: string): Rules {
  const decl: ElementDeclaration | undefined = model.elements.get(elementName);
  return { whens: decl?.whens ?? [], exclusives: decl?.exclusives ?? [] };
}

/** The when rules whose condition holds for the given attributes. */
function activeWhens(rules: Rules, attributes: Map<string, string>): WhenRule[] {
  return rules.whens.filter(w =>
    w.value === undefined ? !attributes.has(w.attribute) : attributes.get(w.attribute) === w.value);
}

function describeCondition(w: WhenRule): string {
  return w.value === undefined
    ? `when "${w.attribute}" is not set`
    : `for ${w.attribute}="${w.value}"`;
}

export function validateCustomConstraints(
  model: ContentModel,
  elementName: string,
  attributes: Map<string, string>,
  hasContent: boolean,
): CustomDiagnostic[] {
  const rules = rulesFor(model, elementName);
  const diagnostics: CustomDiagnostic[] = [];

  for (const w of activeWhens(rules, attributes)) {
    for (const req of w.requires) {
      if (!attributes.has(req)) {
        diagnostics.push({
          message: `Required attribute "${req}" is missing ${describeCondition(w)}`,
          severity: 'error',
        });
      }
    }
    for (const forbidden of w.forbids) {
      if (attributes.has(forbidden)) {
        diagnostics.push({
          message: `Attribute "${forbidden}" is not allowed ${describeCondition(w)}`,
          severity: 'warning',
        });
      }
    }
  }

  for (const ex of rules.exclusives) {
    const present = ex.attributes.filter(a => attributes.has(a));
    const count = present.length + (ex.content && hasContent ? 1 : 0);
    if (count <= 1) continue;
    const names = present.map(a => `"${a}"`).join(', ');
    diagnostics.push({
      message: ex.content && hasContent
        ? `<${elementName}> must have either ${names} or element content, not both`
        : `<${elementName}> allows only one of the attributes ${names}`,
      severity: 'warning',
    });
  }

  return diagnostics;
}

/** Attribute declarations minus those forbidden or excluded by the attributes already present. */
export function filterAttributes(
  model: ContentModel,
  elementName: string,
  existingAttributes: Map<string, string>,
  allAttributes: AttributeDeclaration[],
): AttributeDeclaration[] {
  const rules = rulesFor(model, elementName);
  const hidden = new Set<string>();
  for (const w of activeWhens(rules, existingAttributes)) {
    for (const f of w.forbids) hidden.add(f);
  }
  for (const ex of rules.exclusives) {
    if (ex.attributes.some(a => existingAttributes.has(a))) {
      for (const a of ex.attributes) hidden.add(a);
    }
  }
  if (hidden.size === 0) return allAttributes;
  return allAttributes.filter(attr => !hidden.has(attr.name));
}

/** Attributes that become required through the attributes already present. */
export function getRequiredAttributes(
  model: ContentModel,
  elementName: string,
  existingAttributes: Map<string, string>,
): string[] {
  const rules = rulesFor(model, elementName);
  return activeWhens(rules, existingAttributes).flatMap(w => w.requires);
}
