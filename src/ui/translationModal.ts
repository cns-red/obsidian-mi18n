import { App, Component, Modal, Notice, ButtonComponent, MarkdownRenderer, setIcon } from "obsidian";
import type { MultilingualNotesSettings, LanguageEntry } from "../settings";
import { t } from "../i18n";
import { streamTranslation, splitIntoChunks, extractCodeBlocks, restoreCodeBlocks, extractUrls, restoreUrls, type ChunkInfo } from "../api/ai";

interface TranslationPlugin {
    settings: MultilingualNotesSettings;
    extractLanguageContent(source: string, targetLangCode: string): string;
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

        // ── Extract URLs (prevent model from hallucinating/modifying them) ──
        const { text: textWithPlaceholders, urls } = extractUrls(textWithoutCode);

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
        const chunks = splitIntoChunks(
            textWithPlaceholders,
            aiMaxContext,
            aiMaxTokens,
            this.plugin.settings.aiSystemPrompt,
            this.sourceLanguage,
        );
        this.totalChunks = chunks.length;
        this.currentChunk = 0;

        // ── Choose mode: single-chunk streaming vs multi-chunk batch ─────────
        if (chunks.length <= 1) {
            await this.runSingleChunkTranslation(chunks, srcName, tgtName, codeBlocks, urls);
        } else {
            await this.runBatchTranslation(chunks, srcName, tgtName, codeBlocks, urls);
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
    ): Promise<void> {
        if (!this.previewRenderEl || !this.generateBtn) return;

        this.previewRenderEl.addClass("ml-tr-hidden");
        const streamingEl = this.previewRenderEl.parentElement!.createDiv("ml-tr-streaming-text");
        const textNode = document.createTextNode("");
        streamingEl.appendChild(textNode);

        let allTranslated = "";
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 1500;
        let textBuffer = "";
        let flushTimer: number | null = null;
        let scrollTimer: number | null = null;

        const flushBuffer = (): void => {
            if (textBuffer) {
                textNode.data += textBuffer;
                textBuffer = "";
            }
            flushTimer = null;
        };
        const throttledScroll = (): void => {
            if (scrollTimer !== null) return;
            scrollTimer = window.setTimeout(() => {
                streamingEl.scrollTop = streamingEl.scrollHeight;
                scrollTimer = null;
            }, 100);
        };

        try {
            const chunkParts: string[] = [];
            let retries = 0;
            let succeeded = false;
            const baseLength = textNode.data.length;

            while (retries < MAX_RETRIES && !succeeded) {
                try {
                    if (textNode.data.length > baseLength) {
                        textNode.data = textNode.data.slice(0, baseLength);
                    }
                    chunkParts.length = 0;
                    if (flushTimer !== null) { clearTimeout(flushTimer); flushTimer = null; }
                    textBuffer = "";

                    await streamTranslation(
                        chunks[0],
                        tgtName,
                        srcName,
                        this.plugin.settings,
                        (chunk: string) => {
                            if (!this.isStreaming) return;
                            chunkParts.push(chunk);
                            textBuffer += chunk;
                            if (flushTimer === null) {
                                flushTimer = window.setTimeout(flushBuffer, 50);
                            }
                            throttledScroll();
                        },
                        this.abortController!.signal,
                    );
                    succeeded = true;
                } catch (err) {
                    retries++;
                    if (err instanceof Error && err.name === "AbortError") { throw err; }
                    if (retries >= MAX_RETRIES) {
                        if (textNode.data.length > baseLength) {
                            textNode.data = textNode.data.slice(0, baseLength);
                        }
                        const failedMarker = `\n\n[${t("notice.translate_chunk_failed", { current: 1, total: 1 })}]\n\n`;
                        chunkParts.length = 0;
                        chunkParts.push(failedMarker);
                        textNode.data += failedMarker;
                        new Notice(t("notice.translate_chunk_failed_notice", { current: 1 }));
                        break;
                    }
                    await this.sleep(RETRY_DELAY_MS);
                }
            }

            if (flushTimer !== null) { clearTimeout(flushTimer); flushBuffer(); }
            allTranslated += chunkParts.join("");
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
            if (flushTimer !== null) { clearTimeout(flushTimer); flushBuffer(); }
            if (scrollTimer !== null) { clearTimeout(scrollTimer); }

            const rawOutput = textNode.data;
            if (rawOutput) {
                let result = restoreUrls(rawOutput, urls);
                result = restoreCodeBlocks(result, codeBlocks);
                this.translatedContent = result;
            }
            streamingEl.remove();
            this.previewRenderEl!.removeClass("ml-tr-hidden");
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
     * No Markdown is rendered during streaming — only per-chunk character counts
     * are shown so the user knows the model is still alive.
     */
    private async runBatchTranslation(
        chunks: string[],
        srcName: string,
        tgtName: string,
        codeBlocks: string[],
        urls: string[],
    ): Promise<void> {
        if (!this.previewRenderEl || !this.generateBtn) return;

        // Hide the split panel, show the batch status panel
        const splitEl = this.previewRenderEl.closest(".ml-tr-split") as HTMLElement | null;
        splitEl?.addClass("ml-tr-hidden");

        const batchPanel = this.contentEl.createDiv("ml-tr-batch-panel");
        batchPanel.createEl("h3", { text: t("label.batch_translation"), cls: "ml-tr-batch-title" });
        const batchList = batchPanel.createDiv("ml-tr-batch-list");
        const summaryEl = batchPanel.createDiv("ml-tr-batch-summary");

        interface ChunkStatus { chars: number; status: "pending" | "translating" | "done" | "failed"; }
        const statuses: ChunkStatus[] = chunks.map(() => ({ chars: 0, status: "pending" }));
        const statusEls: HTMLElement[] = [];

        for (let i = 0; i < chunks.length; i++) {
            const row = batchList.createDiv("ml-tr-batch-row");
            row.createEl("span", { text: t("label.chunk_n_of_total", { current: i + 1, total: chunks.length }), cls: "ml-tr-batch-label" });
            const statusEl = row.createEl("span", { cls: "ml-tr-batch-status" });
            statusEls.push(statusEl);
        }

        const updateUI = (): void => {
            const doneCount = statuses.filter(s => s.status === "done").length;
            const totalChars = statuses.reduce((sum, s) => sum + s.chars, 0);
            for (let i = 0; i < chunks.length; i++) {
                const s = statuses[i];
                const statusText = s.status === "pending" ? t("label.chunk_status_pending")
                    : s.status === "translating" ? `${t("label.chunk_status_translating")} ${s.chars.toLocaleString()}`
                    : s.status === "done" ? `${t("label.chunk_status_done")} ${s.chars.toLocaleString()}`
                    : `${t("label.chunk_status_failed")} ${s.chars.toLocaleString()}`;
                statusEls[i].setText(statusText);
                statusEls[i].setAttribute("data-status", s.status);
            }
            summaryEl.setText(t("notice.translate_progress", { done: doneCount, total: chunks.length, chars: totalChars.toLocaleString() }));
        };
        updateUI();

        const results: (string | null)[] = new Array(chunks.length).fill(null);
        const MAX_RETRIES = 3;
        const RETRY_DELAY_MS = 1500;
        const concurrency = Math.max(1, Math.min(10, this.plugin.settings.aiConcurrency || 2));
        let nextIndex = 0;
        let abortError: Error | null = null;

        const worker = async (): Promise<void> => {
            while (nextIndex < chunks.length) {
                const i = nextIndex++;
                if (this.abortController?.signal.aborted) return;

                statuses[i] = { chars: 0, status: "translating" };
                updateUI();

                const chunkParts: string[] = [];
                let retries = 0;
                let succeeded = false;

                while (retries < MAX_RETRIES && !succeeded) {
                    try {
                        chunkParts.length = 0;
                        await streamTranslation(
                            chunks[i],
                            tgtName,
                            srcName,
                            this.plugin.settings,
                            (chunk: string) => {
                                if (!this.isStreaming) return;
                                chunkParts.push(chunk);
                                statuses[i].chars = chunkParts.join("").length;
                                updateUI();
                            },
                            this.abortController!.signal,
                            { current: i + 1, total: chunks.length },
                        );
                        succeeded = true;
                    } catch (err) {
                        retries++;
                        if (err instanceof Error && err.name === "AbortError") {
                            abortError = err;
                            return;
                        }
                        if (retries >= MAX_RETRIES) {
                            const failedMarker = `\n\n[${t("notice.translate_chunk_failed", { current: i + 1, total: chunks.length })}]\n\n`;
                            chunkParts.length = 0;
                            chunkParts.push(failedMarker);
                            break;
                        }
                        await this.sleep(RETRY_DELAY_MS);
                    }
                }

                results[i] = chunkParts.join("");
                statuses[i].chars = results[i]!.length;
                statuses[i].status = succeeded ? "done" : "failed";
                updateUI();
            }
        };

        try {
            const workers = Array.from({ length: concurrency }, () => worker());
            await Promise.all(workers);

            if (abortError) return; // user cancelled — partial output handled in finally

            // Join results with double-newlines between successful chunks
            const parts: string[] = [];
            for (let i = 0; i < results.length; i++) {
                if (results[i] !== null) parts.push(results[i]!);
            }
            let raw = parts.join("\n\n");
            raw = restoreUrls(raw, urls);
            raw = restoreCodeBlocks(raw, codeBlocks);
            this.translatedContent = raw;
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
