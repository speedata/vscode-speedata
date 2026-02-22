import { AttributeDeclaration } from './contentModel';

export interface CustomDiagnostic {
  message: string;
  severity: 'error' | 'warning';
}

interface DefineColorRule {
  required: string[];
  forbidden: string[];
}

const defineColorRules: Record<string, DefineColorRule> = {
  cmyk: {
    required: ['c', 'm', 'y', 'k'],
    forbidden: ['r', 'g', 'b', 'value', 'colorname'],
  },
  rgb: {
    required: ['r', 'g', 'b'],
    forbidden: ['c', 'm', 'y', 'k', 'value', 'colorname'],
  },
  RGB: {
    required: ['r', 'g', 'b'],
    forbidden: ['c', 'm', 'y', 'k', 'value', 'colorname'],
  },
  gray: {
    required: ['g'],
    forbidden: ['r', 'b', 'c', 'm', 'y', 'k', 'value', 'colorname'],
  },
  spotcolor: {
    required: ['colorname'],
    forbidden: ['r', 'g', 'b', 'value'],
  },
  '': {
    required: ['value'],
    forbidden: ['r', 'g', 'b', 'c', 'm', 'y', 'k', 'colorname'],
  },
};

export function validateCustomConstraints(
  elementName: string,
  attributes: Map<string, string>,
  hasChildren: boolean,
): CustomDiagnostic[] {
  const diagnostics: CustomDiagnostic[] = [];

  if (elementName === 'DefineColor') {
    validateDefineColor(attributes, diagnostics);
  }

  if (elementName === 'Value') {
    validateValue(attributes, hasChildren, diagnostics);
  }

  return diagnostics;
}

function validateDefineColor(
  attributes: Map<string, string>,
  diagnostics: CustomDiagnostic[],
): void {
  const model = attributes.get('model') ?? '';
  const rule = defineColorRules[model];
  if (!rule) return;

  for (const req of rule.required) {
    if (!attributes.has(req)) {
      diagnostics.push({
        message: `Required attribute "${req}" is missing for model="${model || '(empty)'}"`,
        severity: 'error',
      });
    }
  }

  for (const forbidden of rule.forbidden) {
    if (attributes.has(forbidden)) {
      diagnostics.push({
        message: `Attribute "${forbidden}" is not allowed for model="${model || '(empty)'}"`,
        severity: 'warning',
      });
    }
  }
}

function validateValue(
  attributes: Map<string, string>,
  hasChildren: boolean,
  diagnostics: CustomDiagnostic[],
): void {
  if (attributes.has('select') && hasChildren) {
    diagnostics.push({
      message: 'Value must have either child elements or the select attribute, not both',
      severity: 'warning',
    });
  }
}

export function filterAttributes(
  elementName: string,
  existingAttributes: Map<string, string>,
  allAttributes: AttributeDeclaration[],
): AttributeDeclaration[] {
  if (elementName !== 'DefineColor') return allAttributes;

  const model = existingAttributes.get('model') ?? '';
  const rule = defineColorRules[model];
  if (!rule) return allAttributes;

  const forbiddenSet = new Set(rule.forbidden);
  return allAttributes.filter(attr => !forbiddenSet.has(attr.name));
}

export function getRequiredAttributes(
  elementName: string,
  existingAttributes: Map<string, string>,
): string[] {
  if (elementName !== 'DefineColor') return [];

  const model = existingAttributes.get('model') ?? '';
  const rule = defineColorRules[model];
  if (!rule) return [];

  return rule.required;
}
