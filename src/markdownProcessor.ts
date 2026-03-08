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

/** Open-block markers. Capture group 1 = language code. */
const OPEN_PATTERNS: SyntaxPattern[] = [
  // :::lang zh-cn  (default, native Obsidian/Markdown fenced-div style)
  { re: /^:::lang\s+(\S+)\s*$/, visible: true },
  // {% i8n zh-cn %}  (Hexo-style, case-insensitive)
  { re: /^\{%-?\s*i8n\s+(\S+)\s*-?%\}$/i, visible: true },
  // [//]: # (lang zh-cn)  — Markdown comment hack, already invisible
  { re: /^\[\/\/\]:\s*#\s*\(lang\s+(\S+)[^)]*\)/i, visible: false },
  // %% lang zh-cn %%  — Obsidian comment, already invisible
  { re: /^%%\s*lang\s+(\S+)\s*%%$/, visible: false },
];

/** Close-block markers. */
const CLOSE_PATTERNS: SyntaxPattern[] = [
  // :::
  { re: /^:::\s*$/, visible: true },
  // {% endi8n %}
  { re: /^\{%-?\s*endi8n\s*-?%\}$/i, visible: true },
  // [//]: # (:::)
  { re: /^\[\/\/\]:\s*#\s*\(:::\s*\)$/i, visible: false },
  // %% ::: %%
  { re: /^%%\s*:::\s*%%$/, visible: false },
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
 * This is critical: notes may use :::lang zh-cn while settings store "zh-CN".
 */
export function langMatch(noteCode: string, activeCode: string): boolean {
  return noteCode.toLowerCase() === activeCode.toLowerCase();
}

// ── Parsing ───────────────────────────────────────────────────────────────────

function tryMatchOpen(line: string): { langCode: string; visible: boolean } | null {
  const t = line.trim();
  for (const pat of OPEN_PATTERNS) {
    const m = t.match(pat.re);
    if (m) return { langCode: m[1], visible: pat.visible };
  }
  return null;
}

function tryMatchClose(line: string): { visible: boolean } | null {
  const trimmed = line.trim();
  for (const pat of CLOSE_PATTERNS) {
    if (pat.re.test(trimmed)) return { visible: pat.visible };
  }
  return null;
}

export function parseLangBlocks(source: string): LangBlock[] {
  const lines = source.split("\n");
  const blocks: LangBlock[] = [];
  let i = 0;

  while (i < lines.length) {
    const openResult = tryMatchOpen(lines[i]);
    if (openResult) {
      const openLine = i;
      const { langCode, visible: openVisible } = openResult;
      let closeLine = -1;
      let closeVisible = false;

      // Scan forward for the matching close marker.
      for (let j = i + 1; j < lines.length; j++) {
        const closeResult = tryMatchClose(lines[j]);
        if (closeResult) {
          closeLine = j;
          closeVisible = closeResult.visible;
          i = j; // continue outer loop after the close marker
          break;
        }
      }

      blocks.push({ langCode, openLine, openVisible, closeLine, closeVisible });
    }
    i++;
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
            // Reset stale display:none left by a previous render pass.
            el.style.display = "";
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
export { tryMatchOpen, tryMatchClose };
