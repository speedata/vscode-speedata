import * as sax from 'sax';
import { ContentModel, ElementDeclaration, AttributeDeclaration } from './contentModel';

interface DefineBlock {
  name: string;
  elementName: string;
  documentation: string;
  attributes: AttributeDeclaration[];
  childRefs: string[];
  allowsText: boolean;
}

interface ParseState {
  defines: Map<string, DefineBlock>;
  startRef: string;
  namespace: string;
  // Parser state stack
  stack: StackFrame[];
  currentDefine: DefineBlock | null;
  currentAttribute: Partial<AttributeDeclaration> | null;
  currentValues: { value: string; documentation?: string }[];
  // Track if currently inside optional/zeroOrMore (attribute becomes not required)
  optionalDepth: number;
  // Text accumulation
  textBuffer: string;
  capturingText: string | null; // 'documentation' | 'value' | null
}

interface StackFrame {
  tag: string;
  attrs: Record<string, string>;
}

export function parseRng(content: string): ContentModel {
  const state: ParseState = {
    defines: new Map(),
    startRef: '',
    namespace: '',
    stack: [],
    currentDefine: null,
    currentAttribute: null,
    currentValues: [],
    optionalDepth: 0,
    textBuffer: '',
    capturingText: null,
  };

  const parser = sax.parser(true, { trim: false });

  parser.onopentag = (node) => {
    const tag = localName(node.name);
    const attrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(node.attributes)) {
      attrs[k as string] = v as string;
    }
    state.stack.push({ tag, attrs });

    switch (tag) {
      case 'grammar':
        if (attrs['ns']) {
          state.namespace = attrs['ns'];
        }
        break;

      case 'define':
        state.currentDefine = {
          name: attrs['name'] || '',
          elementName: '',
          documentation: '',
          attributes: [],
          childRefs: [],
          allowsText: false,
        };
        break;

      case 'start':
        // Will capture ref inside
        break;

      case 'element':
        if (state.currentDefine && !state.currentDefine.elementName) {
          state.currentDefine.elementName = attrs['name'] || '';
        }
        break;

      case 'attribute':
        state.currentAttribute = {
          name: attrs['name'] || '',
          documentation: '',
          required: state.optionalDepth === 0,
          values: undefined,
          pattern: undefined,
        };
        state.currentValues = [];
        break;

      case 'ref': {
        if (state.currentDefine) {
          state.currentDefine.childRefs.push(attrs['name'] || '');
        }
        // Check if we're inside <start>
        const inStart = state.stack.some((f) => f.tag === 'start');
        if (inStart && !state.currentDefine) {
          state.startRef = attrs['name'] || '';
        }
        break;
      }

      case 'optional':
      case 'zeroOrMore':
        state.optionalDepth++;
        break;

      case 'oneOrMore':
        // children are still required (at least once), don't change optionalDepth
        break;

      case 'text':
        if (state.currentDefine) {
          state.currentDefine.allowsText = true;
        }
        break;

      case 'documentation':
        state.capturingText = 'documentation';
        state.textBuffer = '';
        break;

      case 'value':
        state.capturingText = 'value';
        state.textBuffer = '';
        break;

      case 'param':
        if (attrs['name'] === 'pattern') {
          state.capturingText = 'pattern';
          state.textBuffer = '';
        }
        break;
    }
  };

  parser.ontext = (text) => {
    if (state.capturingText) {
      state.textBuffer += text;
    }
  };

  parser.oncdata = (cdata) => {
    if (state.capturingText) {
      state.textBuffer += cdata;
    }
  };

  parser.onclosetag = (name) => {
    const tag = localName(name);
    state.stack.pop();

    switch (tag) {
      case 'define':
        if (state.currentDefine) {
          state.defines.set(state.currentDefine.name, state.currentDefine);
          state.currentDefine = null;
        }
        break;

      case 'attribute':
        if (state.currentAttribute && state.currentDefine) {
          if (state.currentValues.length > 0) {
            state.currentAttribute.values = [...state.currentValues];
          }
          state.currentDefine.attributes.push(state.currentAttribute as AttributeDeclaration);
          state.currentAttribute = null;
          state.currentValues = [];
        }
        break;

      case 'optional':
      case 'zeroOrMore':
        state.optionalDepth--;
        break;

      case 'documentation': {
        const docText = state.textBuffer.trim();
        state.capturingText = null;
        state.textBuffer = '';

        // In the speedata schema, <a:documentation> FOLLOWS the <value> it describes:
        //   <value>L</value>
        //   <a:documentation>Description of L</a:documentation>
        // So if we already have values collected, assign to the last one.
        if (state.currentAttribute && state.currentValues.length > 0) {
          const lastVal = state.currentValues[state.currentValues.length - 1];
          if (!lastVal.documentation) {
            lastVal.documentation = docText;
          }
        } else if (state.currentAttribute) {
          if (!state.currentAttribute.documentation) {
            state.currentAttribute.documentation = docText;
          }
        } else if (state.currentDefine) {
          if (!state.currentDefine.documentation) {
            state.currentDefine.documentation = docText;
          }
        }
        break;
      }

      case 'value': {
        const val = state.textBuffer.trim();
        state.capturingText = null;
        state.textBuffer = '';
        state.currentValues.push({ value: val });
        break;
      }

      case 'param':
        if (state.capturingText === 'pattern') {
          const pattern = state.textBuffer.trim();
          if (state.currentAttribute) {
            state.currentAttribute.pattern = pattern;
          }
          state.capturingText = null;
          state.textBuffer = '';
        }
        break;
    }
  };

  parser.onerror = (err) => {
    // Continue parsing on error
    parser.resume();
  };

  parser.write(content).close();

  // Build ContentModel by resolving references
  return buildContentModel(state);
}

function buildContentModel(state: ParseState): ContentModel {
  const elements = new Map<string, ElementDeclaration>();

  for (const [, define] of state.defines) {
    if (!define.elementName) continue;

    const allowedChildren: string[] = [];
    for (const ref of define.childRefs) {
      const target = state.defines.get(ref);
      if (target && target.elementName) {
        allowedChildren.push(target.elementName);
      }
    }

    elements.set(define.elementName, {
      name: define.elementName,
      documentation: define.documentation,
      attributes: define.attributes,
      allowedChildren: [...new Set(allowedChildren)],
      allowsText: define.allowsText,
    });
  }

  return {
    elements,
    namespace: state.namespace,
  };
}

function localName(name: string): string {
  const idx = name.indexOf(':');
  return idx >= 0 ? name.substring(idx + 1) : name;
}
