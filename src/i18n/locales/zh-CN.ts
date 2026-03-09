import type { MessagesShape } from "../types";

const zhCN: MessagesShape = {
  ribbon: {
    switch_language: "多语言笔记 — 切换语言",
  },
  status_bar: {
    click_to_switch: "点击切换语言",
    all_languages: "所有语言",
  },
  menu: {
    show_all_languages: "显示所有语言",
    multilingual: "多语言",
    wrap: "包裹",
    smart_insert: "智能插入",
    manual_insert: "手动插入",
    existing_lang_prefix: "✓ {label}",
  },
  command: {
    switch_language: "切换语言：{label}",
    switch_show_all: "切换语言：显示所有语言",
    cycle_next: "切换到下一语言",
    insert_lang_block: "插入语言块",
    wrap_selection: "用语言块包裹选中内容",
    insert_template: "插入多语言块模板（全部语言）",
  },
  notice: {
    language_switched: "语言已切换为 {label}",
    showing_all_blocks: "正在显示所有语言块",
    select_text_first: "请先选中文本。",
    current_language: "当前语言：{label}",
    inserted_block: "已插入 {label} 语言块",
    fully_internationalized: "✓ 已完全国际化",
    keep_one_language: "至少保留一种语言。",
  },
  settings: {
    title: "i8n — 设置",
    active_language_name: "当前语言",
    active_language_desc: "跨所有笔记当前显示的语言。",
    default_language_name: "默认语言",
    default_language_desc: "当笔记完全没有 lang 标记时，视为该语言。切换到其它语言会让该笔记不可见。",
    hide_other_name: "在编辑器中隐藏其他语言",
    hide_other_desc:
      "开启：编辑模式下非当前语言会折叠为细条，仅可输入当前语言。关闭：编辑器中显示所有语言块，便于自由阅读和编辑。",
    show_badges_name: "阅读模式显示语言标签",
    show_badges_desc: "在阅读模式下为每个可见语言块显示一个小标签。",
    configured_languages_title: "已配置语言",
    configured_languages_desc: "可新增、删除或重命名语言项。“code”必须与 lang 标记中的代码完全一致。",
    add_language_name: "新增语言",
    add_language_button: "+ 添加语言",
    syntax_title: "语法参考",
    syntax_desc: "四种语法完全等价，请按工作流选择。",
    copy: "复制",
    copied: "已复制！",
    no_marker_title: "💡 没有任何 lang 标记的笔记",
    no_marker_desc:
      "没有 lang 标记的笔记会被视为完全使用上方“默认语言”。切换到其他语言时整篇会不可见——这是有意设计，因为该语言尚无对应翻译。",
    language_row: "语言 #{index}",
    remove_language_tooltip: "移除此语言",
    code_placeholder: "代码，例如 zh-CN",
    label_placeholder: "标签，例如 简体中文",
    syntax_sample_content: "内容 / Content",
    syntax: {
      default_title: "默认（Obsidian 围栏 div 风格）",
      default_note: "推荐。Obsidian 原生支持，且多数 Markdown 预览器渲染良好。",
      hexo_title: "Hexo / 模板标签风格",
      hexo_note: "阅读模式可见。兼容 Hexo 及类似静态站点生成器。",
      comment_title: "Markdown 注释（链接引用技巧）",
      comment_note: "在 Obsidian 阅读模式完全不可见，适合干净文档。语言代码写在括号内。",
      obsidian_comment_title: "Obsidian 注释风格",
      obsidian_comment_note: "在 Obsidian 中完全不可见（注释语法），Live Preview 同样隐藏。",
    },
  },
} as const;

export default zhCN;
