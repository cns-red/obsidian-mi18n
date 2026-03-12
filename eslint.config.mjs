// eslint.config.mjs
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { dirname } from "path";
import { fileURLToPath } from "url";
import globals from "globals";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig([
    // 忽略编译产物
    {
        ignores: ["main.js", "dist/**", "node_modules/**"],
    },

    // Obsidian 官方推荐规则
    ...obsidianmd.configs.recommended,

    // 仅对 TS 文件启用 typed linting
    {
        files: ["**/*.ts", "**/*.js", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            parserOptions: {
                projectService: true,               // ← 关键：启用类型信息
                tsconfigRootDir: __dirname,         // ← 指向项目根目录
            },
        },
        rules: {
            "obsidianmd/sample-names": "off",
        },
    },

    // 测试文件运行于 Node.js，允许使用 Node.js 内置模块
    {
        files: ["tests/**/*.ts"],
        rules: {
            "import/no-nodejs-modules": "off",
        },
    },

    // Obsidian 插件 TS 源文件运行于 Electron（同时有 browser + Node 上下文）
    {
        files: ["src/**/*.ts", "main.ts"],
        languageOptions: {
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },

    // JS / MJS 脚本文件运行于 Node.js
    {
        files: ["**/*.js", "**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
            globals: {
                ...globals.browser,
                ...globals.node,
            },
        },
    },
]);
