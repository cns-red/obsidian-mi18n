import {
  EditorState,
  Extension,
  StateField,
  StateEffect,
  Transaction,
  Range,
  RangeSet,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  WidgetType,
} from "@codemirror/view";
import { isLanguageBlockClose, langCodeIncludes, matchLanguageBlockOpen } from "./syntax";

export const setActiveLangEffect = StateEffect.define<string>();

export interface LangExtensionConfig {
  getActiveLanguage: () => string;
  getHideMode: () => boolean;
  isInScope: () => boolean;
}

export function buildEditorExtension(config: LangExtensionConfig): Extension[] {
  return [langDecorationsField(config), hideTheme];
}



class HiddenBlockWidget extends WidgetType {
  constructor(private langCode: string, private lineCount: number) {
    super();
  }

  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = "ml-hidden-block-placeholder";
    el.setAttribute("data-lang", this.langCode);
    el.title = `Hidden language block: ${this.langCode}  (${this.lineCount} lines)`;
    return el;
  }

  ignoreEvent(): boolean {
    return false;
  }

  eq(other: HiddenBlockWidget): boolean {
    return other.langCode === this.langCode && other.lineCount === this.lineCount;
  }
}

function langDecorationsField(config: LangExtensionConfig): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create(state: EditorState): DecorationSet {
      return computeDecorations(state, config);
    },
    update(deco: DecorationSet, tr: Transaction): DecorationSet {
      if (tr.docChanged || tr.effects.some((e) => e.is(setActiveLangEffect))) {
        return computeDecorations(tr.state, config);
      }
      return deco.map(tr.changes);
    },
    provide(field) {
      return EditorView.decorations.from(field);
    },
  });
}

function computeDecorations(state: EditorState, config: LangExtensionConfig): DecorationSet {
  if (!config.isInScope()) return Decoration.none;
  const active = config.getActiveLanguage();
  if (!config.getHideMode()) return Decoration.none;

  const decorations: Range<Decoration>[] = [];
  const doc = state.doc;

  let insideBlock = false;
  let blockLang = "";
  let blockStartLine = 0;

  for (let ln = 1; ln <= doc.lines; ln++) {
    const text = doc.line(ln).text;
    if (!insideBlock) {
      const langCode = matchLanguageBlockOpen(text);
      if (langCode !== null) {
        insideBlock = true;
        blockLang = langCode;
        blockStartLine = ln;
      }
    } else if (isLanguageBlockClose(text)) {
      if (active !== "ALL" && !langCodeIncludes(blockLang, active)) {
        applyHideDecorations(decorations, state, blockStartLine, ln, blockLang, ln - blockStartLine + 1);
      }
      insideBlock = false;
      blockLang = "";
      blockStartLine = 0;
    }
  }

  // Handle unclosed block at EOF.
  if (insideBlock && active !== "ALL" && !langCodeIncludes(blockLang, active)) {
    applyHideDecorations(decorations, state, blockStartLine, doc.lines, blockLang, doc.lines - blockStartLine + 1);
  }

  // Decorations are pushed in line order, no sort needed.
  return RangeSet.of(decorations);
}

function applyHideDecorations(
  out: Range<Decoration>[],
  state: EditorState,
  fromLineno: number,
  toLineno: number,
  langCode: string,
  lineCount: number,
): void {
  const fromLine = state.doc.line(fromLineno);
  const toLine = state.doc.line(toLineno);
  out.push(
    Decoration.replace({
      widget: new HiddenBlockWidget(langCode, lineCount),
      block: true,
      inclusive: true,
    }).range(fromLine.from, toLine.to)
  );
}

const hideTheme = EditorView.baseTheme({
  ".ml-hidden-block-placeholder": {
    display: "inline-block",
    height: "2px",
    width: "100%",
    backgroundColor: "var(--background-modifier-border)",
    borderRadius: "2px",
    cursor: "pointer",
    opacity: "0.4",
  },
});
