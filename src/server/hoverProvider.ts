import { Hover, MarkupKind } from 'vscode-languageserver/node';
import { CursorContext } from './xmlDocumentAnalyzer';
import { ContentModel } from './contentModel';

export function getHover(context: CursorContext, model: ContentModel): Hover | null {
  if (context.type === 'elementHover' || context.type === 'content') {
    return getElementHover(context.currentElement, model);
  }

  if (context.type === 'attributeHover' || context.type === 'attributeValue') {
    if (context.attributeName) {
      return getAttributeHover(context.currentElement, context.attributeName, model);
    }
  }

  return null;
}

function getElementHover(elementName: string, model: ContentModel): Hover | null {
  const decl = model.elements.get(elementName);
  if (!decl) return null;

  const lines: string[] = [];
  lines.push(`**\`<${decl.name}>\`**`);
  if (decl.documentation) {
    lines.push('', decl.documentation);
  }

  if (decl.allowedChildren.length > 0) {
    lines.push('', '**Allowed child elements:** ' + decl.allowedChildren.map(c => `\`${c}\``).join(', '));
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: lines.join('\n'),
    },
  };
}

function getAttributeHover(elementName: string, attrName: string, model: ContentModel): Hover | null {
  const decl = model.elements.get(elementName);
  if (!decl) return null;

  const attr = decl.attributes.find(a => a.name === attrName);
  if (!attr) return null;

  const lines: string[] = [];
  lines.push(`**\`${attr.name}\`** (attribute of \`<${elementName}>\`)`);
  if (attr.documentation) {
    lines.push('', attr.documentation);
  }
  if (attr.required) {
    lines.push('', '*Required*');
  }
  if (attr.values && attr.values.length > 0) {
    lines.push('', '**Allowed values:**');
    for (const v of attr.values) {
      if (v.documentation) {
        lines.push(`- \`${v.value}\` — ${v.documentation}`);
      } else {
        lines.push(`- \`${v.value}\``);
      }
    }
  }
  if (attr.pattern) {
    lines.push('', `**Pattern:** \`${attr.pattern}\``);
  }

  return {
    contents: {
      kind: MarkupKind.Markdown,
      value: lines.join('\n'),
    },
  };
}
