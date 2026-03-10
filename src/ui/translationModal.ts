import { App, Modal, Notice, ButtonComponent, MarkdownRenderer } from "obsidian";
import MultilingualNotesPlugin from "../../main";
import { t } from "../i18n";
import { streamTranslation } from "../api/ai";
import { LanguageEntry } from "../settings";

export class TranslationModal extends Modal {
    private plugin: MultilingualNotesPlugin;
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

    public onInsertCallback: ((text: string, targetLangCode: string) => void) | null = null;

    constructor(
        app: App,
        plugin: MultilingualNotesPlugin,
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

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

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
        srcGroup.createEl("span", { text: t("settings.source_language") || "Source Language", cls: "ml-tr-lang-label" });
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
        tgtGroup.createEl("span", { text: t("settings.target_language") || "Target Language", cls: "ml-tr-lang-label" });
        const tgtSelect = tgtGroup.createEl("select", { cls: "ml-tr-select" });

        const targetLangs = this.plugin.settings.languages.filter(
            l => !this.noteExistingLanguages.has(l.code.toLowerCase())
        );
        if (targetLangs.length === 0) {
            tgtSelect.createEl("option", {
                text: t("notice.fully_internationalized") || "All languages covered",
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
            .setButtonText(t("button.translate") || "Translate")
            .setCta()
            .onClick(() => this.runStreamTranslation());
        this.generateBtn.buttonEl.addClass("ml-tr-generate-btn");
        this.updateGenerateBtnState();

        // ── Split Panel ───────────────────────────────────────────────────────
        const split = contentEl.createDiv("ml-tr-split");

        // Left: Source
        const srcPanel = split.createDiv("ml-tr-panel");
        const srcHead = srcPanel.createDiv("ml-tr-panel-head");
        srcHead.createEl("span", { text: t("label.source_text") || "Source", cls: "ml-tr-panel-label" });
        this.sourceRenderEl = srcPanel.createDiv("ml-tr-panel-body ml-tr-preview");
        this.updateSourcePreview();

        // Right: Translation
        const tgtPanel = split.createDiv("ml-tr-panel");
        const tgtHead = tgtPanel.createDiv("ml-tr-panel-head");
        tgtHead.createEl("span", { text: t("label.translation") || "Translation", cls: "ml-tr-panel-label" });

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

        this.previewTextArea = tgtBody.createEl("textarea", { cls: "ml-tr-textarea" });
        this.previewTextArea.placeholder = t("placeholder.translation_preview") ||
            "Click Translate to generate. You can edit the result before inserting.";
        this.previewTextArea.value = this.translatedContent;
        this.previewTextArea.style.display = "none";
        this.previewTextArea.addEventListener("input", () => {
            this.translatedContent = this.previewTextArea!.value;
            this.renderTranslation();
            this.updateInsertBtnState();
        });

        // ── Footer ────────────────────────────────────────────────────────────
        const footer = contentEl.createDiv("ml-tr-footer");

        new ButtonComponent(footer)
            .setButtonText(t("button.cancel") || "Cancel")
            .onClick(() => {
                this.isStreaming = false;
                this.close();
            });

        this.insertBtn = new ButtonComponent(footer)
            .setButtonText(t("button.insert") || "Insert")
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

    private setEditBtnIcon(el: HTMLElement, editing: boolean) {
        el.empty();
        if (editing) {
            // eye icon
            el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
            el.setAttribute("data-active", "true");
        } else {
            // pencil icon
            el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
            el.removeAttribute("data-active");
        }
    }

    private syncViewMode() {
        if (!this.previewRenderEl || !this.previewTextArea) return;
        if (this.isEditMode) {
            this.previewRenderEl.style.display = "none";
            this.previewTextArea.style.display = "flex";
        } else {
            this.previewRenderEl.style.display = "block";
            this.previewTextArea.style.display = "none";
        }
    }

    private stripFrontmatter(content: string): string {
        const match = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
        return match ? content.slice(match[0].length) : content;
    }

    private updateSourcePreview() {
        if (!this.sourceRenderEl) return;
        this.sourceRenderEl.empty();
        this.extractedSourceContent = this.stripFrontmatter(
            this.plugin.extractLanguageContent(this.sourceContent, this.sourceLanguage)
        );
        MarkdownRenderer.render(
            this.app,
            this.extractedSourceContent || "_No source text found for this language._",
            this.sourceRenderEl, "", this.plugin
        );
    }

    private renderTranslation() {
        if (!this.previewRenderEl) return;
        this.previewRenderEl.empty();
        MarkdownRenderer.render(
            this.app,
            this.translatedContent || "_Translation will appear here…_",
            this.previewRenderEl, "", this.plugin
        );
    }

    private updateGenerateBtnState() {
        this.generateBtn?.setDisabled(!this.targetLanguage || !this.sourceLanguage || this.isStreaming);
    }

    private updateInsertBtnState() {
        this.insertBtn?.setDisabled(!this.translatedContent.trim() || this.isStreaming);
    }

    private async runStreamTranslation() {
        if (!this.generateBtn || !this.previewTextArea) return;

        this.isStreaming = true;
        this.translatedContent = "";
        this.previewTextArea.value = "";
        this.renderTranslation();

        this.generateBtn.setButtonText(t("button.translating") || "Translating…");
        this.generateBtn.buttonEl.addClass("ml-tr-spinning");
        this.updateGenerateBtnState();
        this.updateInsertBtnState();

        // Switch to preview mode during streaming
        if (this.isEditMode) {
            this.isEditMode = false;
            this.syncViewMode();
        }

        // Add streaming cursor
        this.previewRenderEl?.addClass("ml-tr-streaming");

        try {
            const srcName = this.plugin.settings.languages.find(
                (l: LanguageEntry) => l.code.toLowerCase() === this.sourceLanguage
            )?.label || this.sourceLanguage;
            const tgtName = this.plugin.settings.languages.find(
                (l: LanguageEntry) => l.code === this.targetLanguage
            )?.label || this.targetLanguage;

            await streamTranslation(
                this.extractedSourceContent, tgtName, srcName, this.plugin.settings,
                (chunk: string) => {
                    if (!this.isStreaming) return;
                    this.translatedContent += chunk;
                    window.requestAnimationFrame(() => {
                        this.renderTranslation();
                        // Auto-scroll to bottom as content streams in
                        if (this.previewRenderEl) {
                            this.previewRenderEl.scrollTop = this.previewRenderEl.scrollHeight;
                        }
                    });
                }
            );
        } catch (err: any) {
            new Notice(`Error: ${err.message}`);
        } finally {
            this.isStreaming = false;
            this.previewRenderEl?.removeClass("ml-tr-streaming");
            this.generateBtn.setButtonText(t("button.regenerate") || "Regenerate");
            this.generateBtn.buttonEl.removeClass("ml-tr-spinning");
            this.updateGenerateBtnState();
            if (this.previewTextArea) this.previewTextArea.value = this.translatedContent;
            this.renderTranslation();
            this.updateInsertBtnState();
        }
    }

    private doInsert() {
        this.onInsertCallback?.(this.translatedContent, this.targetLanguage);
        this.close();
    }

    onClose() {
        this.isStreaming = false;
        this.contentEl.empty();
    }
}
