"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { uk } from "./locales/uk";

/**
 * Localisation.
 *
 * The English string IS the key. That choice costs a little duplication in the dictionary
 * and buys two things worth more: a missing translation renders as English rather than as
 * `creations.gallery.title`, and the source stays readable — you can see what a panel says
 * without opening a second file.
 *
 * Where one English word needs two Ukrainian ones depending on where it sits, the call
 * site passes a context: `t("Size", "vault")` looks up `Size·vault` first and falls back
 * to `Size`.
 */

export const LANGS = ["en", "uk"] as const;
export type Lang = (typeof LANGS)[number];

/** The two-letter code on the chip. `uk` is the ISO tag; `UA` is what a reader expects to see. */
export const LANG_LABEL: Record<Lang, string> = { en: "EN", uk: "UA" };

/** Endonyms — a language is named in itself, never translated into the other one. */
export const LANG_NAME: Record<Lang, string> = { en: "English", uk: "Українська" };

const DICTS: Record<Lang, Record<string, string>> = { en: {}, uk };

const STORAGE_KEY = "x-forge.lang";

export type Translate = (text: string, contextOrVars?: string | Record<string, string | number>, vars?: Record<string, string | number>) => string;

interface LangState {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: Translate;
}

const LangCtx = createContext<LangState>({ lang: "en", setLang: () => {}, t: (s) => s });

export function useLang(): LangState {
  return useContext(LangCtx);
}

/** The translator on its own, which is what nearly every component wants. */
export function useT(): Translate {
  return useContext(LangCtx).t;
}

export function LangProvider({ children }: { children: ReactNode }) {
  // Starts English on the server and on first paint, then adopts the stored choice. Reading
  // localStorage during render would make the server and the client disagree, and React
  // would throw the whole tree away to fix it.
  const [lang, setLangState] = useState<Lang>("en");

  useEffect(() => {
    const stored = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
    if (stored && LANGS.includes(stored)) setLangState(stored);
  }, []);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    window.localStorage.setItem(STORAGE_KEY, l);
  }, []);

  const t = useCallback<Translate>(
    (text, contextOrVars, vars) => {
      const context = typeof contextOrVars === "string" ? contextOrVars : undefined;
      const values = typeof contextOrVars === "object" ? contextOrVars : vars;
      const dict = DICTS[lang];
      const translated = (context && dict[`${text}·${context}`]) || dict[text] || text;
      return values ? interpolate(translated, values) : translated;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <LangCtx.Provider value={value}>{children}</LangCtx.Provider>;
}

/** `{n} files` → `12 files`. Placeholders left in place when a value is missing. */
function interpolate(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in vars ? String(vars[key]) : whole));
}

/**
 * The language a standalone page should use.
 *
 * The approval page renders outside the console shell — a person opens it from a chat
 * client with no provider above it — so it reads the same stored choice directly.
 */
export function storedLang(): Lang {
  if (typeof window === "undefined") return "en";
  const stored = window.localStorage.getItem(STORAGE_KEY) as Lang | null;
  return stored && LANGS.includes(stored) ? stored : "en";
}

export function translateWith(lang: Lang): Translate {
  return (text, contextOrVars, vars) => {
    const context = typeof contextOrVars === "string" ? contextOrVars : undefined;
    const values = typeof contextOrVars === "object" ? contextOrVars : vars;
    const dict = DICTS[lang];
    const translated = (context && dict[`${text}·${context}`]) || dict[text] || text;
    return values ? interpolate(translated, values) : translated;
  };
}
