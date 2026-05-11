// NOTE: This module intentionally uses the native fetch() API instead of
// Obsidian's requestUrl(). requestUrl() buffers the entire response before
// returning and therefore cannot support Server-Sent Events (SSE). Real-time
// streaming requires a ReadableStream, which only fetch() exposes. The
// AbortSignal passed by callers ensures the connection is cancelled promptly
// when the user closes the translation modal, preventing wasted API tokens.
// This will be documented in the Obsidian community plugin PR submission.

import type { MultilingualNotesSettings } from "../settings";

export interface ChunkInfo {
    current: number;
    total: number;
}

export interface CodeBlockExtraction {
    text: string;
    blocks: string[];
}

const CODE_BLOCK_RE = /```[\s\S]*?```/g;
const CODE_PLACEHOLDER = (idx: number) => `{{CODE_BLOCK_${idx}}}`;

/**
 * Robust line-by-line extraction of fenced code blocks.
 * Handles nested backticks correctly (e.g. code containing ```).
 */
function extractCodeBlocksRobust(source: string): CodeBlockExtraction {
    const blocks: string[] = [];
    const lines = source.split("\n");
    let idx = 0;
    let inBlock = false;
    let fence = "";
    let blockLines: string[] = [];
    const outLines: string[] = [];

    for (const line of lines) {
        const match = line.match(/^( {0,3})(`{3,}|~{3,})(.*)$/);
        if (match && !inBlock) {
            inBlock = true;
            fence = match[2];
            blockLines = [line];
        } else if (match && inBlock) {
            const closeFence = match[2];
            if (closeFence[0] === fence[0] && closeFence.length >= fence.length) {
                blockLines.push(line);
                blocks.push(blockLines.join("\n"));
                outLines.push(CODE_PLACEHOLDER(idx++));
                inBlock = false;
                fence = "";
                blockLines = [];
            } else {
                blockLines.push(line);
            }
        } else if (inBlock) {
            blockLines.push(line);
        } else {
            outLines.push(line);
        }
    }

    if (inBlock) {
        blocks.push(blockLines.join("\n"));
        outLines.push(CODE_PLACEHOLDER(idx++));
    }

    return { text: outLines.join("\n"), blocks };
}
const URL_PLACEHOLDER = (idx: number) => `{{URL_${idx}}}`;
const TABLE_PLACEHOLDER = (idx: number) => `{{TABLE_${idx}}}`;
const LATEX_PLACEHOLDER = (idx: number) => `{{LATEX_${idx}}}`;
const PLACEHOLDER_RE = /\{\{(CODE_BLOCK|URL|TABLE|LATEX)_\d+\}\}/;

function hasPlaceholders(text: string): boolean {
    return PLACEHOLDER_RE.test(text);
}

/**
 * Replaces fenced code blocks (```...```) with short placeholders.
 * This keeps code blocks out of the translation context and prevents
 * them from inflating chunk sizes.
 */
export function extractCodeBlocks(source: string): CodeBlockExtraction {
    // Prefer robust line-by-line parser over regex to avoid early termination
    // when code blocks contain nested backticks.
    return extractCodeBlocksRobust(source);
}

/**
 * Restores original code blocks by replacing placeholders.
 * Tolerates minor whitespace changes around placeholders.
 */
export function restoreCodeBlocks(text: string, blocks: string[]): string {
    let result = text;
    for (let i = 0; i < blocks.length; i++) {
        // Flexible match: tolerate optional spaces/newlines around and inside the placeholder.
        const re = new RegExp(`\\s*\\{\\{\\s*CODE_BLOCK_${i}\\s*\\}\\}\\s*`, "gi");
        result = result.replace(re, (m) => {
            // Preserve leading/trailing newlines from the match
            const leading = m.match(/^\s*/)?.[0] ?? "";
            const trailing = m.match(/\s*$/)?.[0] ?? "";
            return leading + blocks[i] + trailing;
        });
    }
    return result;
}

export interface UrlExtraction {
    text: string;
    urls: string[];
}

/**
 * Replaces URLs in Markdown images/links and bare URLs with short placeholders.
 * Keeps the alt text / link text so the model can still translate those.
 *
 * Order matters: images first (so they are not caught by the link regex),
 * then links, then bare URLs.
 */
export function extractUrls(source: string): UrlExtraction {
    const urls: string[] = [];
    let idx = 0;

    // 1. Obsidian links/embeds: [[file]], [[file|alias]], ![[file]]
    let text = source.replace(/!?\[\[([^\]]+)\]\]/g, (match) => {
        urls.push(match);
        return URL_PLACEHOLDER(idx++);
    });

    // 2. Markdown images: ![alt](url)
    text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        urls.push(url);
        return `![${alt}](${URL_PLACEHOLDER(idx++)})`;
    });

    // 3. Markdown links: [text](url) — covers local refs (./, /, #) and remote URLs
    text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (match, linkText, url) => {
        urls.push(url);
        return `[${linkText}](${URL_PLACEHOLDER(idx++)})`;
    });

    // 4. Bare URLs — allow one balanced pair of parentheses (common in
    // Wikipedia links like https://en.wikipedia.org/wiki/Foo_(disambiguation))
    text = text.replace(/(https?:\/\/[^\s)\]]+(?:\([^\s)]+\))?)/g, (match, url) => {
        urls.push(url);
        return URL_PLACEHOLDER(idx++);
    });

    return { text, urls };
}

/**
 * Restores original URLs by replacing placeholders.
 */
export function restoreUrls(text: string, urls: string[]): string {
    let result = text;
    for (let i = 0; i < urls.length; i++) {
        const re = new RegExp(`\\{\\{\\s*URL_${i}\\s*\\}\\}`, "gi");
        result = result.replace(re, urls[i]);
    }
    return result;
}

export interface TableExtraction {
    text: string;
    tables: string[];
}

const TABLE_RE = /(?:^\|.*\|[ \t]*(?:\r?\n)?)+/gm;

/**
 * Replaces Markdown tables with short placeholders.
 */
export function extractTables(source: string): TableExtraction {
    const tables: string[] = [];
    let idx = 0;
    const text = source.replace(TABLE_RE, (match) => {
        tables.push(match);
        return TABLE_PLACEHOLDER(idx++);
    });
    return { text, tables };
}

/**
 * Restores original tables by replacing placeholders.
 */
export function restoreTables(text: string, tables: string[]): string {
    let result = text;
    for (let i = 0; i < tables.length; i++) {
        const re = new RegExp(`\\{\\{\\s*TABLE_${i}\\s*\\}\\}`, "gi");
        result = result.replace(re, tables[i]);
    }
    return result;
}

export interface LatexExtraction {
    text: string;
    latex: string[];
}

const LATEX_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;
const LATEX_INLINE_RE = /(?<!\$)\$([^$\n]+?)\$(?!\$)/g;

/**
 * Replaces LaTeX equations (block $$...$$ and inline $...$) with short placeholders.
 */
export function extractLatex(source: string): LatexExtraction {
    const latex: string[] = [];
    let idx = 0;

    // Block equations first
    let text = source.replace(LATEX_BLOCK_RE, (match) => {
        latex.push(match);
        return LATEX_PLACEHOLDER(idx++);
    });

    // Inline equations
    text = text.replace(LATEX_INLINE_RE, (match) => {
        latex.push(match);
        return LATEX_PLACEHOLDER(idx++);
    });

    return { text, latex };
}

/**
 * Restores original LaTeX equations by replacing placeholders.
 */
export function restoreLatex(text: string, latex: string[]): string {
    let result = text;
    for (let i = 0; i < latex.length; i++) {
        const re = new RegExp(`\\{\\{\\s*LATEX_${i}\\s*\\}\\}`, "gi");
        result = result.replace(re, latex[i]);
    }
    return result;
}

/** Rough token estimate for CJK/Latin mixed Markdown. */
const TOKEN_PER_CHAR = 0.8;

/**
 * Estimates tokens-per-character ratio by sampling the text.
 * More accurate than fixed constants because it accounts for actual content mix.
 */
function estimateTokenPerChar(text: string): number {
    const SAMPLE_SIZE = 2000;
    const sample = text.slice(0, Math.min(text.length, SAMPLE_SIZE));

    let cjkChars = 0;
    let asciiChars = 0;
    let otherChars = 0;

    for (let i = 0; i < sample.length; i++) {
        const cp = sample.codePointAt(i);
        if (cp === undefined) continue;

        // CJK Unified Ideographs + extensions, Hiragana, Katakana, Hangul syllables
        if (
            (cp >= 0x4e00 && cp <= 0x9fff) ||
            (cp >= 0x3400 && cp <= 0x4dbf) ||
            (cp >= 0x3040 && cp <= 0x309f) ||
            (cp >= 0x30a0 && cp <= 0x30ff) ||
            (cp >= 0xac00 && cp <= 0xd7af)
        ) {
            cjkChars++;
        }
        // ASCII letters and digits
        else if (
            (cp >= 0x41 && cp <= 0x5a) ||
            (cp >= 0x61 && cp <= 0x7a) ||
            (cp >= 0x30 && cp <= 0x39)
        ) {
            asciiChars++;
        } else {
            otherChars++;
        }
    }

    const total = cjkChars + asciiChars + otherChars;
    if (total === 0) return TOKEN_PER_CHAR;

    // cl100k_base rough estimates with 10% safety margin:
    // CJK ~1.3-1.5 tokens/char, ASCII text ~0.25-0.3, symbols/markdown ~0.5-1.0
    const ratio = (cjkChars * 1.4 + asciiChars * 0.3 + otherChars * 0.7) / total;
    return Math.max(0.3, Math.min(ratio * 1.1, 2.0));
}

/**
 * Estimates output/input expansion ratio for a language pair.
 * >1 means target text is longer (expansion), <1 means shorter (contraction).
 * These are empirical averages for LLM translations.
 */
function estimateExpansionRatio(sourceLang?: string, targetLang?: string): number {
    const src = (sourceLang ?? "").toLowerCase().split("-")[0];
    const tgt = (targetLang ?? "").toLowerCase().split("-")[0];
    const key = `${src}→${tgt}`;

    const RATIOS: Record<string, number> = {
        "zh→en": 1.35,
        "zh→ja": 1.10,
        "zh→ko": 1.05,
        "zh→fr": 1.30,
        "zh→de": 1.25,
        "zh→ru": 1.20,
        "ja→en": 1.45,
        "ja→zh": 0.90,
        "ja→ko": 0.95,
        "ko→en": 1.30,
        "ko→zh": 0.95,
        "ko→ja": 0.95,
        "en→zh": 0.80,
        "en→ja": 0.85,
        "en→ko": 0.90,
        "en→fr": 1.05,
        "en→de": 1.05,
        "en→ru": 1.00,
        "en→hi": 1.10,
        "fr→en": 1.00,
        "fr→zh": 0.90,
        "de→en": 1.00,
        "de→zh": 0.90,
        "ru→en": 1.05,
        "ru→zh": 0.95,
        "hi→en": 1.00,
        "hi→zh": 0.95,
    };

    return RATIOS[key] ?? 1.25;
}

export interface TranslationStats {
    ratio: number;
    samples: number;
}

/**
 * Returns the expansion ratio for a language pair.
 * Prefers historical stats if enough samples (>=3) exist; falls back to empirical defaults.
 */
export function getAdaptiveExpansionRatio(
    sourceLang?: string,
    targetLang?: string,
    stats?: TranslationStats,
): number {
    if (stats && stats.samples >= 3) {
        return stats.ratio;
    }
    return estimateExpansionRatio(sourceLang, targetLang);
}

/**
 * Updates translation stats with a new observed ratio (outputChars / inputChars).
 */
export function updateTranslationStats(
    stats: TranslationStats,
    inputChars: number,
    outputChars: number,
): TranslationStats {
    const observed = inputChars > 0 ? outputChars / inputChars : 1.0;
    const newSamples = stats.samples + 1;
    return {
        ratio: (stats.ratio * stats.samples + observed) / newSamples,
        samples: newSamples,
    };
}

/**
 * Splits text into chunks that fit the model's context window and output budget.
 *
 * Two ceilings apply:
 * 1. API level:  maxContext - maxOutput - reserve
 * 2. Business level: maxOutput / expansionRatio (ensures translation fits)
 *
 * If a chunk still overflows during translation, the caller will
 * adaptively split it at sentence boundaries.
 */
export function splitIntoChunks(
    text: string,
    maxContextTokens: number,
    maxOutputTokens: number,
    systemPrompt?: string,
    sourceLanguage?: string,
    targetLanguage?: string,
    stats?: TranslationStats,
): string[] {
    // Base reserve for language info, chunk metadata, placeholder instructions.
    const BASE_RESERVE = 500;
    const systemPromptTokens = systemPrompt
        ? Math.ceil(systemPrompt.length * TOKEN_PER_CHAR)
        : 0;

    // 1. API hard limit: context window minus output budget minus all prompts
    const apiInputLimit = Math.max(
        0,
        maxContextTokens - maxOutputTokens - BASE_RESERVE - systemPromptTokens,
    );

    // 2. Business limit: output ceiling dictates how much source text can
    // realistically be translated in one go, adjusted by language-pair expansion.
    const expansionRatio = getAdaptiveExpansionRatio(sourceLanguage, targetLanguage, stats);
    const inputLimitByOutput = Math.floor(maxOutputTokens / expansionRatio);

    const maxChunkTokens = Math.min(apiInputLimit, inputLimitByOutput);

    // 3. Dynamic tokens-per-char estimate based on actual text sampling.
    const tokenPerChar = estimateTokenPerChar(text);
    const maxChars = Math.floor(maxChunkTokens / tokenPerChar);

    if (maxChunkTokens < 2048) {
        throw new Error(
            `Context window too small for translation: maxContext=${maxContextTokens}, ` +
            `maxOutput=${maxOutputTokens}, available=${maxChunkTokens} (ratio=${expansionRatio.toFixed(2)})`,
        );
    }

    // 4. Heading-aware chunking: try to keep Markdown sections intact.
    const sections = splitByHeadings(text);
    const chunks: string[] = [];
    let current = "";

    for (const section of sections) {
        if (!section.trim()) continue;

        const next = current ? current + "\n\n" + section : section;
        if (next.length > maxChars && current) {
            chunks.push(current);
            current = section;
        } else if (section.length > maxChars) {
            // Section too big — fall back to paragraph-level packing inside the section
            if (current) {
                chunks.push(current);
                current = "";
            }
            const paragraphs = section.split(/\n\s*\n/).filter((p) => p.trim());
            for (const para of paragraphs) {
                const pNext = current ? current + "\n\n" + para : para;
                if (pNext.length > maxChars && current) {
                    chunks.push(current);
                    current = para;
                } else if (para.length > maxChars) {
                    if (current) {
                        chunks.push(current);
                        current = "";
                    }
                    chunks.push(...sliceAtSentenceBoundaries(para, maxChars));
                } else {
                    current = pNext;
                }
            }
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [text];
}

/**
 * Splits Markdown text by headings, keeping each heading with its following content.
 */
function splitByHeadings(text: string): string[] {
    const sections: string[] = [];
    let current = "";
    const lines = text.split("\n");

    for (const line of lines) {
        if (/^#{1,6}\s/.test(line)) {
            if (current.trim()) {
                sections.push(current.trimEnd());
            }
            current = line + "\n";
        } else {
            current += line + "\n";
        }
    }
    if (current.trim()) {
        sections.push(current.trimEnd());
    }
    return sections.length > 0 ? sections : [text];
}

/**
 * Splits an oversized paragraph at sentence boundaries.
 * Falls back to hard character slicing when no boundary is found.
 */
export function sliceAtSentenceBoundaries(para: string, maxChars: number): string[] {
    const result: string[] = [];
    let start = 0;

    while (start < para.length) {
        const end = start + maxChars;
        if (end >= para.length) {
            result.push(para.slice(start));
            break;
        }

        // Search backwards for a sentence boundary within the last 20 % of
        // the allowed window.
        const searchStart = Math.max(start, end - Math.floor(maxChars * 0.2));
        const slice = para.slice(searchStart, end);

        // Try sentence-ending punctuation followed by space or newline
        const boundaryMatch = /[。.!！?？\n]\s*/.exec(slice);
        if (boundaryMatch && boundaryMatch.index + boundaryMatch[0].length > 0) {
            const cutAt = searchStart + boundaryMatch.index + boundaryMatch[0].length;
            result.push(para.slice(start, cutAt));
            start = cutAt;
            continue;
        }

        // No sentence boundary found — hard slice
        result.push(para.slice(start, end));
        start = end;
    }

    return result;
}

function buildOpenAIEndpoint(base: string): string {
    if (base.endsWith("/chat/completions")) return base;
    return base.replace(/\/+$/, "") + "/chat/completions";
}

function buildAnthropicEndpoint(base: string): string {
    if (base.endsWith("/messages")) return base;
    return base.replace(/\/+$/, "") + "/messages";
}

interface ParsedChunk {
    content: string | null;
    truncated: boolean;
}

function parseOpenAIChunk(line: string): ParsedChunk {
    const trimmed = line.trim();
    if (!trimmed || trimmed === "data: [DONE]") return { content: null, truncated: false };
    if (!trimmed.startsWith("data: ")) return { content: null, truncated: false };
    try {
        const json = JSON.parse(trimmed.slice(6)) as {
            choices?: Array<{
                delta?: { content?: string };
                finish_reason?: string | null;
            }>;
        };
        const choice = json.choices?.[0];
        return {
            content: choice?.delta?.content ?? null,
            truncated: choice?.finish_reason === "length",
        };
    } catch {
        return { content: null, truncated: false };
    }
}

function parseAnthropicChunk(line: string): ParsedChunk {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith("data: ")) return { content: null, truncated: false };
    if (trimmed === "data: [DONE]") return { content: null, truncated: false };
    try {
        const json = JSON.parse(trimmed.slice(6)) as {
            type?: string;
            delta?: { type?: string; text?: string };
            stop_reason?: string;
        };
        if (json.type === "content_block_delta" && json.delta?.text) {
            return { content: json.delta.text, truncated: false };
        }
        return { content: null, truncated: json.stop_reason === "max_tokens" };
    } catch {
        return { content: null, truncated: false };
    }
}

export async function streamTranslation(
    sourceText: string,
    targetLangName: string,
    sourceLangName: string | undefined,
    settings: MultilingualNotesSettings,
    onChunk: (text: string) => void,
    signal?: AbortSignal,
    chunkInfo?: ChunkInfo,
): Promise<void> {
    const { aiApiCompany, aiApiBase, aiApiKey, aiModel, aiMaxTokens, aiTimeout, aiSystemPrompt } = settings;

    if (!aiApiBase) throw new Error("API Base URL is not configured.");
    if (!aiApiKey) throw new Error("API Key is not configured.");
    if (!aiModel) throw new Error("AI Model is not configured.");

    // ── Timeout handling ──────────────────────────────────────────────────
    const timeoutMs = (aiTimeout > 0 ? aiTimeout : 120) * 1000;
    const effectiveController = new AbortController();
    const timeoutId = setTimeout(() => {
        effectiveController.abort(new Error(`Request timed out after ${aiTimeout}s.`));
    }, timeoutMs);

    if (signal) {
        const onAbort = () => effectiveController.abort(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
    }

    let prompt = `${aiSystemPrompt}\n\nSource language: ${sourceLangName ?? "Auto-detect"}\nTarget language: ${targetLangName}`;
    if (chunkInfo && chunkInfo.total > 1) {
        prompt += `\n\nThis is part ${chunkInfo.current} of ${chunkInfo.total}. Translate it while maintaining consistency with the overall document context.`;
    }
    if (hasPlaceholders(sourceText)) {
        prompt += "\n\nIMPORTANT: Some content (code blocks, tables, LaTeX equations, URLs, images) has been replaced with placeholders like {{CODE_BLOCK_N}}, {{TABLE_N}}, {{LATEX_N}}, or {{URL_N}}. Preserve these placeholders exactly in your output — they will be restored afterwards. Do NOT translate or alter them.";
    }

    let endpoint: string;
    let headers: Record<string, string>;
    let body: unknown;
    let parseChunk: (line: string) => ParsedChunk;

    if (aiApiCompany === "anthropic") {
        endpoint = buildAnthropicEndpoint(aiApiBase);
        headers = {
            "Content-Type": "application/json",
            "x-api-key": aiApiKey,
            "anthropic-version": "2023-06-01",
        };
        body = {
            model: aiModel,
            max_tokens: aiMaxTokens,
            temperature: 0.3,
            system: prompt,
            messages: [{ role: "user", content: sourceText }],
            stream: true,
        };
        parseChunk = parseAnthropicChunk;
    } else {
        endpoint = buildOpenAIEndpoint(aiApiBase);
        headers = {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${aiApiKey}`,
        };
        body = {
            model: aiModel,
            messages: [
                { role: "system", content: prompt },
                { role: "user", content: sourceText },
            ],
            max_tokens: aiMaxTokens,
            temperature: 0.3,
            stream: true,
        };
        parseChunk = parseOpenAIChunk;
    }

    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: effectiveController.signal,
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    if (!response.body) throw new Error("Response body is empty.");

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    let wasTruncated = false;

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
                const { content: delta, truncated } = parseChunk(line);
                if (truncated) wasTruncated = true;
                if (typeof delta === "string" && delta) onChunk(delta);
            }
        }
    } finally {
        clearTimeout(timeoutId);
        reader.releaseLock();
    }

    if (wasTruncated) {
        throw new Error("Translation output was truncated by max_tokens limit.");
    }
}
