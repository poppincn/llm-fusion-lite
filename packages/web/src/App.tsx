import { useEffect, useState } from "react";
import type { FusionConfig } from "./types";
import { getConfig } from "./api";
import { ChatView } from "./components/ChatView";
import { StrengthsView } from "./components/StrengthsView";

type Tab = "chat" | "strengths";

export function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [config, setConfig] = useState<FusionConfig | null>(null);
  const [configError, setConfigError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConfig()
      .then((c) => {
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            ✦
          </span>
          <span className="brand-name">Era Fusion</span>
        </div>
        <nav className="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "chat"}
            className={`tab ${tab === "chat" ? "tab-active" : ""}`}
            onClick={() => setTab("chat")}
          >
            Chat
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "strengths"}
            className={`tab ${tab === "strengths" ? "tab-active" : ""}`}
            onClick={() => setTab("strengths")}
          >
            Strengths
          </button>
        </nav>
      </header>

      {configError && (
        <div className="banner banner-error">
          Could not load configuration: {configError}
        </div>
      )}
      {noProviders && (
        <div className="banner banner-warn">
          No provider keys set — start the server with{" "}
          <code>ANTHROPIC_API_KEY</code>.
        </div>
      )}

      <main className="app-main">
        {tab === "chat" ? (
          <ChatView config={config} />
        ) : (
          <StrengthsView config={config} />
        )}
      </main>
    </div>
  );
}
