import { CompletionItem, CompletionItemKind, InsertTextFormat } from 'vscode-languageserver/node';
import { CursorContext } from './xmlDocumentAnalyzer';
import { ContentModel } from './contentModel';

export function getCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  switch (context.type) {
    case 'elementOpen':
    case 'content':
      return getElementCompletions(context, model);
    case 'attributeName':
      return getAttributeCompletions(context, model);
    case 'attributeValue':
      return getAttributeValueCompletions(context, model);
    default:
      return [];
  }
}

function getElementCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  const parentElement = context.currentElement;
  const parentDecl = model.elements.get(parentElement);

  // If we have a parent, offer its allowed children; otherwise offer all root elements
  const candidates = parentDecl
    ? parentDecl.allowedChildren
    : [...model.elements.keys()];

  return candidates.map((childName, index) => {
    const childDecl = model.elements.get(childName);
    const item: CompletionItem = {
      label: childName,
      kind: CompletionItemKind.Class,
      sortText: String(index).padStart(4, '0'),
    };

    if (childDecl?.documentation) {
      item.documentation = childDecl.documentation;
    }

    // Snippet: <Element attribute="value">$0</Element> or <Element />
    if (childDecl) {
      const requiredAttrs = childDecl.attributes.filter(a => a.required);
      let snippet = childName;
      let tabStop = 1;
      for (const attr of requiredAttrs) {
        snippet += ` ${attr.name}="\${${tabStop}:}"`;
        tabStop++;
      }
      if (childDecl.allowedChildren.length > 0 || childDecl.allowsText) {
        snippet += `>\${${tabStop}}</${childName}>`;
      } else {
        snippet += ` />`;
      }
      item.insertText = snippet;
      item.insertTextFormat = InsertTextFormat.Snippet;
    }

    return item;
  });
}

function getAttributeCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  const decl = model.elements.get(context.currentElement);
  if (!decl) return [];

  const existing = new Set(context.existingAttributes || []);

  return decl.attributes
    .filter(attr => !existing.has(attr.name))
    .map((attr, index) => {
      const item: CompletionItem = {
        label: attr.name,
        kind: CompletionItemKind.Property,
        sortText: (attr.required ? '0' : '1') + String(index).padStart(4, '0'),
      };

      if (attr.documentation) {
        item.documentation = attr.documentation;
      }

      if (attr.required) {
        item.detail = '(required)';
      }

      // Snippet with value placeholder
      if (attr.values && attr.values.length > 0) {
        const choices = attr.values.map(v => v.value).join(',');
        item.insertText = `${attr.name}="\${1|${choices}|}"`;
        item.insertTextFormat = InsertTextFormat.Snippet;
      } else {
        item.insertText = `${attr.name}="\$1"`;
        item.insertTextFormat = InsertTextFormat.Snippet;
      }

      return item;
    });
}

function getAttributeValueCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  if (!context.attributeName) return [];

  const decl = model.elements.get(context.currentElement);
  if (!decl) return [];

  const attr = decl.attributes.find(a => a.name === context.attributeName);
  if (!attr?.values) return [];

  return attr.values.map((v, index) => {
    const item: CompletionItem = {
      label: v.value,
      kind: CompletionItemKind.EnumMember,
      sortText: String(index).padStart(4, '0'),
    };
    if (v.documentation) {
      item.documentation = v.documentation;
    }
    return item;
  });
}
