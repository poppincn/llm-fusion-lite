import { useEffect, useMemo, useState } from "react";
import { updateConfig } from "../api";
import { useT } from "../i18n";
import type { FusionConfig, GatewayUpdate } from "../types";

interface Props {
    config: FusionConfig | null;
    onConfigChange: (config: FusionConfig) => void;
}

type CopyTarget = "baseURL" | "apiKey" | "model" | "env" | "json";

export function ConnectView({ config, onConfigChange }: Props) {
    const { t } = useT();
    const [baseURL, setBaseURL] = useState("");
    const [model, setModel] = useState("fusion");
    const [apiKey, setApiKey] = useState("");
    const [originalKeyMask, setOriginalKeyMask] = useState("");
    const [busy, setBusy] = useState(false);
    const [message, setMessage] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
    const [copied, setCopied] = useState<CopyTarget | null>(null);

    useEffect(() => {
        if (!config) return;
        const keyMask = config.gateway.apiKeySet ? (config.gateway.apiKeyHint ?? "••••••••") : "";
        setBaseURL(config.gateway.baseURLAuto ? "" : config.gateway.baseURL);
        setModel(config.gateway.model);
        setApiKey(keyMask);
        setOriginalKeyMask(keyMask);
    }, [config]);

    const guide = useMemo(() => {
        const effectiveBaseURL = config?.gateway.baseURL ?? "http://localhost:8787/v1";
        const effectiveModel = config?.gateway.model ?? "fusion";
        const keyValue = config?.gateway.apiKeySet ? "YOUR_FUSION_API_KEY" : "not-required";
        return {
            baseURL: effectiveBaseURL,
            model: effectiveModel,
            apiKey: keyValue,
            env: `OPENAI_BASE_URL=${effectiveBaseURL}\nOPENAI_API_KEY=${keyValue}\nOPENAI_MODEL=${effectiveModel}`,
            json: JSON.stringify({ baseURL: effectiveBaseURL, apiKey: keyValue, model: effectiveModel }, null, 2)
        };
    }, [config]);

    if (!config) return <p className="muted connect-loading">{t("setup.loading")}</p>;

    const save = async () => {
        const trimmedModel = model.trim();
        if (!trimmedModel) {
            setMessage({ kind: "err", text: t("connect.modelRequired") });
            return;
        }
        setBusy(true);
        setMessage(null);
        try {
            const gateway: GatewayUpdate = { baseURL: baseURL.trim(), model: trimmedModel };
            if (apiKey !== originalKeyMask) gateway.apiKey = apiKey.trim();
            const next = await updateConfig({ gateway });
            onConfigChange(next);
            setMessage({ kind: "ok", text: t("connect.saved") });
        } catch (error) {
            setMessage({ kind: "err", text: error instanceof Error ? error.message : String(error) });
        } finally {
            setBusy(false);
        }
    };

    const copy = async (target: CopyTarget, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            setCopied(target);
            window.setTimeout(() => setCopied(current => (current === target ? null : current)), 1400);
        } catch {
            setMessage({ kind: "err", text: t("connect.copyFailed") });
        }
    };

    return (
        <div className="connect-page">
            <div className="strengths-bar connect-hero">
                <div>
                    <p className="connect-kicker">OpenAI Compatible Gateway</p>
                    <h2>{t("connect.title")}</h2>
                    <p className="muted connect-intro">{t("connect.intro")}</p>
                </div>
                <span className="badge connect-live">{t("connect.live")}</span>
            </div>

            <div className="connect-layout">
                <section className="card connect-settings">
                    <h3 className="card-title">{t("connect.settings")}</h3>
                    {message && (
                        <div className={`banner inline-error ${message.kind === "ok" ? "banner-ok" : "banner-error"}`}>
                            {message.text}
                        </div>
                    )}

                    <label className="field">
                        <span className="field-label">{t("connect.baseURL")}</span>
                        <input
                            className="text-input"
                            value={baseURL}
                            placeholder={config.gateway.baseURL}
                            onChange={event => setBaseURL(event.target.value)}
                        />
                        <span className="field-help">
                            {config.gateway.baseURLAuto ?
                                t("connect.baseURLAuto", { url: config.gateway.baseURL })
                            :   t("connect.baseURLCustom")}
                        </span>
                    </label>

                    <label className="field">
                        <span className="field-label">{t("connect.model")}</span>
                        <input
                            className="text-input"
                            value={model}
                            maxLength={128}
                            onChange={event => setModel(event.target.value)}
                        />
                        <span className="field-help">{t("connect.modelHelp")}</span>
                    </label>

                    <label className="field">
                        <span className="field-label">{t("connect.apiKey")}</span>
                        <input
                            type="password"
                            className="text-input"
                            value={apiKey}
                            autoComplete="new-password"
                            placeholder={t("connect.apiKeyPlaceholder")}
                            onFocus={event => event.currentTarget.select()}
                            onChange={event => setApiKey(event.target.value)}
                        />
                        <span className="field-help">
                            {config.gateway.apiKeySet ?
                                t("connect.apiKeySet", { hint: config.gateway.apiKeyHint ?? "••••" })
                            :   t("connect.apiKeyOff")}
                        </span>
                    </label>

                    <div className="connect-save-row">
                        <p className="muted">{t("connect.networkNote")}</p>
                        <button type="button" className="composer-send" disabled={busy} onClick={() => void save()}>
                            {busy ? t("setup.saving") : t("connect.save")}
                        </button>
                    </div>
                </section>

                <section className="card connect-guide">
                    <div className="connect-guide-head">
                        <div>
                            <h3 className="card-title">{t("connect.guide")}</h3>
                            <p className="muted">{t("connect.guideIntro")}</p>
                        </div>
                    </div>

                    <div className="connect-values">
                        <CopyRow
                            label={t("connect.baseURL")}
                            value={guide.baseURL}
                            copied={copied === "baseURL"}
                            onCopy={() => void copy("baseURL", guide.baseURL)}
                        />
                        <CopyRow
                            label={t("connect.apiKey")}
                            value={guide.apiKey}
                            copied={copied === "apiKey"}
                            onCopy={() => void copy("apiKey", guide.apiKey)}
                        />
                        <CopyRow
                            label={t("connect.model")}
                            value={guide.model}
                            copied={copied === "model"}
                            onCopy={() => void copy("model", guide.model)}
                        />
                    </div>

                    {!config.gateway.apiKeySet && <p className="connect-key-note">{t("connect.noKeyGuide")}</p>}

                    <Snippet
                        title={t("connect.envTitle")}
                        value={guide.env}
                        copied={copied === "env"}
                        onCopy={() => void copy("env", guide.env)}
                    />
                    <Snippet
                        title={t("connect.jsonTitle")}
                        value={guide.json}
                        copied={copied === "json"}
                        onCopy={() => void copy("json", guide.json)}
                    />
                </section>
            </div>
        </div>
    );
}

function CopyRow({
    label,
    value,
    copied,
    onCopy
}: {
    label: string;
    value: string;
    copied: boolean;
    onCopy: () => void;
}) {
    const { t } = useT();
    return (
        <div className="connect-value-row">
            <span className="connect-value-label">{label}</span>
            <code>{value}</code>
            <button type="button" className="btn-ghost btn-small" onClick={onCopy}>
                {copied ? t("connect.copied") : t("connect.copy")}
            </button>
        </div>
    );
}

function Snippet({
    title,
    value,
    copied,
    onCopy
}: {
    title: string;
    value: string;
    copied: boolean;
    onCopy: () => void;
}) {
    const { t } = useT();
    return (
        <div className="connect-snippet">
            <div className="connect-snippet-head">
                <span>{title}</span>
                <button type="button" className="btn-ghost btn-small" onClick={onCopy}>
                    {copied ? t("connect.copied") : t("connect.copy")}
                </button>
            </div>
            <pre>
                <code>{value}</code>
            </pre>
        </div>
    );
}
