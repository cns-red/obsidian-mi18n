const en = {
  ribbon: {
    switch_language: "Multilingual Notes — switch language",
  },
  status_bar: {
    click_to_switch: "Click to switch language",
    all_languages: "All languages",
  },
  menu: {
    show_all_languages: "Show all languages",
    multilingual: "Multilingual",
    wrap: "Wrap",
    smart_insert: "Smart insert",
    manual_insert: "Manual insert",
    existing_lang_prefix: "✓ {label}",
  },
  command: {
    switch_language: "Switch language: {label}",
    switch_show_all: "Switch language: Show all languages",
    cycle_next: "Cycle to next language",
    insert_lang_block: "Insert language block",
    wrap_selection: "Wrap selection in language block",
    insert_template: "Insert multilingual block template (all languages)",
  },
  notice: {
    language_switched: "Language switched to {label}",
    showing_all_blocks: "Showing all language blocks",
    select_text_first: "Select some text first.",
    current_language: "Language: {label}",
    inserted_block: "Inserted {label} block",
    fully_internationalized: "✓ Fully internationalized",
    keep_one_language: "You must keep at least one language.",
  },
  settings: {
    title: "i8n — Settings",
    active_language_name: "Active language",
    active_language_desc: "The language currently shown across all notes.",
    default_language_name: "Default language",
    default_language_desc:
      "Language assumed when a note has no lang markers at all. Switching to any other language will make such notes invisible.",
    hide_other_name: "Hide other languages in editor",
    hide_other_desc:
      "When ON: non-active language blocks are collapsed to a thin bar in editing mode — you can only type in the current language. When OFF: all language blocks are shown normally in the editor so you can freely read and edit every translation.",
    show_badges_name: "Show language badges in reading mode",
    show_badges_desc: "Display a small label above each visible language block in reading mode.",
    configured_languages_title: "Configured Languages",
    configured_languages_desc:
      'Add, remove or rename language entries. The "code" must exactly match the code you use in your lang markers.',
    add_language_name: "Add a new language",
    add_language_button: "+ Add language",
    syntax_title: "Syntax Reference",
    syntax_desc: "All four syntaxes are equivalent. Choose the one that best fits your workflow.",
    copy: "Copy",
    copied: "Copied!",
    no_marker_title: "💡 Notes without any lang markers",
    no_marker_desc:
      "A note that contains no lang markers is treated as being written entirely in the Default Language above. Switching to a different language will make the whole note invisible — this is intentional, since the note has no translation for that language.",
    language_row: "Language #{index}",
    remove_language_tooltip: "Remove this language",
    code_placeholder: "code, e.g. zh-CN",
    label_placeholder: "label, e.g. 简体中文",
    syntax_sample_content: "内容 / Content",
    syntax: {
      default_title: "Default (Obsidian fenced-div style)",
      default_note: "Recommended. Works natively in Obsidian and renders correctly in most Markdown previewers.",
      hexo_title: "Hexo / template-tag style",
      hexo_note: "Visible in reading mode. Compatible with Hexo and similar static-site generators.",
      comment_title: "Markdown comment (link-reference hack)",
      comment_note:
        "Completely invisible in Obsidian reading mode — ideal for clean documents. The lang code goes in the parentheses.",
      obsidian_comment_title: "Obsidian comment style",
      obsidian_comment_note: "Completely invisible in Obsidian (comment syntax). Also hidden in Live Preview.",
    },
  },
} as const;

export default en;
