import en from "./locales/en";
import zhCN from "./locales/zh-CN";
import type { I18nKey, MessagesShape } from "./types";

export enum AppLocale {
  EN = "en",
  ZH_CN = "zh-CN",
  ZH_TW = "zh-TW",
  JA = "ja",
  FR = "fr",
  DE = "de",
  ES = "es",
  RU = "ru",
  KO = "ko",
}

type Messages = MessagesShape;

type Primitive = string | number | boolean;
type Params = Record<string, Primitive>;

const dictionaries: Record<string, Messages> = {
  [AppLocale.EN]: en,
  [AppLocale.ZH_CN]: zhCN,
};

const localeFallbackMap: Record<string, AppLocale> = {
  [AppLocale.EN]: AppLocale.EN,
  [AppLocale.ZH_CN]: AppLocale.ZH_CN,
  [AppLocale.ZH_TW]: AppLocale.EN,
  [AppLocale.JA]: AppLocale.EN,
  [AppLocale.FR]: AppLocale.EN,
  [AppLocale.DE]: AppLocale.EN,
  [AppLocale.ES]: AppLocale.EN,
  [AppLocale.RU]: AppLocale.EN,
  [AppLocale.KO]: AppLocale.EN,
};

const warnedMissingKeys = new Set<string>();
let currentLocale: string | undefined;

const isDev = typeof process !== "undefined" && process.env.NODE_ENV !== "production";

function normalizeLocale(locale: string | null | undefined): string {
  if (!locale) return AppLocale.EN;
  const trimmed = locale.trim();
  if (!trimmed) return AppLocale.EN;
  if (dictionaries[trimmed]) return trimmed;

  const lower = trimmed.toLowerCase();
  if (lower === "zh-cn") return AppLocale.ZH_CN;

  const base = trimmed.split("-")[0];
  return localeFallbackMap[base] ?? AppLocale.EN;
}

function getByPath(dict: Messages, key: string): unknown {
  return key.split(".").reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[part];
    }
    return undefined;
  }, dict);
}

function interpolate(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, token: string) => {
    if (token in params) return String(params[token]);
    return `{${token}}`;
  });
}

export function initializeI18n(obsidianLocale?: string): void {
  const preferred = normalizeLocale(obsidianLocale ?? (window.navigator?.language ?? AppLocale.EN));
  currentLocale = localeFallbackMap[preferred] ?? AppLocale.EN;
}

export function detectObsidianLocale(app?: unknown): string | undefined {
  const appAny = app as Record<string, any> | undefined;
  const fromApp = appAny?.locale ?? appAny?.i18n?.locale;
  if (typeof fromApp === "string" && fromApp.trim()) return fromApp;

  const fromConfig = appAny?.vault?.getConfig?.("locale");
  if (typeof fromConfig === "string" && fromConfig.trim()) return fromConfig;

  const fromDocument = document?.documentElement?.lang;
  if (typeof fromDocument === "string" && fromDocument.trim()) return fromDocument;

  return undefined;
}

export function t(key: I18nKey, params?: Params): string {
  if (!currentLocale) initializeI18n();

  const activeLocale = currentLocale ?? AppLocale.EN;
  const activeDict = dictionaries[activeLocale] ?? en;
  const fallbackDict = en;

  const activeValue = getByPath(activeDict, key);
  const fallbackValue = getByPath(fallbackDict, key);
  const raw = typeof activeValue === "string"
    ? activeValue
    : (typeof fallbackValue === "string" ? fallbackValue : key);

  if (isDev && typeof activeValue !== "string" && !warnedMissingKeys.has(`${activeLocale}:${key}`)) {
    warnedMissingKeys.add(`${activeLocale}:${key}`);
    console.warn(`[i18n] Missing key "${key}" for locale "${activeLocale}".`);
  }

  return interpolate(raw, params);
}

export function resolveObsidianLocale(appLocale: string | undefined): string {
  const normalized = normalizeLocale(appLocale);
  return localeFallbackMap[normalized] ?? AppLocale.EN;
}

export const I18N_FALLBACKS = localeFallbackMap;
