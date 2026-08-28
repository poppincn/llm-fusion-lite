import { useEffect, useState } from "react";
import type { FusionConfig } from "./types";
import { getConfig } from "./api";
import { LanguageSwitcher, useT } from "./i18n";
import { ChatView } from "./components/ChatView";
import { ConnectView } from "./components/ConnectView";
import { StrengthsView } from "./components/StrengthsView";
import { UsageView } from "./components/UsageView";
import { SetupView } from "./components/SetupView";

type Page = "chat" | "strengths" | "usage" | "connect" | "setup";

const PAGE_PATH: Record<Page, string> = {
    chat: "/",
    strengths: "/strengths/",
    usage: "/usage/",
    connect: "/connect/",
    setup: "/setup/"
};

function pageFromPath(pathname: string): Page {
    const normalized = pathname === "/" ? "/" : pathname.replace(/\/+$/, "");
    if (normalized === "/" || normalized === "/chat") return "chat";
    const match = (Object.entries(PAGE_PATH) as Array<[Page, string]>).find(
        ([, path]) => path.replace(/\/+$/, "") === normalized
    );
    return match?.[0] ?? "chat";
}

export function App() {
    const { t } = useT();
    const page = pageFromPath(window.location.pathname);
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

    const noProviders = config !== null && config.providers.length === 0;

    const pages: Array<{ id: Page; label: string }> = [
        { id: "chat", label: t("nav.chat") },
        { id: "strengths", label: t("nav.strengths") },
        { id: "usage", label: t("nav.usage") },
        { id: "connect", label: t("nav.connect") },
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
                    <nav className="tabs" aria-label={t("nav.primary")}>
                        {pages.map(({ id, label }) => (
                            <a
                                key={id}
                                href={PAGE_PATH[id]}
                                aria-current={page === id ? "page" : undefined}
                                className={`tab ${page === id ? "tab-active" : ""}`}
                            >
                                {label}
                            </a>
                        ))}
                    </nav>
                    <LanguageSwitcher />
                </div>
            </header>

            {configError && (
                <div className="banner banner-error">{t("banner.configError", { error: configError })}</div>
            )}
            {noProviders && (
                <div className="banner banner-warn banner-row">
                    <span>{t("banner.noProviders")}</span>
                    <a className="btn-ghost btn-small" href={PAGE_PATH.setup}>
                        {t("banner.goSetup")}
                    </a>
                </div>
            )}

            <main className="app-main">
                {page === "chat" && <ChatView config={config} />}
                {page === "strengths" && <StrengthsView config={config} />}
                {page === "usage" && <UsageView />}
                {page === "connect" && <ConnectView config={config} onConfigChange={setConfig} />}
                {page === "setup" && <SetupView onConfigChange={setConfig} />}
            </main>
        </div>
    );
}
