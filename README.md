# i8n — Obsidian Plugin

> **"i8n"** is short for *internationalisation* (18 letters between *i* and *n*, shortened to 8).

Write every language version of your content inside a **single** Markdown file.
A global language switcher instantly hides all other language blocks so you only ever see the language you need — in both reading mode and live preview.

---

## Features

- One note, all languages — no duplicate files
- Four supported syntax styles (fenced-div, Hexo, Markdown comment, Obsidian comment)
- Per-note frontmatter override (`lang: zh-CN`)
- Notes without any lang markers are treated as the configured default language
- Ribbon button, status bar, Command Palette, and `Alt+L` hotkey for switching
- Works in Reading mode, Live Preview, and Source mode

---

## Installation

### From BRAT (beta)
1. Install the [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat).
2. Add this repository URL via BRAT → **Add Beta Plugin**.

### Manual
1. Download the latest release assets: `main.js`, `manifest.json`, `styles.css`.
2. Place them in `<vault>/.obsidian/plugins/i8n/`.
3. Reload Obsidian and enable **i8n** in **Settings → Community plugins**.

---

## Syntax

Wrap any content inside a lang block. All four styles are fully equivalent — mix and match freely within the same note.

### 1 · Default (fenced-div style) — recommended

Renders as a plain paragraph in Obsidian; hidden by the plugin.

```
:::lang zh-CN
这是中文版本的内容。
:::

:::lang en
This is the English version.
:::
```

### 2 · Hexo / template-tag style

Useful if you also publish to a Hexo-powered static site.

```
{% i8n zh-CN %}
这是中文版本的内容。
{% endi8n %}

{% i8n en %}
This is the English version.
{% endi8n %}
```

### 3 · Markdown comment style (invisible)

`[//]: # (...)` is a standard Markdown link-reference hack.
Obsidian **never renders** these lines — the markers are completely invisible in reading mode.

```
[//]: # (lang zh-CN)
这是中文版本的内容。
[//]: # ()

[//]: # (lang en)
This is the English version.
[//]: # ()
```

### 4 · Obsidian comment style (invisible)

`%% ... %%` is Obsidian's native comment syntax — invisible in reading mode and live preview.

```
%% lang zh-CN %%
这是中文版本的内容。
%% end %%

%% lang en %%
This is the English version.
%% end %%
```

### Rules that apply to all styles

- Open and close markers must each be on their own line with no leading spaces.
- Language blocks can appear anywhere in the file, interspersed with normal Markdown.
- Content **outside** any lang block is always visible regardless of the active language.
- The language code is case-sensitive and must match exactly what you configure in Settings.

---

## Notes Without Lang Markers

If a note contains **no** lang markers at all, the plugin treats the **entire note** as being written in the configured *Default Language*.

- Active language = default → note is fully visible (normal behaviour).
- Active language ≠ default → note is completely hidden (it has no translation for that language).

This lets you keep older notes that haven't been localised yet without breaking the workflow.

---

## Per-Note Language Override

Add a `lang` key to a note's YAML frontmatter to lock that note to a specific language when it opens:

```yaml
---
lang: zh-CN
---
```

Supported values: any configured language code, or `ALL` to show everything.
The override applies only while that note is open — it does not change your global setting.

---

## Language Switching

| Method | How |
|---|---|
| **Ribbon button** | Click 🌐 in the left ribbon |
| **Status bar** | Click the language indicator at the bottom of the screen |
| **Command Palette** | `Ctrl/Cmd + P` → search "i8n" or "Switch language" |
| **Hotkey** | `Alt + L` cycles to the next language |

### Available Commands

| Command | Description |
|---|---|
| `Switch language: <name>` | Activate a specific language |
| `Switch language: Show all languages` | Disable filtering, show all blocks |
| `Cycle to next language` | Step forward through your language list |
| `Insert language block` | Insert a `:::lang` / `:::` pair at the cursor |
| `Wrap selection in language block` | Surround selected text with a lang block |
| `Insert multilingual block template` | Insert a full template with all configured languages |

---

## Settings

Open **Settings → i8n**.

| Setting | Description |
|---|---|
| **Active language** | Language shown right now across all notes. |
| **Default language** | Language assumed for notes with no lang markers. |
| **Hide non-active blocks in editor** | Fully collapses hidden blocks in editing mode (recommended). When off, blocks are dimmed instead. |
| **Show language badges** | Displays a small label above each visible block in reading mode. |
| **Configured languages** | Add, remove, and rename languages. The `code` must exactly match the value you write in your lang markers. |

The settings tab also includes a **Syntax Reference** section with copy buttons for each supported syntax style.

---

## Behaviour Summary

| Mode | Active language | Other languages |
|---|---|---|
| Reading mode | Rendered normally | Hidden (`display: none`) |
| Editing mode — Hide | Normal | Collapsed to a thin placeholder bar |
| Editing mode — Dim | Normal | 25 % opacity, grayscale |
| Show all (`ALL`) | All blocks visible | All blocks visible |

---

## Project Structure

```
obsidian-i8n/
├── main.ts                   ← Plugin entry point
├── src/
│   ├── settings.ts           ← Settings data, defaults, settings tab UI
│   ├── markdownProcessor.ts  ← Reading-mode post-processor (getSectionInfo approach)
│   └── editorExtension.ts    ← CodeMirror 6 extension for Live Preview / Source mode
├── examples/
│   ├── example-recipe.md
│   ├── example-travel-guide.md
│   └── example-meeting-notes.md
├── styles.css                ← Plugin CSS
├── manifest.json             ← Obsidian plugin manifest  (id: "i8n")
├── package.json
├── tsconfig.json
└── esbuild.config.mjs
```

---

## Building from Source

**Prerequisites:** Node.js 16 +

```bash
git clone https://github.com/your-username/obsidian-i8n
cd obsidian-i8n
npm install

# Development (watch + sourcemaps)
npm run dev

# Production build (minified)
npm run build
```

Both commands emit a single `main.js` in the project root.

**To use the built plugin locally:**

1. Copy `main.js`, `manifest.json`, and `styles.css` into
   `<vault>/.obsidian/plugins/i8n/`
2. In Obsidian: **Settings → Community plugins → Installed plugins** → enable **i8n**.

---

## Known Limitations

1. Very deeply nested Markdown inside a lang block (e.g., blockquotes containing fenced code blocks) may occasionally be mis-attributed to the wrong block. Simple paragraphs, headings, and lists work reliably.
2. Inline multilingual spans (mid-sentence language switching) are not supported in v1.0.
3. The plugin does not validate language codes against any ISO standard — any non-whitespace string is accepted.
4. Mobile support is best-effort. The status bar and ribbon switcher work on mobile, but the CM6 editor `block: true` replacements may behave slightly differently on iOS.

---

## Examples

See the `examples/` folder for ready-made multilingual note samples covering recipes, travel guides, and meeting notes.

---

## License

MIT
