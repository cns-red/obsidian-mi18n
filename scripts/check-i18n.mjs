import { readFileSync } from "node:fs";

const targets = ["main.ts", "src/settings.ts"];
const patterns = [
  /\.setTitle\(\s*["'`]/g,
  /\.setName\(\s*["'`]/g,
  /\.setDesc\(\s*["'`]/g,
  /\.setTooltip\(\s*["'`]/g,
  /new Notice\(\s*["'`]/g,
  /setButtonText\(\s*["'`]/g,
  /addRibbonIcon\([^\n]+,\s*["'`]/g,
];

let hasError = false;

for (const file of targets) {
  const source = readFileSync(file, "utf8");
  for (const pattern of patterns) {
    if (pattern.test(source)) {
      hasError = true;
      console.error(`[i18n-check] ${file} has hard-coded UI strings matching ${pattern}`);
    }
  }
}

if (hasError) process.exit(1);
console.log("[i18n-check] All checked UI strings are localized with t(...). ");
