import { Command, CompletionItem, CompletionItemKind, InsertTextFormat, MarkupKind } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { CursorContext } from './xmlDocumentAnalyzer';
import { ContentModel } from './contentModel';
import { filterAttributes, getRequiredAttributes } from './customConstraints';
import { getCrossReferenceCompletions, hasCrossReferenceTargets } from './crossReferenceProvider';

export function getCompletions(context: CursorContext, model: ContentModel, doc?: TextDocument): CompletionItem[] {
  switch (context.type) {
    case 'elementOpen':
    case 'content':
      return getElementCompletions(context, model);
    case 'elementHover':
      // Cursor is on a partially typed element name (e.g. <Op|).
      // Use the parent element from the stack for allowed-children lookup.
      return getElementCompletions({
        ...context,
        type: 'elementOpen',
        currentElement: context.elementStack.length > 0
          ? context.elementStack[context.elementStack.length - 1]
          : '',
      }, model);
    case 'attributeName':
      return getAttributeCompletions(context, model);
    case 'attributeValue':
      return getAttributeValueCompletions(context, model, doc);
    default:
      return [];
  }
}

function getElementCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  const parentElement = context.currentElement;
  // Resolve declarations from both the speedata elements and the inline HTML
  // elements, so completion works inside <HTML> and its descendants too.
  const lookup = (name: string) => model.elements.get(name) ?? model.htmlElements.get(name);
  const parentDecl = lookup(parentElement);

  // If we have a parent, offer its allowed children; otherwise offer all root elements
  const candidates = parentDecl
    ? parentDecl.allowedChildren
    : [...model.elements.keys()];

  const items: CompletionItem[] = candidates.map((childName, index) => {
    const childDecl = lookup(childName);
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
        snippet += ` \${${tabStop}} />`;
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
    sortText: 'zzzz2',
    detail: 'CDATA section',
    insertText: prefix + '![CDATA[$1]]>',
    insertTextFormat: InsertTextFormat.Snippet,
  });

  items.push({
    label: '!-- -->',
    kind: CompletionItemKind.Class,
    sortText: 'zzzz1',
    detail: 'Comment',
    insertText: prefix + '!-- $1 -->',
    insertTextFormat: InsertTextFormat.Snippet,
  });

  return items;
}

function getAttributeCompletions(context: CursorContext, model: ContentModel): CompletionItem[] {
  const decl = model.elements.get(context.currentElement) ?? model.htmlElements.get(context.currentElement);
  if (!decl) return [];

  const existingMap = context.existingAttributes ?? new Map<string, string>();
  const existingNames = new Set(existingMap.keys());

  // Apply custom constraint filtering (e.g. DefineColor model-dependent attributes)
  const filtered = filterAttributes(model, context.currentElement, existingMap, decl.attributes);
  const customRequired = new Set(getRequiredAttributes(model, context.currentElement, existingMap));

  const items = filtered
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
      if ((attr.values && attr.values.length > 0) || hasCrossReferenceTargets(model, context.currentElement, attr.name)) {
        // Trigger suggest after inserting so value completions with documentation appear
        item.command = { title: 'Suggest', command: 'editor.action.triggerSuggest' };
      }

      return item;
    });

  // Offer xmlns: namespace prefix completions from the schema's <lsp:namespace> hints.
  for (const ns of model.namespaces) {
    const prefix = `xmlns:${ns.prefix}`;
    if (!existingNames.has(prefix)) {
      items.push({
        label: prefix,
        kind: CompletionItemKind.Property,
        sortText: '2' + prefix,
        detail: ns.uri,
        insertText: `${prefix}="${ns.uri}"`,
        insertTextFormat: InsertTextFormat.PlainText,
      });
    }
  }

  return items;
}

function getAttributeValueCompletions(context: CursorContext, model: ContentModel, doc?: TextDocument): CompletionItem[] {
  if (!context.attributeName) return [];

  const decl = model.elements.get(context.currentElement) ?? model.htmlElements.get(context.currentElement);
  const attr = decl?.attributes.find(a => a.name === context.attributeName);

  const items: CompletionItem[] = [];
  const schemaValues = new Set<string>();

  if (attr?.values) {
    for (let index = 0; index < attr.values.length; index++) {
      const v = attr.values[index];
      schemaValues.add(v.value);
      const item: CompletionItem = {
        label: v.value,
        kind: CompletionItemKind.EnumMember,
        sortText: String(index).padStart(4, '0'),
      };
      if (v.documentation) {
        item.labelDetails = { description: v.documentation };
      }
      items.push(item);
    }
  }

  if (doc) {
    const crossRefItems = getCrossReferenceCompletions(
      model,
      context.currentElement,
      context.attributeName,
      doc,
      context.attributeValuePrefix ?? '',
      context.offset,
    );
    for (const crItem of crossRefItems) {
      if (!schemaValues.has(crItem.label as string)) {
        items.push(crItem);
      }
    }
  }

  return items;
}
