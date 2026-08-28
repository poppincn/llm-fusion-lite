import { useEffect, useState } from "react";
import type { FusionConfig } from "./types";
import { getConfig } from "./api";
import { LanguageSwitcher, useT } from "./i18n";
import { ChatView } from "./components/ChatView";
import { StrengthsView } from "./components/StrengthsView";
import { UsageView } from "./components/UsageView";
import { SetupView } from "./components/SetupView";

type Tab = "chat" | "strengths" | "usage" | "setup";

export function App() {
    const { t } = useT();
    const [tab, setTab] = useState<Tab>("chat");
    const [config, setConfig] = useState<FusionConfig | null>(null);
    const [configError, setConfigError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        getConfig()
            .then(c => {
                if (!cancelled) setConfig(c);
            })
            .catch((err: unknown) => {
                if (!cancelled) {
                    setConfigError(err instanceof Error ? err.message : String(err));
                }
            });
        return () => {
            cancelled = true;
        };
    }, []);

    const noProviders = config !== null && config.providersConfigured.length === 0;

    const tabs: Array<{ id: Tab; label: string }> = [
        { id: "chat", label: t("nav.chat") },
        { id: "strengths", label: t("nav.strengths") },
        { id: "usage", label: t("nav.usage") },
        { id: "setup", label: t("nav.setup") }
    ];

    return (
        <div className="app">
            <header className="app-header">
                <div className="brand">
                    <span className="brand-mark" aria-hidden="true">
                        ✦
                    </span>
                    <span className="brand-name">
                        LLM Fusion <em>Lite</em>
                    </span>
                </div>
                <div className="header-right">
                    <nav className="tabs" role="tablist" aria-label="Primary">
                        {tabs.map(({ id, label }) => (
                            <button
                                key={id}
                                type="button"
                                role="tab"
                                aria-selected={tab === id}
                                className={`tab ${tab === id ? "tab-active" : ""}`}
                                onClick={() => setTab(id)}
                            >
                                {label}
                            </button>
                        ))}
                    </nav>
                    <LanguageSwitcher />
                </div>
            </header>

            {configError && (
                <div className="banner banner-error">{t("banner.configError", { error: configError })}</div>
            )}
            {noProviders && (
                <div className="banner banner-warn">
                    {t("banner.noProviders")} <code>ANTHROPIC_API_KEY</code>.
                </div>
            )}

            <main className="app-main">
                {tab === "chat" && <ChatView config={config} />}
                {tab === "strengths" && <StrengthsView config={config} />}
                {tab === "usage" && <UsageView />}
                {tab === "setup" && <SetupView onConfigChange={setConfig} />}
            </main>
        </div>
    );
}
