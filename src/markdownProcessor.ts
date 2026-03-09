/**
 * markdownProcessor.ts
 *
 * Reading-mode post-processor for the Multilingual Notes plugin.
 *
 * Root cause of the "everything renders" bug:
 *   Obsidian calls registerMarkdownPostProcessor() ONCE PER RENDERED ELEMENT
 *   (paragraph, heading, list, …), NOT for the whole document at once.
 *   The old approach of walking el.childNodes to find open/close pairs
 *   therefore never worked — each `el` is just one paragraph.
 *
 * Fix:
 *   Use ctx.getSectionInfo(el) which returns:
 *     • text       – the FULL raw source of the note
 *     • lineStart  – 0-based first source line of this rendered element
 *     • lineEnd    – 0-based last  source line of this rendered element
 *   We parse the full source once (cached) to locate all lang blocks,
 *   then for each element decide: hide, show, or replace with badge.
 *
 * Supported syntax (all equivalent):
 *   :::lang zh-cn          …  :::
 *   {% i8n zh-cn %}        …  {% endi8n %}
 *   [//]: # (:::lang zh-cn)…  [//]: # (:::)
 *   %% :::lang zh-cn %%   …  %% ::: %%
 *
 * Feature — no-marker fallback:
 *   If a note contains NONE of the above markers it is treated as being
 *   written entirely in the plugin's configured "default language".
 *   Switching to a different language makes the whole note invisible.
 */

import { MarkdownPostProcessorContext } from "obsidian";
import type MultilingualNotesPlugin from "../main";

// ── Syntax patterns ──────────────────────────────────────────────────────────

interface SyntaxPattern {
  re: RegExp;
  /**
   * True  → the marker line renders as visible text in Obsidian reading mode
   *         (e.g. :::lang en  or  {% i8n en %}).
   *         We must explicitly hide it.
   * False → the marker is already invisible (Obsidian comment / link-ref hack).
   *         No action needed.
   */
  visible: boolean;
}

/**
 * Capture groups are unified into one or multiple language codes,
 * separated by spaces, such as "zh-CN" or "zh-CN en"
 */
const LANG_CODE_PART = `([\\w-]+(?:\\s+[\\w-]+)*)`;

/** Open-block markers. Capture group 1 = language code. */
const OPEN_PATTERNS: RegExp[] = [
  // :::lang zh-CN  或  :::lang zh-CN en
  new RegExp(`^:::lang\\s+${LANG_CODE_PART}\\s*$`),
  // {% i8n zh-CN %}  或  {% i8n zh-CN en %}
  new RegExp(`^\\{%\\s*i8n\\s+${LANG_CODE_PART}\\s*%\\}\\s*$`),
  // [//]: # (lang zh-CN)  或  [//]: # (lang zh-CN en)
  new RegExp(`^\\[//\\]:\\s*#\\s*\\(lang\\s+${LANG_CODE_PART}\\)\\s*$`),
  // %% lang zh-CN %%  或  %% lang zh-CN en %%
  new RegExp(`^%%\\s+lang\\s+${LANG_CODE_PART}\\s+%%\\s*$`),
];

/** Close-block markers. */
const CLOSE_PATTERNS: RegExp[] = [
  /^:::\s*$/,                             // :::
  /^\{%\s*endlang\s*%\}\s*$/,            // {% endlang %}
  /^\[\/\/\]:\s*#\s*\(\s*endlang\s*\)\s*$/, // [//]: # (endlang)
  /^%%\s+endlang\s+%%\s*$/,              // %% endlang %%
];

// ── Internal data ────────────────────────────────────────────────────────────

export interface LangBlock {
  langCode: string;
  /** 0-based line number of the open marker in the source. */
  openLine: number;
  /** Whether the open marker renders visibly. */
  openVisible: boolean;
  /** 0-based line number of the close marker (-1 if the block is never closed). */
  closeLine: number;
  /** Whether the close marker renders visibly. */
  closeVisible: boolean;
}

// ── Cache ─────────────────────────────────────────────────────────────────────

/**
 * Maps  "sourcePath|sourceLength"  →  parsed blocks for that note.
 * Using source length as a cheap change-detector.
 * Also cleared whenever the user switches language.
 */
const blockCache = new Map<string, LangBlock[]>();

/** Called from main.ts whenever the active language changes. */
export function clearBlockCache(): void {
  blockCache.clear();
}

// ── Language code helpers ─────────────────────────────────────────────────────

/**
 * Case-insensitive comparison for language codes.
 * "zh-CN", "zh-cn", "ZH-CN" all match each other.
 * "zh-CN en" space style supports multiple languages, indicating that all multi-language versions are rendered from it.
 * This is critical: notes may use :::lang zh-cn while settings store "zh-CN".
 */
export function langMatch(blockLang: string, active: string): boolean {
  if (active === "ALL") return true;
  return blockLang.split(/\s+/).some(code => code === active);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function matchOpen(line: string): string | null {
  for (const re of OPEN_PATTERNS) {
    const m = re.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

function matchClose(line: string): boolean {
  return CLOSE_PATTERNS.some(re => re.test(line));
}

export function parseLangBlocks(source: string): LangBlock[] {
  const lines = source.split("\n");
  const blocks: LangBlock[] = [];
  let openBlock: { langCode: string; openLine: number } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (openBlock === null) {
      const code = matchOpen(line);
      if (code !== null) {
        openBlock = { langCode: code, openLine: i };
      }
    } else {
      if (matchClose(line)) {
        blocks.push({
          langCode: openBlock.langCode,
          openLine: openBlock.openLine,
          closeLine: i,
          openVisible: true,
          closeVisible: true,
        });
        openBlock = null;
      }
    }
  }

  if (openBlock) {
    blocks.push({
      langCode: openBlock.langCode,
      openLine: openBlock.openLine,
      openVisible: true,
      closeVisible: true,
      closeLine: -1,
    });
  }

  return blocks;
}

// ── Post-processor ────────────────────────────────────────────────────────────

export function registerReadingModeProcessor(plugin: MultilingualNotesPlugin): void {
  plugin.registerMarkdownPostProcessor(
    (el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      // getSectionInfo returns the FULL note source plus the line range of
      // this specific rendered element.
      const info = ctx.getSectionInfo(el);
      if (!info) return; // Can't determine position → leave untouched.

      const { text: source, lineStart, lineEnd } = info;
      const active      = plugin.settings.activeLanguage;
      const defaultLang = plugin.settings.defaultLanguage;
      const showBadges  = plugin.settings.showLangBadges;

      // Parse (cached) all lang blocks from the full source.
      const cacheKey = `${ctx.sourcePath}|${source.length}`;
      let blocks = blockCache.get(cacheKey);
      if (!blocks) {
        blocks = parseLangBlocks(source);
        blockCache.set(cacheKey, blocks);
      }

      // ── Feature 3: no markers → whole note is the default language ─────────
      if (blocks.length === 0) {
        if (active !== "ALL" && !langMatch(active, defaultLang)) {
          el.style.display = "none";
        } else {
          // Reset stale display:none from a previous language/mode state.
          el.style.display = "";
        }
        return;
      }

      // ── Find which block (if any) this element belongs to ─────────────────
      for (const block of blocks) {

        // ① This element IS the open-fence line.
        if (lineStart === block.openLine) {
          if (!block.openVisible) return; // already hidden by Obsidian

          const isActive = active === "ALL" || langMatch(block.langCode, active);

          // When there is no blank line after the marker Obsidian's markdown
          // parser merges the fence line with the following content lines into
          // a single paragraph element (lineEnd > openLine).  In that case we
          // must NOT clear innerHTML — doing so would eat the content.  Just
          // show or hide the whole element based on active status.
          if (lineEnd > block.openLine) {
            el.style.display = isActive ? "" : "none";
            return;
          }

          // Normal case: single-line fence element.
          if (!isActive) {
            el.style.display = "none";
          } else if (showBadges) {
            // Reset stale display:none, then replace raw fence with a badge.
            el.style.display = "";
            el.innerHTML = "";
            el.appendChild(createBadge(block.langCode, plugin));
          } else {
            el.style.display = "none"; // hide raw fence syntax even when active
          }
          return;
        }

        // ② This element IS the close-fence line.
        if (block.closeLine >= 0 && lineStart === block.closeLine) {
          if (block.closeVisible) el.style.display = "none";
          return;
        }

        // ③ This element is INSIDE the block (between open and close).
        const afterOpen   = lineStart > block.openLine;
        const beforeClose = block.closeLine < 0 || lineStart < block.closeLine;
        if (afterOpen && beforeClose) {
          const isActive = active === "ALL" || langMatch(block.langCode, active);
          if (!isActive) {
            el.style.display = "none";
          } else {
            el.style.display = "";

            if (block.closeLine >= 0 && lineEnd >= block.closeLine) {
              removeCloseMarkerFromElement(el);
            }
          }
          return;
        }
      }

      // Element is outside every block — ensure it is visible.
      el.style.display = "";
    },
    // Priority 100 — run after most other processors.
    100
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * 从已渲染的 HTMLElement 里剥离闭标记文本。
 * 兼容 p / blockquote / h1-h6 / li / td 等所有块级元素。
 */
function removeCloseMarkerFromElement(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const toRemove: Node[] = [];

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? "";
    if (matchClose(text)) {
      toRemove.push(node);
    }
  }

  for (const node of toRemove) {
    const parent = node.parentElement;
    if (!parent) continue;

    const siblings = Array.from(parent.childNodes).filter(
        n => n !== node && n.textContent?.trim() !== ""
    );
    if (siblings.length === 0) {
      parent.style.display = "none";
    } else {
      node.parentNode?.removeChild(node);
    }
  }

  // 如果整个 el 现在是空的，也隐藏它
  if (el.textContent?.trim() === "") {
    el.style.display = "none";
  }
}


function createBadge(langCode: string, plugin: MultilingualNotesPlugin): HTMLElement {
  // Case-insensitive lookup so "zh-cn" finds the entry stored as "zh-CN"
  const lang  = plugin.settings.languages.find((l) => langMatch(l.code, langCode));
  const label = lang ? lang.label : langCode;
  const badge = document.createElement("span");
  badge.className = "ml-lang-badge";
  badge.textContent = label;
  badge.setAttribute("data-lang", langCode);
  return badge;
}

// Export regex utilities so editorExtension can reuse them.
export { matchOpen, matchClose };
