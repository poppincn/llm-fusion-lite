/**
 * Minimal i18n: a React context over flat string dictionaries, persisted in
 * localStorage. No external dependency. Add a locale file and register it in
 * `dictionaries` to enable it — the header switcher appears automatically once
 * more than one locale exists.
 */
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { en } from "./locales/en";

export const dictionaries = { en } as const;
export type Locale = keyof typeof dictionaries;

const STORAGE_KEY = "llm-fusion-lite.lang";

function detectLocale(): Locale {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored && stored in dictionaries) return stored as Locale;
    } catch {
        /* ignore */
    }
    return "en";
}

function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
    const enDict: Record<string, string> = en;
    const dict = (dictionaries[locale] ?? {}) as Record<string, string>;
    let text = dict[key] ?? enDict[key] ?? key;
    if (vars) {
        for (const [k, v] of Object.entries(vars)) {
            text = text.replaceAll(`{${k}}`, String(v));
        }
    }
    return text;
}

interface I18nValue {
    locale: Locale;
    setLocale: (l: Locale) => void;
    t: (key: string, vars?: Record<string, string | number>) => string;
}

const I18nContext = createContext<I18nValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
    const [locale, setLocaleState] = useState<Locale>(detectLocale);

    useEffect(() => {
        document.documentElement.lang = locale;
        try {
            localStorage.setItem(STORAGE_KEY, locale);
        } catch {
            /* ignore */
        }
    }, [locale]);

    const value = useMemo<I18nValue>(
        () => ({ locale, setLocale: setLocaleState, t: (key, vars) => translate(locale, key, vars) }),
        [locale]
    );

    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): I18nValue {
    const ctx = useContext(I18nContext);
    if (!ctx) throw new Error("useT must be used inside <LanguageProvider>");
    return ctx;
}

/** Compact language switcher; hidden until a second locale is registered. */
export function LanguageSwitcher() {
    const { locale, setLocale } = useT();
    const locales = Object.keys(dictionaries) as Locale[];
    if (locales.length < 2) return null;
    return (
        <select
            className="select-input lang-switcher"
            value={locale}
            aria-label="Language"
            onChange={e => setLocale(e.target.value as Locale)}
        >
            {locales.map(l => (
                <option key={l} value={l}>
                    {l}
                </option>
            ))}
        </select>
    );
}
