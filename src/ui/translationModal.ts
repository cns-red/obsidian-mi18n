import { App, Component, Modal, Notice, ButtonComponent, MarkdownRenderer, setIcon } from "obsidian";
import type { MultilingualNotesSettings, LanguageEntry } from "../settings";
import { t } from "../i18n";
import { streamTranslation, splitIntoChunks, extractCodeBlocks, restoreCodeBlocks, extractUrls, restoreUrls, extractTables, restoreTables, extractLatex, restoreLatex, sliceAtSentenceBoundaries, updateTranslationStats, type ChunkInfo, type TranslationStats } from "../api/ai";

interface TranslationPlugin {
    settings: MultilingualNotesSettings;
    extractLanguageContent(source: string, targetLangCode: string): string;
    saveSettings(): Promise<void>;
}

export class TranslationModal extends Modal {
    private plugin: TranslationPlugin;
    private sourceContent: string;
    private sourceLanguage: string;
    private targetLanguage: string;
    private noteExistingLanguages: Set<string>;

    private sourceRenderEl: HTMLElement | null = null;
    private previewRenderEl: HTMLElement | null = null;
    private previewTextArea: HTMLTextAreaElement | null = null;
    private generateBtn: ButtonComponent | null = null;
    private insertBtn: ButtonComponent | null = null;

    private extractedSourceContent: string = "";
    private translatedContent: string = "";
    private isStreaming: boolean = false;
    private isEditMode: boolean = false;
    private abortController: AbortController | null = null;
    private currentChunk = 0;
    private totalChunks = 0;
    private renderComponent: Component | null = null;

    public onInsertCallback: ((text: string, targetLangCode: string) => void) | null = null;

    constructor(
        app: App,
        plugin: TranslationPlugin,
        sourceContent: string,
        activeEditorLangCode: string,
        existingLanguages: Set<string>
    ) {
        super(app);
        this.plugin = plugin;
        this.sourceContent = sourceContent;
        this.noteExistingLanguages = existingLanguages;

        if (activeEditorLangCode && existingLanguages.has(activeEditorLangCode.toLowerCase())) {
            this.sourceLanguage = activeEditorLangCode.toLowerCase();
        } else if (existingLanguages.size > 0) {
            this.sourceLanguage = Array.from(existingLanguages)[0].toLowerCase();
        } else {
            this.sourceLanguage = plugin.settings.defaultLanguage.toLowerCase();
        }

        this.targetLanguage = "";
        const availableTargets = plugin.settings.languages.filter(
            l => !existingLanguages.has(l.code.toLowerCase())
        );
        if (availableTargets.length > 0) {
            this.targetLanguage = availableTargets[0].code;
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        this.renderComponent = new Component();

        this.modalEl.addClass("ml-tr-modal");

        // ── Error state ───────────────────────────────────────────────────────
        if (!this.plugin.settings.aiApiKey) {
            const err = contentEl.createDiv("ml-tr-error");
            err.createEl("p", { text: t("notice.api_key_missing") });
            return;
        }

        // ── Header ────────────────────────────────────────────────────────────
        const header = contentEl.createDiv("ml-tr-header");
        header.createEl("h2", { text: t("menu.smart_translate"), cls: "ml-tr-title" });

        // ── Language Selector Row ─────────────────────────────────────────────
        const langRow = header.createDiv("ml-tr-lang-row");

        // Source language
        const srcGroup = langRow.createDiv("ml-tr-lang-group");
        srcGroup.createEl("span", { text: t("settings.source_language"), cls: "ml-tr-lang-label" });
        const srcSelect = srcGroup.createEl("select", { cls: "ml-tr-select" });

        const sourceLangs = this.plugin.settings.languages.filter(
            l => this.noteExistingLanguages.has(l.code.toLowerCase())
        );
        const finalSourceLangs = sourceLangs.length > 0 ? sourceLangs : this.plugin.settings.languages;
        finalSourceLangs.forEach(l => {
            const opt = srcSelect.createEl("option", { text: l.label, value: l.code });
            if (l.code.toLowerCase() === this.sourceLanguage) opt.selected = true;
        });
        srcSelect.addEventListener("change", () => {
            this.sourceLanguage = srcSelect.value;
            this.updateSourcePreview();
        });

        // Arrow
        langRow.createEl("span", { text: "→", cls: "ml-tr-arrow" });

        // Target language
        const tgtGroup = langRow.createDiv("ml-tr-lang-group");
        tgtGroup.createEl("span", { text: t("settings.target_language"), cls: "ml-tr-lang-label" });
        const tgtSelect = tgtGroup.createEl("select", { cls: "ml-tr-select" });

        const targetLangs = this.plugin.settings.languages.filter(
            l => !this.noteExistingLanguages.has(l.code.toLowerCase())
        );
        if (targetLangs.length === 0) {
            tgtSelect.createEl("option", {
                text: t("notice.fully_internationalized"),
                value: "",
            });
        } else {
            targetLangs.forEach(l => {
                const opt = tgtSelect.createEl("option", { text: l.label, value: l.code });
                if (l.code === this.targetLanguage) opt.selected = true;
            });
        }
        tgtSelect.addEventListener("change", () => {
            this.targetLanguage = tgtSelect.value;
            this.updateGenerateBtnState();
        });

        // Generate button
        const btnWrap = langRow.createDiv("ml-tr-btn-wrap");
        this.generateBtn = new ButtonComponent(btnWrap)
            .setButtonText(t("button.translate"))
            .setCta()
            .onClick(() => { void this.runStreamTranslation(); });
        this.generateBtn.buttonEl.addClass("ml-tr-generate-btn");
        this.updateGenerateBtnState();

        // ── Split Panel ───────────────────────────────────────────────────────
        const split = contentEl.createDiv("ml-tr-split");

        // Left: Source
        const srcPanel = split.createDiv("ml-tr-panel");
        const srcHead = srcPanel.createDiv("ml-tr-panel-head");
        srcHead.createEl("span", { text: t("label.source_text"), cls: "ml-tr-panel-label" });
        this.sourceRenderEl = srcPanel.createDiv("ml-tr-panel-body ml-tr-preview");
        this.updateSourcePreview();

        // Right: Translation
        const tgtPanel = split.createDiv("ml-tr-panel");
        const tgtHead = tgtPanel.createDiv("ml-tr-panel-head");
        tgtHead.createEl("span", { text: t("label.translation"), cls: "ml-tr-panel-label" });

        // Edit/preview toggle
        const editBtn = tgtHead.createEl("button", { cls: "ml-tr-icon-btn", attr: { title: t("tooltip.edit_translation") } });
        this.setEditBtnIcon(editBtn, false);
        editBtn.addEventListener("click", () => {
            this.isEditMode = !this.isEditMode;
            this.setEditBtnIcon(editBtn, this.isEditMode);
            this.syncViewMode();
        });

        const tgtBody = tgtPanel.createDiv("ml-tr-panel-body");
        this.previewRenderEl = tgtBody.createDiv("ml-tr-preview");
        this.renderTranslation();

        this.previewTextArea = tgtBody.createEl("textarea", { cls: "ml-tr-textarea ml-tr-hidden" });
        this.previewTextArea.placeholder = t("placeholder.translation_preview");
        this.previewTextArea.value = this.translatedContent;
        this.previewTextArea.addEventListener("input", () => {
            this.translatedContent = this.previewTextArea!.value;
            this.renderTranslation();
            this.updateInsertBtnState();
        });

        // ── Footer ────────────────────────────────────────────────────────────
        const footer = contentEl.createDiv("ml-tr-footer");

        new ButtonComponent(footer)
            .setButtonText(t("button.cancel"))
            .onClick(() => {
                this.cancelStream();
                this.close();
            });

        this.insertBtn = new ButtonComponent(footer)
            .setButtonText(t("button.insert"))
            .setCta()
            .setDisabled(true)
            .onClick(() => {
                if (!this.translatedContent.trim()) {
                    new Notice(t("notice.empty_insertion"));
                    return;
                }
                this.doInsert();
            });
        this.insertBtn.buttonEl.addClass("ml-tr-insert-btn");
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private cancelStream(): void {
        this.isStreaming = false;
        this.abortController?.abort();
        this.abortController = null;
    }

    private setEditBtnIcon(el: HTMLElement, editing: boolean): void {
        el.empty();
        if (editing) {
            setIcon(el, "eye");
            el.setAttribute("data-active", "true");
        } else {
            setIcon(el, "pencil");
            el.removeAttribute("data-active");
        }
    }

    private syncViewMode(): void {
        if (!this.previewRenderEl || !this.previewTextArea) return;
        if (this.isEditMode) {
            this.previewRenderEl.addClass("ml-tr-hidden");
            this.previewTextArea.removeClass("ml-tr-hidden");
        } else {
            this.previewRenderEl.removeClass("ml-tr-hidden");
            this.previewTextArea.addClass("ml-tr-hidden");
        }
    }

    private stripFrontmatter(content: string): string {
        const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        return match ? content.slice(match[0].length) : content;
    }

    private updateSourcePreview(): void {
        if (!this.sourceRenderEl) return;
        this.sourceRenderEl.empty();
        this.extractedSourceContent = this.stripFrontmatter(
            this.plugin.extractLanguageContent(this.sourceContent, this.sourceLanguage)
        );
        if (this.renderComponent) {
            void MarkdownRenderer.render(
                this.app,
                this.extractedSourceContent || "_No source text found for this language._",
                this.sourceRenderEl, "", this.renderComponent
            );
        }
    }

    private renderTranslation(): void {
        if (!this.previewRenderEl || !this.renderComponent) return;
        this.previewRenderEl.empty();
        void MarkdownRenderer.render(
            this.app,
            this.translatedContent || "_Translation will appear here…_",
            this.previewRenderEl, "", this.renderComponent
        );
    }

    private renderTranslationText(text: string): void {
        if (!this.previewRenderEl || !this.renderComponent) return;
        this.previewRenderEl.empty();
        void MarkdownRenderer.render(
            this.app,
            text || "_Translation will appear here…_",
            this.previewRenderEl, "", this.renderComponent
        );
    }

    private updateGenerateBtnState(): void {
        this.generateBtn?.setDisabled(!this.targetLanguage || !this.sourceLanguage || this.isStreaming);
    }

    private updateInsertBtnState(): void {
        this.insertBtn?.setDisabled(!this.translatedContent.trim() || this.isStreaming);
    }

    private async runStreamTranslation(): Promise<void> {
        if (!this.generateBtn || !this.previewTextArea || !this.previewRenderEl) return;

        this.abortController = new AbortController();
        this.isStreaming = true;
        this.translatedContent = "";
        this.previewTextArea.value = "";

        this.generateBtn.setButtonText(t("button.translating"));
        this.generateBtn.buttonEl.addClass("ml-tr-spinning");
        this.updateGenerateBtnState();
        this.updateInsertBtnState();

        // Switch to preview mode during streaming
        if (this.isEditMode) {
            this.isEditMode = false;
            this.syncViewMode();
        }

        const srcName = this.plugin.settings.languages.find(
            (l: LanguageEntry) => l.code.toLowerCase() === this.sourceLanguage
        )?.label || this.sourceLanguage;
        const tgtName = this.plugin.settings.languages.find(
            (l: LanguageEntry) => l.code === this.targetLanguage
        )?.label || this.targetLanguage;

        // ── Extract code blocks (they don't need translation) ───────────────
        const { text: textWithoutCode, blocks: codeBlocks } = extractCodeBlocks(
            this.extractedSourceContent
        );

        // ── Extract Markdown tables ──────────────────────────────────────────
        const { text: textWithoutTables, tables } = extractTables(textWithoutCode);

        // ── Extract LaTeX equations ──────────────────────────────────────────
        const { text: textWithoutLatex, latex } = extractLatex(textWithoutTables);

        // ── Extract URLs (prevent model from hallucinating/modifying them) ──
        const { text: textWithPlaceholders, urls } = extractUrls(textWithoutLatex);

        // ── Chunking ────────────────────────────────────────────────────────
        const { aiMaxContext, aiMaxTokens } = this.plugin.settings;
        if (aiMaxContext - aiMaxTokens < 4000) {
            new Notice(t("notice.context_too_small"));
            this.isStreaming = false;
            this.generateBtn.setButtonText(t("button.regenerate"));
            this.generateBtn.buttonEl.removeClass("ml-tr-spinning");
            this.updateGenerateBtnState();
            return;
        }
        const statsKey = `${this.sourceLanguage}→${this.targetLanguage}`;
        const stats: TranslationStats | undefined = this.plugin.settings.translationStats[statsKey];
        const chunks = splitIntoChunks(
            textWithPlaceholders,
            aiMaxContext,
            aiMaxTokens,
            this.plugin.settings.aiSystemPrompt,
            this.sourceLanguage,
            this.targetLanguage,
            stats,
        );
        this.totalChunks = chunks.length;
        this.currentChunk = 0;

        // ── Choose mode: single-chunk streaming vs multi-chunk batch ─────────
        if (chunks.length <= 1) {
            await this.runSingleChunkTranslation(chunks, srcName, tgtName, codeBlocks, urls, tables, latex);
        } else {
            await this.runBatchTranslation(chunks, srcName, tgtName, codeBlocks, urls, tables, latex);
        }

        // ── Record adaptive stats ────────────────────────────────────────────
        if (this.translatedContent && textWithPlaceholders) {
            const currentStats = this.plugin.settings.translationStats[statsKey] ?? { ratio: 0, samples: 0 };
            this.plugin.settings.translationStats[statsKey] = updateTranslationStats(
                currentStats,
                textWithPlaceholders.length,
                this.translatedContent.length,
            );
            await this.plugin.saveSettings();
        }
    }

    /**
     * Single-chunk mode: stream translation text directly into a plain-text
     * container so the user can watch the output arrive in real time.
     */
    private async runSingleChunkTranslation(
        chunks: string[],
        srcName: string,
        tgtName: string,
        codeBlocks: string[],
        urls: string[],
        tables: string[],
        latex: string[],
    ): Promise<void> {
        if (!this.previewRenderEl || !this.generateBtn) return;

        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 1500;

        // Throttle Markdown re-renders to avoid jank (150ms feels responsive).
        let lastRender = 0;
        const RENDER_INTERVAL = 150;
        let renderPending = false;
        let renderTimer: number | null = null;

        const flushRender = (): void => {
            renderPending = false;
            renderTimer = null;
            // 实时还原占位符后再渲染，避免用户在预览中看到 {{CODE_BLOCK_0}} 这类标记
            let raw = this.translatedContent;
            raw = restoreUrls(raw, urls);
            raw = restoreLatex(raw, latex);
            raw = restoreTables(raw, tables);
            raw = restoreCodeBlocks(raw, codeBlocks);
            this.renderTranslationText(raw);
            // Scroll preview panel to bottom so latest output is visible.
            const previewBody = this.previewRenderEl!.closest(".ml-tr-panel-body") as HTMLElement | null;
            if (previewBody) {
                previewBody.scrollTop = previewBody.scrollHeight;
            }
        };

        const throttledRender = (): void => {
            const now = Date.now();
            if (now - lastRender < RENDER_INTERVAL) {
                if (!renderPending) {
                    renderPending = true;
                    renderTimer = window.setTimeout(() => {
                        lastRender = Date.now();
                        flushRender();
                    }, RENDER_INTERVAL - (now - lastRender));
                }
                return;
            }
            lastRender = now;
            if (renderTimer !== null) { clearTimeout(renderTimer); renderTimer = null; }
            flushRender();
        };

        try {
            const chunkParts: string[] = [];
            let retries = 0;
            let succeeded = false;

            while (retries < MAX_RETRIES && !succeeded) {
                try {
                    chunkParts.length = 0;

                    await streamTranslation(
                        chunks[0],
                        tgtName,
                        srcName,
                        this.plugin.settings,
                        (chunk: string) => {
                            if (!this.isStreaming) return;
                            chunkParts.push(chunk);
                            // 实时保存 + 实时渲染 Markdown
                            const currentText = chunkParts.join("");
                            this.translatedContent = currentText;
                            if (this.previewTextArea) this.previewTextArea.value = currentText;
                            throttledRender();
                        },
                        this.abortController!.signal,
                    );
                    succeeded = true;
                } catch (err) {
                    retries++;
                    if (err instanceof Error && err.name === "AbortError") { throw err; }
                    if (retries >= MAX_RETRIES) {
                        const failedMarker = `\n\n[${t("notice.translate_chunk_failed", { current: 1, total: 1 })}]\n\n`;
                        chunkParts.length = 0;
                        chunkParts.push(failedMarker);
                        this.translatedContent = failedMarker;
                        new Notice(t("notice.translate_chunk_failed_notice", { current: 1 }));
                        break;
                    }
                    await this.sleep(RETRY_DELAY_MS);
                }
            }
        } catch (err) {
            if (err instanceof Error && err.name === "AbortError") {
                /* fall through to finally */
            } else {
                const msg = err instanceof Error ? err.message : String(err);
                new Notice(`Error: ${msg}`);
            }
        } finally {
            this.isStreaming = false;
            this.abortController = null;
            if (renderTimer !== null) { clearTimeout(renderTimer); flushRender(); }

            // 兜底还原占位符
            if (this.translatedContent) {
                let result = restoreUrls(this.translatedContent, urls);
                result = restoreLatex(result, latex);
                result = restoreTables(result, tables);
                result = restoreCodeBlocks(result, codeBlocks);
                this.translatedContent = result;
            }
            this.generateBtn!.setButtonText(t("button.regenerate"));
            this.generateBtn!.buttonEl.removeClass("ml-tr-spinning");
            this.updateGenerateBtnState();
            if (this.previewTextArea) this.previewTextArea.value = this.translatedContent;
            this.renderTranslation();
            this.updateInsertBtnState();
        }
    }

    /**
     * Batch mode: translate multiple chunks concurrently in the background.
     * Chunks are greedily sized; if the model truncates output due to max_tokens,
     * the chunk is automatically split at sentence boundaries and retried.
     * The UI dynamically updates to show newly spawned sub-chunks.
     */
    private async runBatchTranslation(
        chunks: string[],
        srcName: string,
        tgtName: string,
        codeBlocks: string[],
        urls: string[],
        tables: string[],
        latex: string[],
    ): Promise<void> {
        if (!this.previewRenderEl || !this.generateBtn) return;

        // Keep split panel visible so the preview can update in real time.
        const splitEl = this.previewRenderEl.closest(".ml-tr-split") as HTMLElement | null;
        // Insert batch panel before the footer so it sits below the split view.
        const footer = this.contentEl.querySelector(".ml-tr-footer") as HTMLElement | null;

        const batchPanelEl = document.createElement("div");
        batchPanelEl.addClass("ml-tr-batch-panel");
        const batchPanel = footer
            ? this.contentEl.insertBefore(batchPanelEl, footer)
            : this.contentEl.appendChild(batchPanelEl);
        batchPanel.createEl("h3", { text: t("label.batch_translation"), cls: "ml-tr-batch-title" });
        const batchList = batchPanel.createDiv("ml-tr-batch-list");
        const summaryEl = batchPanel.createDiv("ml-tr-batch-summary");

        interface ChunkStatus { chars: number; status: "pending" | "translating" | "done" | "failed" | "splitting"; }

        // Mutable arrays — new chunks may be appended when a chunk is truncated.
        const taskChunks: string[] = [...chunks];
        const results: (string | null)[] = new Array(chunks.length).fill(null);
        const statuses: ChunkStatus[] = chunks.map(() => ({ chars: 0, status: "pending" }));
        // `orders` preserves original document order so split children interleave correctly.
        const orders: number[] = chunks.map((_, i) => i);
        const statusEls: HTMLElement[] = [];
        const retryBtns: HTMLButtonElement[] = [];

        const updateUI = (): void => {
            // Dynamically create UI rows for chunks that were spawned later.
            while (statusEls.length < statuses.length) {
                const i = statusEls.length;
                const row = batchList.createDiv("ml-tr-batch-row");
                row.createEl("span", { text: t("label.chunk_n_of_total", { current: i + 1, total: taskChunks.length }), cls: "ml-tr-batch-label" });
                const statusEl = row.createEl("span", { cls: "ml-tr-batch-status" });
                const retryBtn = row.createEl("button", { text: t("button.retry"), cls: "ml-tr-retry-btn" });
                retryBtn.addClass("ml-tr-hidden");
                retryBtn.addEventListener("click", () => { void retryChunk(i); });
                statusEls.push(statusEl);
                retryBtns.push(retryBtn);
            }

            const doneCount = statuses.filter(s => s.status === "done").length;
            const totalChars = statuses.reduce((sum, s) => sum + s.chars, 0);

            for (let i = 0; i < statuses.length; i++) {
                const s = statuses[i];
                const statusText = s.status === "pending" ? t("label.chunk_status_pending")
                    : s.status === "translating" ? `${t("label.chunk_status_translating")} ${s.chars.toLocaleString()}`
                    : s.status === "splitting" ? `${t("label.chunk_status_splitting")} ${s.chars.toLocaleString()}`
                    : s.status === "done" ? `${t("label.chunk_status_done")} ${s.chars.toLocaleString()}`
                    : `${t("label.chunk_status_failed")} ${s.chars.toLocaleString()}`;
                statusEls[i].setText(statusText);
                statusEls[i].setAttribute("data-status", s.status);

                if (s.status === "failed") {
                    retryBtns[i].removeClass("ml-tr-hidden");
                } else {
                    retryBtns[i].addClass("ml-tr-hidden");
                }
            }

            summaryEl.setText(t("notice.translate_progress", { done: doneCount, total: taskChunks.length, chars: totalChars.toLocaleString() }));
        };
        updateUI();

        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 1500;
        const MAX_SPLIT_DEPTH = 3;
        const concurrency = Math.max(1, Math.min(10, this.plugin.settings.aiConcurrency || 2));
        let nextIndex = 0;
        let abortError: Error | null = null;

        /**
         * Translates a chunk. If the output is truncated by max_tokens, splits
         * the chunk at sentence boundaries and recursively translates the first
         * half while pushing the second half onto the shared task queue.
         */
        const translateChunkRecursive = async (
            text: string,
            index: number,
            depth: number,
            onProgress: (chars: number) => void,
        ): Promise<string> => {
            if (depth > MAX_SPLIT_DEPTH) {
                throw new Error(`Chunk still too large after ${MAX_SPLIT_DEPTH} splits`);
            }

            let result = "";
            let retries = 0;
            let wasTruncated = false;

            while (retries < MAX_RETRIES) {
                result = "";
                wasTruncated = false;

                try {
                    await streamTranslation(
                        text,
                        tgtName,
                        srcName,
                        this.plugin.settings,
                        (chunk: string) => {
                            if (!this.isStreaming) return;
                            result += chunk;
                            onProgress(result.length);
                        },
                        this.abortController!.signal,
                        { current: index + 1, total: taskChunks.length },
                    );
                    // Success
                    return result;
                } catch (err) {
                    retries++;
                    if (err instanceof Error && err.name === "AbortError") {
                        abortError = err;
                        throw err;
                    }
                    const errMsg = err instanceof Error ? err.message : String(err);
                    if (errMsg.includes("truncated by max_tokens")) {
                        wasTruncated = true;
                        break; // Split instead of retrying the same size
                    }
                    if (retries >= MAX_RETRIES) {
                        throw err;
                    }
                    await this.sleep(RETRY_DELAY_MS);
                }
            }

            if (wasTruncated) {
                // Split around the half-way point at sentence boundaries.
                const halfChars = Math.floor(text.length / 2);
                const halves = sliceAtSentenceBoundaries(text, halfChars);

                // Fallback to hard split if sentence boundaries didn't produce 2 pieces.
                if (halves.length < 2) {
                    const mid = Math.floor(text.length / 2);
                    halves.length = 0;
                    halves.push(text.slice(0, mid), text.slice(mid));
                }

                // Show splitting state in the UI.
                statuses[index] = { chars: result.length, status: "splitting" };
                updateUI();

                // Recursively translate first half, reusing the current slot.
                const first = await translateChunkRecursive(halves[0], index, depth + 1, onProgress);

                // Push second half as a new task for the worker pool to pick up.
                const newIndex = taskChunks.length;
                taskChunks.push(halves[1]);
                results.push(null);
                statuses.push({ chars: 0, status: "pending" });
                orders.push(orders[index] + 0.001);

                return first;
            }

            return result;
        };

        const assembleResult = (): void => {
            const parts = results
                .map((result, i) => ({ result, order: orders[i] }))
                .filter(item => item.result !== null)
                .sort((a, b) => a.order - b.order)
                .map(item => item.result!);

            let raw = parts.join("\n\n");
            raw = restoreUrls(raw, urls);
            raw = restoreLatex(raw, latex);
            raw = restoreTables(raw, tables);
            raw = restoreCodeBlocks(raw, codeBlocks);
            this.translatedContent = raw;
        };

        const renderPreview = (): void => {
            assembleResult();
            if (this.previewTextArea) this.previewTextArea.value = this.translatedContent;
            this.renderTranslation();
            this.updateInsertBtnState();
            // Scroll preview to bottom to follow latest content.
            const previewBody = this.previewRenderEl?.closest(".ml-tr-panel-body");
            if (previewBody) {
                previewBody.scrollTop = previewBody.scrollHeight;
            }
        };

        const retryChunk = async (index: number): Promise<void> => {
            if (!this.isStreaming || this.abortController?.signal.aborted) return;

            statuses[index] = { chars: 0, status: "translating" };
            updateUI();

            try {
                const text = await translateChunkRecursive(
                    taskChunks[index],
                    index,
                    0,
                    (chars) => {
                        statuses[index].chars = chars;
                        updateUI();
                    },
                );
                results[index] = text;
                statuses[index].chars = text.length;
                statuses[index].status = "done";
            } catch (err) {
                if (err instanceof Error && err.name === "AbortError") return;
                results[index] = `\n\n[${t("notice.translate_chunk_failed", { current: index + 1, total: taskChunks.length })}]\n\n`;
                statuses[index].status = "failed";
            }

            updateUI();
            renderPreview();
        };

        const worker = async (): Promise<void> => {
            while (nextIndex < taskChunks.length) {
                const i = nextIndex++;
                if (this.abortController?.signal.aborted) return;

                statuses[i] = { chars: 0, status: "translating" };
                updateUI();

                try {
                    const text = await translateChunkRecursive(
                        taskChunks[i],
                        i,
                        0,
                        (chars) => {
                            statuses[i].chars = chars;
                            updateUI();
                        },
                    );
                    results[i] = text;
                    statuses[i].chars = text.length;
                    statuses[i].status = "done";
                } catch (err) {
                    if (err instanceof Error && err.name === "AbortError") {
                        abortError = err;
                        return;
                    }
                    results[i] = `\n\n[${t("notice.translate_chunk_failed", { current: i + 1, total: taskChunks.length })}]\n\n`;
                    statuses[i].status = "failed";
                }

                updateUI();
                // 实时渲染已完成的 chunk，让用户跟随最新流
                renderPreview();
            }
        };

        try {
            const workers = Array.from({ length: concurrency }, () => worker());
            await Promise.all(workers);

            if (abortError) return; // user cancelled — partial output handled in finally

            assembleResult();
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            new Notice(`Error: ${msg}`);
        } finally {
            this.isStreaming = false;
            this.abortController = null;
            batchPanel.remove();
            splitEl?.removeClass("ml-tr-hidden");
            this.generateBtn!.setButtonText(t("button.regenerate"));
            this.generateBtn!.buttonEl.removeClass("ml-tr-spinning");
            this.updateGenerateBtnState();
            if (this.previewTextArea) this.previewTextArea.value = this.translatedContent;
            this.renderTranslation();
            this.updateInsertBtnState();
        }
    }

    private updateChunkButtonText(): void {
        if (!this.generateBtn || this.totalChunks <= 1) return;
        this.generateBtn.setButtonText(
            t("button.translating_chunk", { current: this.currentChunk, total: this.totalChunks })
        );
    }

    private sleep(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private doInsert(): void {
        this.onInsertCallback?.(this.translatedContent, this.targetLanguage);
        this.close();
    }

    onClose(): void {
        this.cancelStream();
        this.renderComponent?.unload();
        this.renderComponent = null;
        this.contentEl.empty();
    }
}
