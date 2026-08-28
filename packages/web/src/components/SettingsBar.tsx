import { useState } from "react";
import type { FusionConfig } from "../types";
import { useT } from "../i18n";

export interface FusionSettings {
    webSearch: boolean;
    judge: string;
    panelSize: number;
    /** Explicit panel selection. Empty = adaptive auto-panel. */
    panel: string[];
}

interface Props {
    config: FusionConfig | null;
    settings: FusionSettings;
    onChange: (next: FusionSettings) => void;
    disabled: boolean;
}

export function SettingsBar({ config, settings, onChange, disabled }: Props) {
    const { t } = useT();
    const [open, setOpen] = useState(false);

    const models = config?.models ?? [];
    const available = config?.available ?? [];
    const availableModels = models.filter(m => available.includes(m.id));
    const judgeModels = availableModels.length > 0 ? availableModels : models;
    const providerNames = new Map((config?.providers ?? []).map(provider => [provider.id, provider.name]));

    const togglePanelMember = (id: string) => {
        const next = settings.panel.includes(id) ? settings.panel.filter(p => p !== id) : [...settings.panel, id];
        onChange({ ...settings, panel: next });
    };

    return (
        <div className="settings">
            <div className="settings-row">
                <button type="button" className="settings-toggle" aria-expanded={open} onClick={() => setOpen(o => !o)}>
                    <span aria-hidden="true">⚙</span> {t("settings.button")}
                </button>

                <label className="settings-inline">
                    <input
                        type="checkbox"
                        checked={settings.webSearch}
                        disabled={disabled}
                        onChange={e => onChange({ ...settings, webSearch: e.target.checked })}
                    />
                    {t("settings.webSearch")}
                </label>

                <label className="settings-inline">
                    {t("settings.panelSize")}
                    <input
                        type="number"
                        className="num-input"
                        min={1}
                        max={Math.max(1, availableModels.length || 8)}
                        value={settings.panelSize}
                        disabled={disabled}
                        onChange={e => onChange({ ...settings, panelSize: clampInt(e.target.value, 1, 12) })}
                    />
                </label>

                <label className="settings-inline">
                    {t("settings.judge")}
                    <select
                        className="select-input"
                        value={settings.judge}
                        disabled={disabled || judgeModels.length === 0}
                        onChange={e => onChange({ ...settings, judge: e.target.value })}
                    >
                        {judgeModels.length === 0 && <option value="">{t("settings.defaultOption")}</option>}
                        {judgeModels.map(m => (
                            <option key={m.id} value={m.id}>
                                {modelDisplayName(m)}
                            </option>
                        ))}
                    </select>
                </label>
            </div>

            {open && (
                <div className="settings-panel">
                    <div className="settings-panel-title">
                        {t("settings.explicitPanel")} <span className="muted">{t("settings.explicitPanelHint")}</span>
                    </div>
                    {availableModels.length === 0 ?
                        <div className="muted">{t("settings.noModels")}</div>
                    :   <div className="panel-checks">
                            {availableModels.map(m => (
                                <label key={m.id} className="panel-check">
                                    <input
                                        type="checkbox"
                                        checked={settings.panel.includes(m.id)}
                                        disabled={disabled}
                                        onChange={() => togglePanelMember(m.id)}
                                    />
                                    <span className="panel-check-copy">
                                        <span className="panel-check-name">{modelDisplayName(m)}</span>
                                        {modelSubtitle(m) && <span className="panel-check-id">{modelSubtitle(m)}</span>}
                                    </span>
                                    <span className="provider-tag">
                                        {(m.providerId && providerNames.get(m.providerId)) || m.provider}
                                    </span>
                                </label>
                            ))}
                        </div>
                    }
                </div>
            )}
        </div>
    );
}

function modelDisplayName(model: FusionConfig["models"][number]): string {
    return model.label?.trim() || model.model?.trim() || model.id;
}

function modelSubtitle(model: FusionConfig["models"][number]): string | null {
    const subtitle = model.model?.trim() || model.id;
    return subtitle === modelDisplayName(model) ? null : subtitle;
}

function clampInt(raw: string, min: number, max: number): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
}
