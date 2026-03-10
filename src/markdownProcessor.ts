/**
 * Reading-mode post-processor.
 *
 * Obsidian invokes post-processors per rendered element, not once per file.
 * We therefore parse the full source via ctx.getSectionInfo(el) and decide
 * per element whether to show or hide it for the active language.
 */


import { MarkdownPostProcessorContext, MarkdownRenderChild, WorkspaceLeaf } from "obsidian";
import type MultilingualNotesPlugin from "../main";
import { isLanguageBlockClose, langCodeIncludes, matchLanguageBlockOpen } from "./syntax";

// ── Marker parsing uses shared helpers in src/syntax.ts ────────────────

// ── Ultra-fast Global Polling Queue for Detached DOM Fragments ─────────
// Obsidian's virtual scroller generates detached HTML elements and aggressively
// fires `onload` lifecycles on them BEFORE they are physically mounted to `document.body`.
// This asynchronous queue safely parks them and evaluates them the exact nanosecond
// they enter the real DOM, guaranteeing they fetch their language from their true parent Leaf.
const pendingMountElements = new Set<{ el: HTMLElement, evaluate: () => void }>();
let isMountPolling = false;

function pollPendingMounts() {
  if (pendingMountElements.size === 0) {
    isMountPolling = false;
    return;
  }
  for (const item of pendingMountElements) {
    if (document.body.contains(item.el)) {
      item.evaluate();
      pendingMountElements.delete(item);
    }
  }
  requestAnimationFrame(pollPendingMounts);
}

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

  // Exact character offsets for text injection/extraction:
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

function isVisibleMarkerLine(line: string): boolean {
  const text = line.trim();
  // Obsidian comment and markdown link-reference hacks are not rendered.
  if (/^\[\/\/\]:\s*#\s*\(/.test(text)) return false;
  if (/^%%.*%%$/.test(text)) return false;
  return true;
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

/** 
 * Fast string hash to definitively distinguish different documents/embeds 
 * containing identical total text lengths.
 */
function quickHash(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = Math.imul(31, hash) + str.charCodeAt(i) | 0;
  }
  return hash;
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
  return langCodeIncludes(blockLang, active);
}

// ── Parsing ───────────────────────────────────────────────────────────────────

export function parseLangBlocks(source: string): LangBlock[] {
  const lines = source.split("\n");
  const blocks: LangBlock[] = [];
  let openBlock: { langCode: string; openLine: number; start: number; innerStart: number } | null = null;

  let currentOffset = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineLengthWithNewline = line.length + (i < lines.length - 1 ? 1 : 0);

    if (openBlock === null) {
      const code = matchLanguageBlockOpen(line);
      if (code !== null) {
        openBlock = {
          langCode: code,
          openLine: i,
          start: currentOffset,
          innerStart: currentOffset + lineLengthWithNewline
        };
      }
    } else {
      if (isLanguageBlockClose(line)) {
        blocks.push({
          langCode: openBlock.langCode,
          openLine: openBlock.openLine,
          closeLine: i,
          openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
          closeVisible: isVisibleMarkerLine(line),
          start: openBlock.start,
          innerStart: openBlock.innerStart,
          innerEnd: currentOffset,
          end: currentOffset + lineLengthWithNewline
        });
        openBlock = null;
      }
    }
    currentOffset += lineLengthWithNewline;
  }

  if (openBlock) {
    blocks.push({
      langCode: openBlock.langCode,
      openLine: openBlock.openLine,
      openVisible: isVisibleMarkerLine(lines[openBlock.openLine]),
      closeVisible: true,
      closeLine: -1,
      start: openBlock.start,
      innerStart: openBlock.innerStart,
      innerEnd: source.length,
      end: source.length
    });
  }

  return blocks;
}

export function extractAvailableLanguagesFromBlocks(blocks: LangBlock[], configuredLanguages: { code: string }[]): Set<string> {
  const existing = new Set<string>();
  let hasAll = false;
  for (const block of blocks) {
    block.langCode.split(/\s+/).filter(Boolean).forEach((c) => {
      const lower = c.toLowerCase();
      if (lower === "all") hasAll = true;
      else existing.add(lower);
    });
  }
  if (hasAll) {
    configuredLanguages.forEach((l) => existing.add(l.code.toLowerCase()));
  }
  return existing;
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
      const initialActive = plugin.getLanguageForElement(el, ctx.sourcePath);
      const defaultLang = plugin.settings.defaultLanguage;
      const showLangHeader = plugin.settings.showLangHeader;

      // Parse (cached) all lang blocks from the full source.
      // Important: Different sections can have identical lengths, so source-length-only
      // keys will collide in transclusions. Using a hash guarantees uniqueness and prevents
      // O(n^2) re-parsing of huge documents per chunk.
      const cacheKey = `${ctx.sourcePath}|${quickHash(source)}`;
      const blocks = blockCache.get(cacheKey) || (() => {
        const parsed = parseLangBlocks(source);
        blockCache.set(cacheKey, parsed);
        return parsed;
      })();

      // Wrap evaluation logic in a reusable closure so it can be re-run firmly
      // once Obsidian attaches the detached DOM fragment to the correct leaf pane.
      let evaluateVisibility = (active: string) => {
        el.classList.remove("ml-language-hidden");
      };

      if (blocks.length === 0) {
        evaluateVisibility = (active: string) => {
          if (active !== "ALL" && !langMatch(active, defaultLang)) {
            el.classList.add("ml-language-hidden");
          } else {
            el.classList.remove("ml-language-hidden");
          }
        };
      } else {
        let foundBlock = false;
        for (const block of blocks) {
          if (lineStart === block.openLine) {
            evaluateVisibility = (active: string) => {
              if (!block.openVisible) return;
              const isActive = active === "ALL" || langMatch(block.langCode, active);
              if (lineEnd > block.openLine) {
                if (isActive) el.classList.remove("ml-language-hidden");
                else el.classList.add("ml-language-hidden");
                return;
              }
              el.classList.add("ml-language-hidden");
            };
            foundBlock = true; break;
          }

          if (block.closeLine >= 0 && lineStart === block.closeLine) {
            evaluateVisibility = (active: string) => {
              if (block.closeVisible) el.classList.add("ml-language-hidden");
            };
            foundBlock = true; break;
          }

          const afterOpen = lineStart > block.openLine;
          const beforeClose = block.closeLine < 0 || lineStart < block.closeLine;
          if (afterOpen && beforeClose) {
            evaluateVisibility = (active: string) => {
              const isActive = active === "ALL" || langMatch(block.langCode, active);
              if (!isActive) {
                el.classList.add("ml-language-hidden");
              } else {
                el.classList.remove("ml-language-hidden");
                if (block.closeLine >= 0 && lineEnd >= block.closeLine) {
                  removeCloseMarkerFromElement(el);
                }
              }
            };
            foundBlock = true; break;
          }
        }
      }

      // 1. Initial Synchronous Application: Stops flicker when elements spawn in-bounds.
      //    Track whether the initial lookup was definitive (element was in the DOM) or
      //    a best-effort guess (element was detached — virtual-scroller lazy-render).
      const initialDefinitive = el.isConnected;
      evaluateVisibility(initialActive);
      if (blocks.length > 0 && showLangHeader) {
        ensureLangHeader(el, blocks, plugin, initialActive);
      } else {
        const owner = el.closest(".markdown-preview-sizer");
        owner?.querySelector(".ml-lang-header")?.remove();
      }

      // 2. Lifecycle Component: Solves rendering bugs triggered by async chunk scrolling.
      // Obsidian frequently invokes post-processors while `el` is a detached fragment.
      // We bind via an asynchronous RequestAnimationFrame queue to guarantee visibility
      // is locked EXACTLY when `el` is surgically attached to the WorkspaceLeaf DOM.
      const child = new MarkdownRenderChild(el);
      const queueItem = {
        el,
        evaluate: () => {
          const mountedActive = plugin.getLanguageForElement(el, ctx.sourcePath);
          // Always re-evaluate when:
          //   a) the initial determination was a detached guess (not definitive), OR
          //   b) the language changed between initial render and mount.
          // This guarantees that detached elements in a split view are always
          // corrected to their owning leaf's language, even if the initial guess
          // happened to produce the same code as the wrong leaf.
          if (!initialDefinitive || mountedActive !== initialActive) {
            evaluateVisibility(mountedActive);
          }
          // Always refresh the header once genuinely attached to the Leaf.
          if (blocks.length > 0 && showLangHeader) {
            ensureLangHeader(el, blocks, plugin, mountedActive);
          } else {
            const owner = el.closest(".markdown-preview-sizer");
            owner?.querySelector(".ml-lang-header")?.remove();
          }
        }
      };

      child.onload = () => {
        if (document.body.contains(el)) {
          queueItem.evaluate();
        } else {
          pendingMountElements.add(queueItem);
          if (!isMountPolling) {
            isMountPolling = true;
            requestAnimationFrame(pollPendingMounts);
          }
        }
      };

      child.onunload = () => {
        pendingMountElements.delete(queueItem);
      };

      ctx.addChild(child);
    },
    // Priority 100 — run after most other processors.
    100
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Remove rendered close-marker text from mixed-content elements.
 * Handles paragraphs, blockquotes, headings, list items, and table cells.
 */
function removeCloseMarkerFromElement(el: HTMLElement): void {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const toRemove: Node[] = [];

  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? "";
    if (isLanguageBlockClose(text)) {
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
      parent.classList.add("ml-language-hidden");
    } else {
      node.parentNode?.removeChild(node);
    }
  }

  // Hide the wrapper if removing the marker leaves no visible text.
  if (el.textContent?.trim() === "") {
    el.classList.add("ml-language-hidden");
  }
}



/**
 * Inject a language-selector bar at the top of the note's sizer container.
 * Uses a data attribute to guarantee it is injected only once per render pass.
 */
function ensureLangHeader(
  el: HTMLElement,
  blocks: LangBlock[],
  plugin: MultilingualNotesPlugin,
  active: string,
): void {
  const owner = el.closest(".markdown-preview-sizer");
  if (!owner) {
    // We are running inside a detached document fragment. 
    // Do not inject headers blindly into random paragraphs! 
    // The `MarkdownRenderChild.onload` logic will safely inject it later.
    return;
  }

  // Collect unique language codes present in this document, expanding "ALL" appropriately.
  const langCodes = extractAvailableLanguagesFromBlocks(blocks, plugin.settings.languages);

  const existing = owner.querySelector(".ml-lang-header");
  if (langCodes.size === 0) {
    existing?.remove();
    return;
  }


  if (existing) {
    // Check if languages match. If so, just update active states.
    const pills = Array.from(existing.querySelectorAll(".ml-lang-pill"));
    const existingCodes = new Set(pills.map(p => p.getAttribute("data-lang")).filter(Boolean) as string[]);

    const expectedCodes = new Set(langCodes);
    if (langCodes.size > 1) expectedCodes.add("ALL");

    let match = existingCodes.size === expectedCodes.size;
    if (match) {
      for (const code of expectedCodes) {
        if (!existingCodes.has(code)) {
          match = false;
          break;
        }
      }
    }

    if (match) {
      // Only toggle active class — never reposition an already-placed header,
      // because any DOM move triggers a layout reflow that shows as jitter.
      pills.forEach((pill) => {
        const code = pill.getAttribute("data-lang");
        if (!code) return;
        const isActive = (active === "ALL") ? code === "ALL" : active.toLowerCase() === code.toLowerCase();
        pill.classList.toggle("ml-lang-pill--active", isActive);
      });
      return;
    } else {
      existing.remove();
    }
  }

  const header = document.createElement("div");
  header.className = "ml-lang-header";

  const onSwitch = (code: string) => {
    let targetLeaf: WorkspaceLeaf | null = null;
    plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (!targetLeaf && leaf.view.containerEl?.contains(owner)) {
        targetLeaf = leaf;
      }
    });

    if (targetLeaf) {
      plugin.setLanguageForSpecificLeaf(targetLeaf, code);
    } else {
      plugin.setLanguageForActiveLeaf(code);
    }
  };

  // ALL pill — always present when there are multiple language codes.
  if (langCodes.size > 1) {
    header.appendChild(
      createHeaderPill("ALL", "ALL", active === "ALL", onSwitch),
    );
  }

  // One pill per language found in the document.
  for (const code of langCodes) {
    const lang = plugin.settings.languages.find(
      (l) => l.code.toLowerCase() === code.toLowerCase(),
    );
    const label = lang ? lang.label : code;
    const isActive = active !== "ALL" && active.toLowerCase() === code.toLowerCase();
    header.appendChild(
      createHeaderPill(code, label, isActive, onSwitch),
    );
  }

  positionHeader(header, owner);
}

function positionHeader(header: HTMLElement, owner: Element): void {
  // Strategy A: insert directly BEFORE the metadata/properties section.
  // This reliably lands the bar between the inline title and the properties panel
  // regardless of whether the panel is collapsed or expanded.
  // NOTE: .mod-header is intentionally excluded from the title selector because
  // it also matches headings INSIDE the expanded metadata panel, which would put
  // the bar at the wrong position when properties are expanded.
  const meta = owner.querySelector(".metadata-container, .frontmatter-container");
  if (meta) {
    const metaSection = meta.closest(".markdown-preview-section");
    if (metaSection && metaSection.parentElement === owner) {
      if (header.nextElementSibling !== metaSection) {
        metaSection.before(header);
      }
      return;
    }
  }

  // Strategy B: no properties panel — insert after the inline-title section.
  const title = owner.querySelector(".inline-title");
  if (title) {
    const section = title.closest(".markdown-preview-section");
    const anchor = (section && section.parentElement === owner) ? section : title;
    if (header.previousElementSibling !== anchor) {
      anchor.after(header);
    }
    return;
  }

  // Strategy C: neither element found — prepend to top of the sizer.
  if (owner.firstElementChild !== header) {
    owner.prepend(header);
  }
}

function createHeaderPill(
  code: string,
  label: string,
  isActive: boolean,
  onSwitch: (code: string) => void,
): HTMLElement {
  const pill = document.createElement("span");
  pill.className = "ml-lang-pill" + (isActive ? " ml-lang-pill--active" : "");
  pill.textContent = label;
  pill.setAttribute("data-lang", code);
  pill.addEventListener("click", () => onSwitch(code));
  return pill;
}
