import { App, Modal, Setting } from "obsidian";
import type MultilingualNotesPlugin from "../../main";
import { t } from "../i18n";

export class ComparisonModal extends Modal {
    private selectedLanguages = new Set<string>();

    constructor(
        app: App,
        private plugin: MultilingualNotesPlugin,
        defaultSelectedLanguages: Set<string>,
        private availableLanguagesStr: string[]
    ) {
        super(app);
        for (const lang of defaultSelectedLanguages) {
            this.selectedLanguages.add(lang);
        }
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass("ml-comparison-modal");

        contentEl.createEl("h2", { text: t("menu.compare_languages") });

        contentEl.createEl("p", {
            text: t("menu.compare_languages_desc"),
            cls: "setting-item-description"
        });

        const activeCodes = this.availableLanguagesStr.length > 0
            ? this.plugin.settings.languages.filter(l => this.availableLanguagesStr.includes(l.code.toLowerCase()))
            : this.plugin.settings.languages;

        for (const lang of activeCodes) {
            const isSelected = this.selectedLanguages.has(lang.code);

            new Setting(contentEl)
                .setName(lang.label)
                .addToggle((toggle) => {
                    toggle.setValue(isSelected).onChange((val) => {
                        if (val) {
                            this.selectedLanguages.add(lang.code);
                        } else {
                            this.selectedLanguages.delete(lang.code);
                            // Prevent unselecting all (must have at least one)
                            if (this.selectedLanguages.size === 0) {
                                this.selectedLanguages.add(lang.code);
                                toggle.setValue(true);
                            }
                        }
                    });
                });
        }

        const buttonContainer = contentEl.createDiv("ml-comparison-btn-row");

        const applyBtn = buttonContainer.createEl("button", { text: t("menu.apply_comparison") });
        applyBtn.addClass("mod-cta");
        applyBtn.style.marginRight = "10px";
        applyBtn.onclick = async () => {
            const primaryLeaf = this.app.workspace.getMostRecentLeaf();
            if (primaryLeaf) {
                // Need to implement startComparison in the plugin or via CompareManager
                await this.plugin.compareManager.startOrUpdateComparison(primaryLeaf, Array.from(this.selectedLanguages));
            }
            this.close();
        };

        const resetBtn = buttonContainer.createEl("button", { text: t("menu.return_normal") });
        resetBtn.onclick = () => {
            this.plugin.compareManager.endComparison(true);
            this.close();
        };
    }

    onClose() {
        this.contentEl.empty();
    }
}
