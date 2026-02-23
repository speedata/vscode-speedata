import { Command, CompletionItem, CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import { CursorContext } from './xmlDocumentAnalyzer';
import { ContentModel } from './contentModel';
import { filterAttributes, getRequiredAttributes } from './customConstraints';

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

  const items: CompletionItem[] = candidates.map((childName, index) => {
    const childDecl = model.elements.get(childName);
    const item: CompletionItem = {
      label: childName,
      kind: CompletionItemKind.Class,
      sortText: String(index).padStart(4, '0'),
    };

    if (childDecl?.documentation) {
      item.documentation = { kind: MarkupKind.Markdown, value: childDecl.documentation };
    }

    // Snippet: <Element attribute="value">$0</Element> or <Element />
    if (childDecl) {
      const prefix = context.type === 'content' ? '<' : '';
      const requiredAttrs = childDecl.attributes.filter(a => a.required);
      let snippet = prefix + childName;
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

  const prefix = context.type === 'content' ? '<' : '';
  items.push({
    label: '![CDATA[',
    kind: CompletionItemKind.Class,
    sortText: 'zzzz1',
    detail: 'CDATA section',
    insertText: prefix + '![CDATA[$1]]>',
    insertTextFormat: InsertTextFormat.Snippet,
  });

  items.push({
    label: '!-- -->',
    kind: CompletionItemKind.Class,
    sortText: 'zzzz2',
    detail: 'Comment',
    insertText: prefix + '!-- $1 -->',
    insertTextFormat: InsertTextFormat.Snippet,
  });

  return items;
}

function getAttributeCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  const decl = model.elements.get(context.currentElement);
  if (!decl) return [];

  const existingMap = context.existingAttributes ?? new Map<string, string>();
  const existingNames = new Set(existingMap.keys());

  // Apply custom constraint filtering (e.g. DefineColor model-dependent attributes)
  const filtered = filterAttributes(context.currentElement, existingMap, decl.attributes);
  const customRequired = new Set(getRequiredAttributes(context.currentElement, existingMap));

  return filtered
    .filter(attr => !existingNames.has(attr.name))
    .map((attr, index) => {
      const isRequired = attr.required || customRequired.has(attr.name);
      const item: CompletionItem = {
        label: attr.name,
        kind: CompletionItemKind.Property,
        sortText: (isRequired ? '0' : '1') + String(index).padStart(4, '0'),
      };

      if (attr.documentation) {
        item.documentation = { kind: MarkupKind.Markdown, value: attr.documentation };
      }

      if (isRequired) {
        item.detail = '(required)';
      }

      // Snippet with value placeholder
      item.insertText = `${attr.name}="\$1"`;
      item.insertTextFormat = InsertTextFormat.Snippet;
      if (attr.values && attr.values.length > 0) {
        // Trigger suggest after inserting so value completions with documentation appear
        item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
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
      item.labelDetails = { description: v.documentation };
    }
    return item;
  });
}
