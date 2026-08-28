import { useCallback, useEffect, useState } from "react";
import type { ConfigModel, FusionConfig, ProviderDef, ProviderName, ReasoningEffort } from "../types";
import { getConfig, saveProviderKey, updateConfig } from "../api";
import { useT } from "../i18n";

interface Props {
    onConfigChange?: (config: FusionConfig) => void;
}

const ADAPTERS: Array<{ value: ProviderName; labelKey: string }> = [
    { value: "anthropic", labelKey: "setup.adapterAnthropic" },
    { value: "openai", labelKey: "setup.adapterOpenai" },
    { value: "google", labelKey: "setup.adapterGoogle" },
    { value: "openai-compatible", labelKey: "setup.adapterCustom" }
];
const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface ModelRow {
    id: string;
    providerId: string;
    model: string;
    label: string;
    webSearch: boolean;
    reasoningEffort: ReasoningEffort;
    costPer1MIn?: number;
    costPer1MOut?: number;
    excludeFromAuto?: boolean;
    autoPanel: boolean;
}

export function SetupView({ onConfigChange }: Props) {
    const { t } = useT();
    const [config, setConfig] = useState<FusionConfig | null>(null);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const c = await getConfig();
            setConfig(c);
            onConfigChange?.(c);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        }
    }, [onConfigChange]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="strengths">
            <div className="strengths-bar">
                <h2>{t("nav.setup")}</h2>
                <div className="strengths-controls">
                    <button type="button" className="btn-ghost" onClick={() => void load()}>
                        {t("strengths.refresh")}
                    </button>
                </div>
            </div>

            {error && <div className="banner banner-error inline-error">{error}</div>}

            {!config ?
                <p className="muted">{t("setup.loading")}</p>
            :   <div className="setup-sections">
                    <ProvidersSection config={config} onSaved={() => void load()} />
                    <ModelsSection config={config} onSaved={() => void load()} />
                    <SettingsSection config={config} onSaved={() => void load()} />
                </div>
            }
        </div>
    );
}

/* ---------- Providers ---------- */

interface ProviderDraft {
    id: string;
    name: string;
    adapter: ProviderName;
    keyText: string;
    baseURL: string;
    apiKeyHeader: string;
    headersText: string;
    extraParamsText: string;
}

function blankProvider(): ProviderDraft {
    return {
        id: "",
        name: "",
        adapter: "openai",
        keyText: "",
        baseURL: "",
        apiKeyHeader: "",
        headersText: "",
        extraParamsText: ""
    };
}

function draftFrom(def: ProviderDef): ProviderDraft {
    return {
        id: def.id,
        name: def.name,
        adapter: def.adapter,
        keyText: "",
        baseURL: def.baseURL ?? "",
        apiKeyHeader: def.apiKeyHeader ?? "",
        headersText: def.headers ? JSON.stringify(def.headers) : "",
        extraParamsText: def.extraParams ? JSON.stringify(def.extraParams) : ""
    };
}

function ProvidersSection({ config, onSaved }: { config: FusionConfig; onSaved: () => void }) {
    const { t } = useT();
    const providers = config.providers ?? [];
    const [draft, setDraft] = useState<ProviderDraft | null>(null);
    const [isNew, setIsNew] = useState(false);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    const openAdd = () => {
        setIsNew(true);
        setDraft(blankProvider());
    };
    const openEdit = (p: ProviderDef) => {
        setIsNew(false);
        setDraft(draftFrom(p));
    };
    const close = () => {
        if (busy) return;
        setDraft(null);
    };

    const save = async () => {
        if (!draft) return;
        setMsg(null);
        const name = draft.name.trim();
        if (!name) {
            setMsg({ kind: "err", text: t("setup.providerNameRequired") });
            return;
        }
        const id = draft.id.trim();
        if (!id) {
            setMsg({ kind: "err", text: t("setup.providerIdRequired") });
            return;
        }
        const others = providers.filter(p => p.id !== draft.id);
        if (!isNew && providers.every(p => p.id !== draft.id) && others.some(p => p.id === id)) {
            setMsg({ kind: "err", text: t("setup.providerIdUnique") });
            return;
        }
        if (isNew && others.some(p => p.id === id)) {
            setMsg({ kind: "err", text: t("setup.providerIdUnique") });
            return;
        }
        if (draft.adapter === "openai-compatible" && !draft.baseURL.trim()) {
            setMsg({ kind: "err", text: t("setup.baseURLRequired") });
            return;
        }
        let headers: Record<string, string> | undefined;
        try {
            headers = parseJsonObject(draft.headersText) as Record<string, string> | undefined;
        } catch {
            setMsg({ kind: "err", text: t("setup.headersInvalid", { id }) });
            return;
        }
        let extraParams: Record<string, unknown> | undefined;
        try {
            extraParams = parseJsonObject(draft.extraParamsText);
        } catch {
            setMsg({ kind: "err", text: t("setup.paramsInvalid", { id }) });
            return;
        }
        setBusy(true);
        try {
            const keyText = draft.keyText.trim();
            const def: ProviderDef = {
                id,
                name,
                adapter: draft.adapter,
                baseURL: draft.baseURL.trim() || undefined,
                apiKeyHeader: draft.apiKeyHeader.trim() || undefined,
                headers,
                extraParams
            };
            const next = isNew ? [...providers, def] : providers.map(p => (p.id === def.id ? def : p));
            await updateConfig({ providers: next });
            if (keyText) {
                await saveProviderKey(id, keyText);
            }
            setDraft(null);
            onSaved();
        } catch (err: unknown) {
            setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        if (!draft) return;
        setMsg(null);
        if (config.models.some(m => m.providerId === draft.id)) {
            setMsg({ kind: "err", text: t("setup.providerInUse") });
            return;
        }
        setBusy(true);
        try {
            await updateConfig({ providers: providers.filter(p => p.id !== draft.id) });
            setDraft(null);
            onSaved();
        } catch (err: unknown) {
            setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(false);
        }
    };

    const modelsFor = (id: string) => config.models.filter(m => m.providerId === id).length;

    return (
        <section className="card">
            <h3 className="card-title">{t("setup.providers")}</h3>
            {msg && (
                <div className={`banner inline-error ${msg.kind === "ok" ? "banner-ok" : "banner-error"}`}>
                    {msg.text}
                </div>
            )}
            {providers.length === 0 ?
                <p className="muted">{t("setup.noProviders")}</p>
            :   <div className="provider-grid">
                    {providers.map(p => (
                        <div key={p.id} className="provider-card">
                            <div className="provider-card-head">
                                <span className="provider-name">{p.name}</span>
                                <span className="badge">
                                    {p.adapter === "openai-compatible" ?
                                        t("setup.adapterCustomShort")
                                    :   t(ADAPTERS.find(a => a.value === p.adapter)?.labelKey ?? "setup.adapterCustom")}
                                </span>
                            </div>
                            <div className="provider-card-detail muted">
                                {p.adapter === "openai-compatible" ?
                                    p.baseURL || t("setup.baseURLRequired")
                                :   t("setup.officialAdapter")}{" "}
                                <span className={p.keySet ? "setup-status-ok" : "setup-status-off"}>
                                    {p.keySet ? t("setup.keySet") : t("setup.keyMissing")}
                                </span>
                            </div>
                            <div className="provider-card-foot">
                                <span className="muted">
                                    {t(modelsFor(p.id) === 1 ? "setup.modelsOne" : "setup.modelsMany", {
                                        n: modelsFor(p.id)
                                    })}
                                </span>
                                <button type="button" className="btn-ghost btn-small" onClick={() => openEdit(p)}>
                                    {t("setup.edit")}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            }
            <div className="setup-actions">
                <button type="button" className="btn-ghost" onClick={openAdd}>
                    {t("setup.addProvider")}
                </button>
            </div>

            {draft && (
                <div className="modal-backdrop" onClick={close}>
                    <div
                        className="modal"
                        role="dialog"
                        aria-modal="true"
                        aria-label={t(isNew ? "setup.newProvider" : "setup.editProvider")}
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="modal-head">
                            <h4>{t(isNew ? "setup.newProvider" : "setup.editProvider")}</h4>
                            <button type="button" className="modal-close" aria-label={t("setup.close")} onClick={close}>
                                ✕
                            </button>
                        </div>
                        <div className="modal-body">
                            <label className="field">
                                <span className="field-label">{t("setup.providerName")}</span>
                                <input
                                    className="text-input"
                                    value={draft.name}
                                    autoFocus
                                    onChange={e => setDraft({ ...draft, name: e.target.value })}
                                />
                            </label>
                            <label className="field">
                                <span className="field-label">
                                    {t("setup.providerId")} <span className="muted">({t("setup.providerIdHint")})</span>
                                </span>
                                <input
                                    className="text-input"
                                    value={draft.id}
                                    disabled={!isNew}
                                    placeholder="openai-pro"
                                    onChange={e => setDraft({ ...draft, id: e.target.value })}
                                />
                            </label>
                            <label className="field">
                                <span className="field-label">{t("setup.adapter")}</span>
                                <select
                                    className="select-input"
                                    value={draft.adapter}
                                    onChange={e => setDraft({ ...draft, adapter: e.target.value as ProviderName })}
                                >
                                    {ADAPTERS.map(a => (
                                        <option key={a.value} value={a.value}>
                                            {t(a.labelKey)}
                                        </option>
                                    ))}
                                </select>
                            </label>
                            <label className="field">
                                <span className="field-label">{t("setup.key")}</span>
                                <input
                                    type="password"
                                    className="text-input"
                                    value={draft.keyText}
                                    placeholder={t("setup.keyHint")}
                                    onChange={e => setDraft({ ...draft, keyText: e.target.value })}
                                />
                            </label>
                            {draft.adapter === "openai-compatible" && (
                                <>
                                    <p className="muted setup-note">{t("setup.customOnlyHint")}</p>
                                    <label className="field">
                                        <span className="field-label">{t("setup.baseURL")}</span>
                                        <input
                                            className="text-input"
                                            value={draft.baseURL}
                                            placeholder="http://localhost:11434/v1"
                                            onChange={e => setDraft({ ...draft, baseURL: e.target.value })}
                                        />
                                    </label>
                                    <label className="field">
                                        <span className="field-label">{t("setup.authHeader")}</span>
                                        <input
                                            className="text-input"
                                            value={draft.apiKeyHeader}
                                            placeholder="Authorization"
                                            onChange={e => setDraft({ ...draft, apiKeyHeader: e.target.value })}
                                        />
                                    </label>
                                    <label className="field">
                                        <span className="field-label">{t("setup.headers")}</span>
                                        <input
                                            className="text-input"
                                            value={draft.headersText}
                                            placeholder='{ "X-Title": "app" }'
                                            onChange={e => setDraft({ ...draft, headersText: e.target.value })}
                                        />
                                    </label>
                                    <label className="field">
                                        <span className="field-label">{t("setup.params")}</span>
                                        <input
                                            className="text-input"
                                            value={draft.extraParamsText}
                                            placeholder='{ "temperature": 0.2 }'
                                            onChange={e => setDraft({ ...draft, extraParamsText: e.target.value })}
                                        />
                                    </label>
                                </>
                            )}
                        </div>
                        <div className="modal-actions">
                            {!isNew && (
                                <button
                                    type="button"
                                    className="btn-ghost modal-danger"
                                    disabled={busy}
                                    onClick={() => void remove()}
                                >
                                    {t("setup.delete")}
                                </button>
                            )}
                            <span className="modal-spacer" />
                            <button type="button" className="btn-ghost" disabled={busy} onClick={close}>
                                {t("setup.cancel")}
                            </button>
                            <button type="button" className="composer-send" disabled={busy} onClick={() => void save()}>
                                {busy ? t("setup.saving") : t("setup.save")}
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </section>
    );
}

/* ---------- Models ---------- */

function ModelsSection({ config, onSaved }: { config: FusionConfig; onSaved: () => void }) {
    const { t } = useT();
    const providers = config.providers ?? [];
    const [rows, setRows] = useState<ModelRow[]>(() => toRows(config));
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    // Reset local rows whenever the upstream config changes.
    useEffect(() => {
        setRows(toRows(config));
    }, [config]);

    const update = (idx: number, patch: Partial<ModelRow>) => {
        setRows(rs => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
    };

    const remove = (idx: number) => {
        setRows(rs => rs.filter((_, i) => i !== idx));
    };

    const add = () => {
        setRows(rs => [
            ...rs,
            {
                id: "",
                providerId: providers[0]?.id ?? "",
                model: "",
                label: "",
                webSearch: false,
                reasoningEffort: "high",
                autoPanel: false
            }
        ]);
    };

    const save = async () => {
        const ids = rows.map(r => r.id.trim());
        if (ids.some(id => id.length === 0)) {
            setMsg({ kind: "err", text: t("setup.modelIdRequired") });
            return;
        }
        if (new Set(ids).size !== ids.length) {
            setMsg({ kind: "err", text: t("setup.modelIdsUnique") });
            return;
        }
        setBusy(true);
        setMsg(null);
        try {
            if (rows.some(r => !r.providerId)) {
                throw new Error(t("setup.modelProviderRequired"));
            }
            const byId = new Map(providers.map(p => [p.id, p]));
            const models: ConfigModel[] = rows.map(r => ({
                id: r.id.trim(),
                providerId: r.providerId,
                provider: byId.get(r.providerId)?.adapter ?? "openai-compatible",
                model: r.model?.trim() ? r.model.trim() : undefined,
                label: r.label.trim() || r.model.trim() || r.id.trim(),
                webSearch: r.webSearch,
                costPer1MIn: r.costPer1MIn,
                costPer1MOut: r.costPer1MOut,
                excludeFromAuto: r.excludeFromAuto,
                reasoningEffort: r.reasoningEffort ?? "high"
            }));
            const autoPanel = rows.filter(r => r.autoPanel).map(r => r.id.trim());
            await updateConfig({ models, autoPanel });
            setMsg({ kind: "ok", text: t("setup.modelsSaved") });
            onSaved();
        } catch (err: unknown) {
            setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(false);
        }
    };

    return (
        <section className="card">
            <h3 className="card-title">{t("setup.models")}</h3>
            {msg && (
                <div className={`banner inline-error ${msg.kind === "ok" ? "banner-ok" : "banner-error"}`}>
                    {msg.text}
                </div>
            )}
            <div className="setup-table-scroll">
                <table className="strengths-table setup-models-table">
                    <thead>
                        <tr>
                            <th>{t("setup.colId")}</th>
                            <th>{t("setup.colProvider")}</th>
                            <th>{t("setup.colModel")}</th>
                            <th>{t("setup.colLabel")}</th>
                            <th>{t("setup.colWeb")}</th>
                            <th>{t("setup.colEffort")}</th>
                            <th className="num">{t("setup.colCostIn")}</th>
                            <th className="num">{t("setup.colCostOut")}</th>
                            <th>{t("setup.colAuto")}</th>
                            <th />
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map((r, i) => (
                            <tr key={i}>
                                <td>
                                    <input
                                        className="text-input cell-input"
                                        value={r.id}
                                        onChange={e => update(i, { id: e.target.value })}
                                    />
                                </td>
                                <td>
                                    <select
                                        className="select-input"
                                        value={r.providerId}
                                        onChange={e => update(i, { providerId: e.target.value })}
                                    >
                                        {providers.map(p => (
                                            <option key={p.id} value={p.id}>
                                                {p.name}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td>
                                    <input
                                        className="text-input cell-input"
                                        value={r.model ?? ""}
                                        onChange={e => update(i, { model: e.target.value })}
                                    />
                                </td>
                                <td>
                                    <input
                                        className="text-input cell-input"
                                        value={r.label}
                                        onChange={e => update(i, { label: e.target.value })}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={r.webSearch ?? false}
                                        onChange={e => update(i, { webSearch: e.target.checked })}
                                    />
                                </td>
                                <td>
                                    <select
                                        className="select-input"
                                        value={r.reasoningEffort ?? "high"}
                                        onChange={e =>
                                            update(i, { reasoningEffort: e.target.value as ReasoningEffort })
                                        }
                                    >
                                        {EFFORTS.map(eff => (
                                            <option key={eff} value={eff}>
                                                {eff}
                                            </option>
                                        ))}
                                    </select>
                                </td>
                                <td className="num">
                                    <input
                                        type="number"
                                        className="num-input"
                                        value={r.costPer1MIn ?? ""}
                                        onChange={e => update(i, { costPer1MIn: parseNum(e.target.value) })}
                                    />
                                </td>
                                <td className="num">
                                    <input
                                        type="number"
                                        className="num-input"
                                        value={r.costPer1MOut ?? ""}
                                        onChange={e => update(i, { costPer1MOut: parseNum(e.target.value) })}
                                    />
                                </td>
                                <td>
                                    <input
                                        type="checkbox"
                                        checked={r.autoPanel}
                                        onChange={e => update(i, { autoPanel: e.target.checked })}
                                    />
                                </td>
                                <td>
                                    <button type="button" className="btn-ghost btn-small" onClick={() => remove(i)}>
                                        ✕
                                    </button>
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <div className="setup-actions">
                <button type="button" className="btn-ghost" onClick={add}>
                    {t("setup.addModel")}
                </button>
                <button type="button" className="composer-send" onClick={() => void save()} disabled={busy}>
                    {busy ? t("setup.saving") : t("setup.saveModels")}
                </button>
            </div>
        </section>
    );
}

/* ---------- Settings ---------- */

function SettingsSection({ config, onSaved }: { config: FusionConfig; onSaved: () => void }) {
    const { t } = useT();
    const [defaultJudge, setDefaultJudge] = useState(config.defaultJudge);
    const [classifierModel, setClassifierModel] = useState(config.classifierModel);
    const [panelSize, setPanelSize] = useState(config.panelSize);
    const [webSearch, setWebSearch] = useState(config.webSearch);
    const [explorationRate, setExplorationRate] = useState(config.explorationRate);
    const [busy, setBusy] = useState(false);
    const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

    useEffect(() => {
        setDefaultJudge(config.defaultJudge);
        setClassifierModel(config.classifierModel);
        setPanelSize(config.panelSize);
        setWebSearch(config.webSearch);
        setExplorationRate(config.explorationRate);
    }, [config]);

    const save = async () => {
        setBusy(true);
        setMsg(null);
        try {
            await updateConfig({ defaultJudge, classifierModel, panelSize, webSearch, explorationRate });
            setMsg({ kind: "ok", text: t("setup.settingsSaved") });
            onSaved();
        } catch (err: unknown) {
            setMsg({ kind: "err", text: err instanceof Error ? err.message : String(err) });
        } finally {
            setBusy(false);
        }
    };

    const modelIds = config.models.map(m => m.id);

    return (
        <section className="card">
            <h3 className="card-title">{t("setup.settings")}</h3>
            {msg && (
                <div className={`banner inline-error ${msg.kind === "ok" ? "banner-ok" : "banner-error"}`}>
                    {msg.text}
                </div>
            )}
            <div className="setup-settings">
                <label className="settings-inline">
                    {t("setup.defaultJudge")}
                    <select
                        className="select-input"
                        value={defaultJudge}
                        onChange={e => setDefaultJudge(e.target.value)}
                    >
                        {modelIds.map(id => (
                            <option key={id} value={id}>
                                {id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="settings-inline">
                    {t("setup.classifier")}
                    <select
                        className="select-input"
                        value={classifierModel}
                        onChange={e => setClassifierModel(e.target.value)}
                    >
                        {modelIds.map(id => (
                            <option key={id} value={id}>
                                {id}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="settings-inline">
                    {t("setup.panelSize")}
                    <input
                        type="number"
                        min={1}
                        className="num-input"
                        value={panelSize}
                        onChange={e => setPanelSize(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
                    />
                </label>
                <label className="settings-inline">
                    <input type="checkbox" checked={webSearch} onChange={e => setWebSearch(e.target.checked)} />
                    {t("setup.webSearch")}
                </label>
                <label className="settings-inline">
                    {t("setup.explorationRate")}
                    <input
                        type="number"
                        min={0}
                        max={1}
                        step={0.05}
                        className="num-input"
                        value={explorationRate}
                        onChange={e => setExplorationRate(clampRate(Number(e.target.value)))}
                    />
                </label>
            </div>
            <div className="setup-actions">
                <button type="button" className="composer-send" onClick={() => void save()} disabled={busy}>
                    {busy ? t("setup.saving") : t("setup.saveSettings")}
                </button>
            </div>
        </section>
    );
}

/* ---------- helpers ---------- */

function toRows(config: FusionConfig): ModelRow[] {
    const auto = new Set(config.autoPanel);
    const providers = config.providers ?? [];
    const providerIdOf = (m: ConfigModel): string =>
        m.providerId ?? providers.find(p => p.adapter === m.provider)?.id ?? providers[0]?.id ?? "";
    return config.models.map(m => ({
        id: m.id,
        providerId: providerIdOf(m),
        model: m.model ?? "",
        label: m.label?.trim() || m.model?.trim() || m.id,
        webSearch: m.webSearch ?? false,
        reasoningEffort: m.reasoningEffort ?? "high",
        costPer1MIn: m.costPer1MIn,
        costPer1MOut: m.costPer1MOut,
        excludeFromAuto: m.excludeFromAuto,
        autoPanel: auto.has(m.id)
    }));
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
    if (!text.trim()) return undefined;
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new Error("not a JSON object");
    }
    return parsed as Record<string, unknown>;
}

function parseNum(v: string): number | undefined {
    if (v.trim() === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function clampRate(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}
