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
const URL_PLACEHOLDER = (idx: number) => `{{URL_${idx}}}`;
const PLACEHOLDER_RE = /\{\{(CODE_BLOCK|URL)_\d+\}\}/;

function hasPlaceholders(text: string): boolean {
    return PLACEHOLDER_RE.test(text);
}

/**
 * Replaces fenced code blocks (```...```) with short placeholders.
 * This keeps code blocks out of the translation context and prevents
 * them from inflating chunk sizes.
 */
export function extractCodeBlocks(source: string): CodeBlockExtraction {
    const blocks: string[] = [];
    let idx = 0;
    const text = source.replace(CODE_BLOCK_RE, (match) => {
        blocks.push(match);
        return CODE_PLACEHOLDER(idx++);
    });
    return { text, blocks };
}

/**
 * Restores original code blocks by replacing placeholders.
 * Tolerates minor whitespace changes around placeholders.
 */
export function restoreCodeBlocks(text: string, blocks: string[]): string {
    let result = text;
    for (let i = 0; i < blocks.length; i++) {
        // Flexible match: allow optional spaces/newlines around placeholder
        const re = new RegExp(`\\s*\\{\\{CODE_BLOCK_${i}\\}\\}\\s*`, "g");
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
        const re = new RegExp(`\\{\\{URL_${i}\\}\\}`, "g");
        result = result.replace(re, urls[i]);
    }
    return result;
}

/** Rough token estimate for CJK/Latin mixed Markdown. */
const TOKEN_PER_CHAR = 0.8;

/**
 * Splits text into chunks that the model can actually translate.
 *
 * Two hard ceilings apply:
 * 1. API level:  maxContext - maxOutput - systemPromptReserve
 * 2. Business level: maxOutput * 0.75  (translations can be 10-30 % longer)
 *
 * The effective chunk size is the smaller of the two.
 */
export function splitIntoChunks(
    text: string,
    maxContextTokens: number,
    maxOutputTokens: number,
    systemPrompt?: string,
    sourceLanguage?: string,
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

    // 2. Translation business limit: output ceiling dictates how much source
    // text can realistically be translated in one go. 0.75 is conservative
    // (accounts for target-language expansion, e.g. Chinese → English).
    const translationLimit = Math.floor(maxOutputTokens * 0.75);

    const maxChunkTokens = Math.min(apiInputLimit, translationLimit);

    // 3. CJK-dense text needs a higher tokens-per-char estimate.
    const isCjkSource = sourceLanguage && /^(zh|ja|ko)/i.test(sourceLanguage);
    const tokenPerChar = isCjkSource ? 1.3 : TOKEN_PER_CHAR;
    const maxChars = Math.floor(maxChunkTokens / tokenPerChar);

    if (maxChunkTokens < 4096) {
        throw new Error(
            `Context window too small for translation: maxContext=${maxContextTokens}, ` +
            `maxOutput=${maxOutputTokens}, available=${maxChunkTokens}`,
        );
    }

    const paragraphs = text.split(/\n\s*\n/).filter((p) => p.trim());
    const chunks: string[] = [];
    let current = "";

    for (const para of paragraphs) {
        const next = current ? current + "\n\n" + para : para;
        if (next.length > maxChars && current) {
            chunks.push(current);
            current = para;
        } else if (para.length > maxChars) {
            // Single paragraph exceeds limit — slice at sentence boundaries
            if (current) {
                chunks.push(current);
                current = "";
            }
            chunks.push(...sliceAtSentenceBoundaries(para, maxChars));
        } else {
            current = next;
        }
    }
    if (current) chunks.push(current);
    return chunks.length > 0 ? chunks : [text];
}

/**
 * Splits an oversized paragraph at sentence boundaries.
 * Falls back to hard character slicing when no boundary is found.
 */
function sliceAtSentenceBoundaries(para: string, maxChars: number): string[] {
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
        prompt += "\n\nIMPORTANT: Some content (code blocks, URLs, images) has been replaced with placeholders like {{CODE_BLOCK_N}} or {{URL_N}}. Preserve these placeholders exactly in your output — they will be restored afterwards. Do NOT translate or alter them.";
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
