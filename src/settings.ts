import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MultilingualNotesPlugin from "../main";

// ─── Data structures ───────────────────────────────────────────────────────

export interface LanguageEntry {
  code: string;   // e.g. "zh-CN"
  label: string;  // e.g. "简体中文"
}

export interface MultilingualNotesSettings {
  /** Currently active language code, or "ALL" to show everything */
  activeLanguage: string;
  /** Ordered list of languages the user has configured */
  languages: LanguageEntry[];
  /** Language code to use when a note is opened fresh */
  defaultLanguage: string;
  /** Whether editing mode hides or just dims other-language blocks */
  hideInEditor: boolean;
  /** Show inline language label badges in reading mode */
  showLangBadges: boolean;
}

export const DEFAULT_SETTINGS: MultilingualNotesSettings = {
  activeLanguage: "en",
  languages: [
    { code: "zh-CN", label: "简体中文" },
    { code: "en",    label: "English"  },
    { code: "ja",    label: "日本語"   },
    { code: "fr",    label: "Français" },
  ],
  defaultLanguage: "en",
  hideInEditor: true,
  showLangBadges: true,
};

// ─── Syntax examples (shown in settings UI and README) ─────────────────────

export const SYNTAX_EXAMPLES = [
  {
    title: "Default (Obsidian fenced-div style)",
    open:  ":::lang zh-CN",
    close: ":::",
    note:  "Recommended. Works natively in Obsidian and renders correctly in most Markdown previewers.",
  },
  {
    title: "Hexo / template-tag style",
    open:  "{% i8n zh-CN %}",
    close: "{% endi8n %}",
    note:  "Visible in reading mode. Compatible with Hexo and similar static-site generators.",
  },
  {
    title: "Markdown comment (link-reference hack)",
    open:  "[//]: # (lang zh-CN)",
    close: "[//]: # ()",
    note:  "Completely invisible in Obsidian reading mode — ideal for clean documents. The lang code goes in the parentheses.",
  },
  {
    title: "Obsidian comment style",
    open:  "%% lang zh-CN %%",
    close: "%% end %%",
    note:  "Completely invisible in Obsidian (comment syntax). Also hidden in Live Preview.",
  },
] as const;

// ─── Settings Tab ─────────────────────────────────────────────────────────

export class MultilingualNotesSettingTab extends PluginSettingTab {
  plugin: MultilingualNotesPlugin;

  constructor(app: App, plugin: MultilingualNotesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "i8n — Settings" });

    // ── Active Language ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Active language")
      .setDesc("The language currently shown across all notes.")
      .addDropdown((drop) => {
        drop.addOption("ALL", "Show all languages");
        for (const lang of this.plugin.settings.languages) {
          drop.addOption(lang.code, lang.label);
        }
        drop.setValue(this.plugin.settings.activeLanguage);
        drop.onChange(async (value) => {
          await this.plugin.setActiveLanguage(value);
        });
      });

    // ── Default Language ─────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Default language")
      .setDesc(
        "Language assumed when a note has no lang markers at all. " +
        "Switching to any other language will make such notes invisible."
      )
      .addDropdown((drop) => {
        for (const lang of this.plugin.settings.languages) {
          drop.addOption(lang.code, lang.label);
        }
        drop.setValue(this.plugin.settings.defaultLanguage);
        drop.onChange(async (value) => {
          this.plugin.settings.defaultLanguage = value;
          await this.plugin.saveSettings();
        });
      });

    // ── Hide in Editor ───────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Hide other languages in editor")
      .setDesc(
        "When ON: non-active language blocks are collapsed to a thin bar in editing mode — " +
        "you can only type in the current language. " +
        "When OFF: all language blocks are shown normally in the editor so you can freely read and edit every translation."
      )
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hideInEditor);
        toggle.onChange(async (value) => {
          this.plugin.settings.hideInEditor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        });
      });

    // ── Language badges ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName("Show language badges in reading mode")
      .setDesc("Display a small label above each visible language block in reading mode.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLangBadges);
        toggle.onChange(async (value) => {
          this.plugin.settings.showLangBadges = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        });
      });

    // ── Language list ────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Configured Languages" });
    containerEl.createEl("p", {
      text: 'Add, remove or rename language entries. The "code" must exactly match the code you use in your lang markers.',
      cls: "setting-item-description",
    });

    const listContainer = containerEl.createDiv("ml-lang-list");
    this.renderLanguageList(listContainer);

    new Setting(containerEl)
      .setName("Add a new language")
      .addButton((btn) => {
        btn.setButtonText("+ Add language").onClick(() => {
          this.plugin.settings.languages.push({ code: "xx", label: "New Language" });
          this.plugin.saveSettings().then(() => {
            listContainer.empty();
            this.renderLanguageList(listContainer);
          });
        });
      });

    // ── Syntax Reference ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: "Syntax Reference" });
    containerEl.createEl("p", {
      text: "All four syntaxes are equivalent. Choose the one that best fits your workflow.",
      cls: "setting-item-description",
    });

    for (const ex of SYNTAX_EXAMPLES) {
      const wrap = containerEl.createDiv("ml-syntax-example");

      // Title + note
      const header = wrap.createDiv("ml-syntax-header");
      header.createEl("strong", { text: ex.title });
      header.createEl("span", { text: "  —  " + ex.note, cls: "ml-syntax-note" });

      // Code block
      const pre = wrap.createEl("pre", { cls: "ml-syntax-code" });
      const langCode = this.plugin.settings.languages[0]?.code ?? "zh-CN";
      const sample = `${ex.open.replace("zh-CN", langCode)}\n内容 / Content\n${ex.close}`;
      pre.createEl("code", { text: sample });

      // Copy button
      const copyBtn = wrap.createEl("button", {
        text: "Copy",
        cls: "ml-syntax-copy-btn",
      });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(sample).then(() => {
          copyBtn.textContent = "Copied!";
          setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
        });
      });
    }

    // ── Tip: no-marker notes ─────────────────────────────────────────────
    const tipBox = containerEl.createDiv("ml-tip-box");
    tipBox.createEl("strong", { text: "💡 Notes without any lang markers" });
    tipBox.createEl("p", {
      text:
        "A note that contains no lang markers is treated as being written entirely " +
        "in the Default Language above. Switching to a different language will make the " +
        "whole note invisible — this is intentional, since the note has no translation for that language.",
    });
  }

  private renderLanguageList(container: HTMLElement): void {
    container.empty();

    this.plugin.settings.languages.forEach((lang, index) => {
      const row = new Setting(container)
        .addText((text) => {
          text
            .setPlaceholder("code, e.g. zh-CN")
            .setValue(lang.code)
            .onChange(async (value) => {
              this.plugin.settings.languages[index].code = value.trim();
              await this.plugin.saveSettings();
              this.plugin.refreshStatusBar();
            });
          text.inputEl.style.width = "90px";
        })
        .addText((text) => {
          text
            .setPlaceholder("label, e.g. 简体中文")
            .setValue(lang.label)
            .onChange(async (value) => {
              this.plugin.settings.languages[index].label = value;
              await this.plugin.saveSettings();
              this.plugin.refreshStatusBar();
            });
          text.inputEl.style.width = "130px";
        })
        .addButton((btn) => {
          btn
            .setIcon("trash")
            .setTooltip("Remove this language")
            .setClass("mod-warning")
            .onClick(async () => {
              if (this.plugin.settings.languages.length <= 1) {
                new Notice("You must keep at least one language.");
                return;
              }
              this.plugin.settings.languages.splice(index, 1);
              const codes = this.plugin.settings.languages.map((l) => l.code);
              if (!codes.includes(this.plugin.settings.activeLanguage)) {
                this.plugin.settings.activeLanguage = codes[0];
              }
              await this.plugin.saveSettings();
              container.empty();
              this.renderLanguageList(container);
              this.plugin.refreshStatusBar();
            });
        });
      row.setName(`Language #${index + 1}`);
    });
  }
}
