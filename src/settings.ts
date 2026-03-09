import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type MultilingualNotesPlugin from "../main";
import { t } from "./i18n";

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
  /** Show language selector bar at top of multilingual notes in reading mode */
  showLangHeader: boolean;
  /** Show the ribbon icon button in the left sidebar */
  showRibbon: boolean;
  /** Show the active-language indicator in the bottom status bar */
  showStatusBar: boolean;

  // ─── AI Translation ─────────────────────────────────────────────────────────
  /** OpenAI-compatible API base URL */
  aiApiBase: string;
  /** API Key for the AI service */
  aiApiKey: string;
  /** AI Model to use for translation */
  aiModel: string;
  /** System prompt for the translation task */
  aiSystemPrompt: string;
}

export const DEFAULT_SETTINGS: MultilingualNotesSettings = {
  activeLanguage: "en",
  languages: [
    { code: "zh-CN", label: "简体中文" },
    { code: "en", label: "English" },
    { code: "ja", label: "日本語" },
    { code: "fr", label: "Français" },
  ],
  defaultLanguage: "en",
  hideInEditor: true,
  showLangHeader: true,
  showRibbon: true,
  showStatusBar: true,

  aiApiBase: "https://api.openai.com/v1",
  aiApiKey: "",
  aiModel: "gpt-4o-mini",
  aiSystemPrompt: "You are an expert translator. Translate the provided Markdown text into the target language. Output ONLY the translated text, block for block, preserving all Markdown formatting, frontmatter, and code blocks exactly. Do not add any conversational filler or explain your translation.",
};

// ─── Syntax examples (shown in settings UI and README) ─────────────────────

export const SYNTAX_EXAMPLES = [
  {
    titleKey: "settings.syntax.default_title",
    open: ":::lang zh-CN",
    close: ":::",
    noteKey: "settings.syntax.default_note",
  },
  {
    titleKey: "settings.syntax.hexo_title",
    open: "{% i8n zh-CN %}",
    close: "{% endi8n %}",
    noteKey: "settings.syntax.hexo_note",
  },
  {
    titleKey: "settings.syntax.comment_title",
    open: "[//]: # (lang zh-CN)",
    close: "[//]: # ()",
    noteKey: "settings.syntax.comment_note",
  },
  {
    titleKey: "settings.syntax.obsidian_comment_title",
    open: "%% lang zh-CN %%",
    close: "%% end %%",
    noteKey: "settings.syntax.obsidian_comment_note",
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

    containerEl.createEl("h2", { text: t("settings.title") });

    // ── Active Language ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t("settings.active_language_name"))
      .setDesc(t("settings.active_language_desc"))
      .addDropdown((drop) => {
        drop.addOption("ALL", t("menu.show_all_languages"));
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
      .setName(t("settings.default_language_name"))
      .setDesc(t("settings.default_language_desc"))
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
      .setName(t("settings.hide_other_name"))
      .setDesc(t("settings.hide_other_desc"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.hideInEditor);
        toggle.onChange(async (value) => {
          this.plugin.settings.hideInEditor = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        });
      });

    // ── Language header ──────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t("settings.show_lang_header_name"))
      .setDesc(t("settings.show_lang_header_desc"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showLangHeader);
        toggle.onChange(async (value) => {
          this.plugin.settings.showLangHeader = value;
          await this.plugin.saveSettings();
          this.plugin.refreshAllViews();
        });
      });

    // ── Ribbon button ────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t("settings.show_ribbon_name"))
      .setDesc(t("settings.show_ribbon_desc"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showRibbon);
        toggle.onChange(async (value) => {
          this.plugin.settings.showRibbon = value;
          await this.plugin.saveSettings();
          this.plugin.refreshRibbon();
        });
      });

    // ── Status bar ───────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName(t("settings.show_status_bar_name"))
      .setDesc(t("settings.show_status_bar_desc"))
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.showStatusBar);
        toggle.onChange(async (value) => {
          this.plugin.settings.showStatusBar = value;
          await this.plugin.saveSettings();
          this.plugin.refreshStatusBar();
        });
      });

    // ── Language list ────────────────────────────────────────────────────
    containerEl.createEl("h3", { text: t("settings.configured_languages_title") });
    containerEl.createEl("p", {
      text: t("settings.configured_languages_desc"),
      cls: "setting-item-description",
    });

    const listContainer = containerEl.createDiv("ml-lang-list");
    this.renderLanguageList(listContainer);

    new Setting(containerEl)
      .setName(t("settings.add_language_name"))
      .addButton((btn) => {
        btn.setButtonText(t("settings.add_language_button")).onClick(() => {
          this.plugin.settings.languages.push({ code: "xx", label: "New Language" });
          this.plugin.saveSettings().then(() => {
            listContainer.empty();
            this.renderLanguageList(listContainer);
          });
        });
      });

    // ── Syntax Reference ─────────────────────────────────────────────────
    containerEl.createEl("h3", { text: t("settings.syntax_title") });
    containerEl.createEl("p", {
      text: t("settings.syntax_desc"),
      cls: "setting-item-description",
    });

    for (const ex of SYNTAX_EXAMPLES) {
      const wrap = containerEl.createDiv("ml-syntax-example");

      // Title + note
      const header = wrap.createDiv("ml-syntax-header");
      header.createEl("strong", { text: t(ex.titleKey) });
      header.createEl("span", { text: "  —  " + t(ex.noteKey), cls: "ml-syntax-note" });

      // Code block
      const pre = wrap.createEl("pre", { cls: "ml-syntax-code" });
      const langCode = this.plugin.settings.languages[0]?.code ?? "zh-CN";
      const sample = `${ex.open.replace("zh-CN", langCode)}\n${t("settings.syntax_sample_content")}\n${ex.close}`;
      pre.createEl("code", { text: sample });

      // Copy button
      const copyBtn = wrap.createEl("button", {
        text: t("settings.copy"),
        cls: "ml-syntax-copy-btn",
      });
      copyBtn.addEventListener("click", () => {
        navigator.clipboard.writeText(sample).then(() => {
          copyBtn.textContent = t("settings.copied");
          setTimeout(() => { copyBtn.textContent = t("settings.copy"); }, 1500);
        });
      });
    }

    // ── Tip: no-marker notes ─────────────────────────────────────────────
    const tipBox = containerEl.createDiv("ml-tip-box");
    tipBox.createEl("strong", { text: t("settings.no_marker_title") });
    tipBox.createEl("p", {
      text: t("settings.no_marker_desc"),
    });

    // ── AI Translation ───────────────────────────────────────────────────
    containerEl.createEl("h2", { text: t("settings.ai_translation_title") });

    new Setting(containerEl)
      .setName(t("settings.ai_api_base_name"))
      .setDesc(t("settings.ai_api_base_desc"))
      .addText((text) => {
        text
          .setPlaceholder("https://api.openai.com/v1")
          .setValue(this.plugin.settings.aiApiBase)
          .onChange(async (value) => {
            this.plugin.settings.aiApiBase = value.trim() || "https://api.openai.com/v1";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.ai_api_key_name"))
      .setDesc(t("settings.ai_api_key_desc"))
      .addText((text) => {
        text
          .setPlaceholder("sk-...")
          .setValue(this.plugin.settings.aiApiKey)
          .onChange(async (value) => {
            this.plugin.settings.aiApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName(t("settings.ai_model_name"))
      .setDesc(t("settings.ai_model_desc"))
      .addText((text) => {
        text
          .setPlaceholder("gpt-4o-mini")
          .setValue(this.plugin.settings.aiModel)
          .onChange(async (value) => {
            this.plugin.settings.aiModel = value.trim() || "gpt-4o-mini";
            await this.plugin.saveSettings();
          });
      });

    new Setting(containerEl)
      .setName(t("settings.ai_system_prompt_name"))
      .setDesc(t("settings.ai_system_prompt_desc"))
      .addTextArea((text) => {
        text
          .setPlaceholder("You are an expert translator...")
          .setValue(this.plugin.settings.aiSystemPrompt)
          .onChange(async (value) => {
            this.plugin.settings.aiSystemPrompt = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 4;
        text.inputEl.style.width = "100%";
      });
  }

  private renderLanguageList(container: HTMLElement): void {
    container.empty();

    this.plugin.settings.languages.forEach((lang, index) => {
      const row = new Setting(container)
        .addText((text) => {
          text
            .setPlaceholder(t("settings.code_placeholder"))
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
            .setPlaceholder(t("settings.label_placeholder"))
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
            .setTooltip(t("settings.remove_language_tooltip"))
            .setClass("mod-warning")
            .onClick(async () => {
              if (this.plugin.settings.languages.length <= 1) {
                new Notice(t("notice.keep_one_language"));
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
      row.setName(t("settings.language_row", { index: index + 1 }));
    });
  }
}
