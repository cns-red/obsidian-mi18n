import en from "./locales/en";

type Widen<T> = T extends string
  ? string
  : T extends object
    ? { [K in keyof T]: Widen<T[K]> }
    : T;

export type MessagesShape = Widen<typeof en>;

type Join<K, P> = K extends string ? (P extends string ? `${K}.${P}` : never) : never;

export type DeepKeys<T> = T extends object
  ? {
      [K in Extract<keyof T, string>]: T[K] extends string
        ? K
        : Join<K, DeepKeys<T[K]>>
    }[Extract<keyof T, string>]
  : never;

export type I18nKey = DeepKeys<MessagesShape>;
