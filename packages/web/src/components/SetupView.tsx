import { useCallback, useEffect, useState } from "react";
import type {
  ConfigModel,
  FusionConfig,
  ProviderName,
  ReasoningEffort,
} from "../types";
import { getConfig, saveKey, updateConfig } from "../api";

interface Props {
  onConfigChange?: (config: FusionConfig) => void;
}

const KEY_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google"];
const MODEL_PROVIDERS: ProviderName[] = ["anthropic", "openai", "google", "openai-compatible"];
const EFFORTS: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];

interface ModelRow extends ConfigModel {
  autoPanel: boolean;
  headersText: string;
  extraParamsText: string;
}

export function SetupView({ onConfigChange }: Props) {
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
        <h2>Setup</h2>
        <div className="strengths-controls">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void load()}
          >
            Refresh
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error inline-error">{error}</div>}

      {!config ? (
        <p className="muted">Loading…</p>
      ) : (
        <div className="setup-sections">
          <KeysSection config={config} onSaved={() => void load()} />
          <ModelsSection config={config} onSaved={() => void load()} />
          <SettingsSection config={config} onSaved={() => void load()} />
        </div>
      )}
    </div>
  );
}

/* ---------- Provider keys ---------- */

function KeysSection({
  config,
  onSaved,
}: {
  config: FusionConfig;
  onSaved: () => void;
}) {
  const [keys, setKeys] = useState<Record<ProviderName, string>>({
    anthropic: "",
    openai: "",
    google: "",
  });
  const [busy, setBusy] = useState<ProviderName | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  const save = async (provider: ProviderName) => {
    const key = keys[provider].trim();
    if (key.length === 0) {
      setMsg({ kind: "err", text: "Enter a key before saving." });
      return;
    }
    setBusy(provider);
    setMsg(null);
    try {
      await saveKey(provider, key);
      setKeys((k) => ({ ...k, [provider]: "" }));
      setMsg({ kind: "ok", text: `${provider} key saved.` });
      onSaved();
    } catch (err: unknown) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="card">
      <h3 className="card-title">Provider keys</h3>
      {msg && (
        <div
          className={`banner inline-error ${
            msg.kind === "ok" ? "banner-ok" : "banner-error"
          }`}
        >
          {msg.text}
        </div>
      )}
      <div className="setup-keys">
        {KEY_PROVIDERS.map((p) => {
          const set = config.providers.includes(p);
          return (
            <div key={p} className="setup-key-row">
              <span className="setup-key-name">{p}</span>
              <span
                className={set ? "setup-status-ok" : "setup-status-off"}
              >
                {set ? "✓ configured" : "not set"}
              </span>
              <input
                type="password"
                className="text-input setup-key-input"
                placeholder={`${p} API key`}
                value={keys[p]}
                onChange={(e) =>
                  setKeys((k) => ({ ...k, [p]: e.target.value }))
                }
              />
              <button
                type="button"
                className="btn-ghost"
                onClick={() => void save(p)}
                disabled={busy === p}
              >
                {busy === p ? "Saving…" : "Save"}
              </button>
            </div>
          );
        })}
        <CustomKeyRow />
      </div>
      <p className="muted setup-note">
        Keys are stored locally in <code>~/.era-fusion/.env</code> on the
        server.
      </p>
    </section>
  );
}

function CustomKeyRow() {
  const [env, setEnv] = useState("");
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const save = async () => {
    const name = env.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      setMsg("env var name must look like MY_LLM_API_KEY");
      return;
    }
    if (!key.trim()) {
      setMsg("enter a key value (any non-empty value works for keyless local endpoints)");
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      await saveKey("custom", key.trim(), name);
      setKey("");
      setMsg(`wrote ${name} to ~/.era-fusion/.env (live)`);
    } catch (err) {
      setMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="setup-key-row">
        <span className="setup-key-name">custom (any env var)</span>
        <input
          className="text-input setup-key-input"
          placeholder="env var name, e.g. MY_LLM_API_KEY"
          value={env}
          onChange={(e) => setEnv(e.target.value)}
        />
        <input
          type="password"
          className="text-input setup-key-input"
          placeholder="key value"
          value={key}
          onChange={(e) => setKey(e.target.value)}
        />
        <button
          type="button"
          className="btn-ghost"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </button>
      </div>
      {msg && <p className="muted setup-note">{msg}</p>}
    </>
  );
}

/* ---------- Models ---------- */

function ModelsSection({
  config,
  onSaved,
}: {
  config: FusionConfig;
  onSaved: () => void;
}) {
  const [rows, setRows] = useState<ModelRow[]>(() => toRows(config));
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

  // Reset local rows whenever the upstream config changes.
  useEffect(() => {
    setRows(toRows(config));
  }, [config]);

  const update = (idx: number, patch: Partial<ModelRow>) => {
    setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };

  const remove = (idx: number) => {
    setRows((rs) => rs.filter((_, i) => i !== idx));
  };

  const add = () => {
    setRows((rs) => [
      ...rs,
      {
        id: "",
        provider: "anthropic",
        model: "",
        label: "",
        webSearch: false,
        reasoningEffort: "high",
        autoPanel: false,
        baseURL: "",
        apiKeyEnv: "",
        apiKeyHeader: "",
        headersText: "",
        extraParamsText: "",
      },
    ]);
  };

  const save = async () => {
    const ids = rows.map((r) => r.id.trim());
    if (ids.some((id) => id.length === 0)) {
      setMsg({ kind: "err", text: "Every model needs a non-empty id." });
      return;
    }
    if (new Set(ids).size !== ids.length) {
      setMsg({ kind: "err", text: "Model ids must be unique." });
      return;
    }
    setBusy(true);
    setMsg(null);
    try {
      const models: ConfigModel[] = rows.map((r) => {
        let headers: Record<string, string> | undefined;
        try {
          headers = parseJsonObject(r.headersText) as Record<string, string> | undefined;
        } catch {
          throw new Error(`headers for "${r.id}" is not a JSON object`);
        }
        let extraParams: Record<string, unknown> | undefined;
        try {
          extraParams = parseJsonObject(r.extraParamsText);
        } catch {
          throw new Error(`params for "${r.id}" is not a JSON object`);
        }
        return {
          id: r.id.trim(),
          provider: r.provider,
          model: r.model?.trim() ? r.model.trim() : undefined,
          label: r.label,
          webSearch: r.webSearch,
          costPer1MIn: r.costPer1MIn,
          costPer1MOut: r.costPer1MOut,
          excludeFromAuto: r.excludeFromAuto,
          reasoningEffort: r.reasoningEffort ?? "high",
          baseURL: r.baseURL?.trim() ? r.baseURL.trim() : undefined,
          apiKeyEnv: r.apiKeyEnv?.trim() ? r.apiKeyEnv.trim() : undefined,
          apiKeyHeader: r.apiKeyHeader?.trim() ? r.apiKeyHeader.trim() : undefined,
          headers,
          extraParams,
        };
      });
      const autoPanel = rows
        .filter((r) => r.autoPanel)
        .map((r) => r.id.trim());
      await updateConfig({ models, autoPanel });
      setMsg({ kind: "ok", text: "Models saved." });
      onSaved();
    } catch (err: unknown) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h3 className="card-title">Models</h3>
      {msg && (
        <div
          className={`banner inline-error ${
            msg.kind === "ok" ? "banner-ok" : "banner-error"
          }`}
        >
          {msg.text}
        </div>
      )}
      <div className="setup-table-scroll">
        <table className="strengths-table setup-models-table">
          <thead>
            <tr>
              <th>id</th>
              <th>provider</th>
              <th>model</th>
              <th>baseURL</th>
              <th>key env</th>
              <th>auth hdr</th>
              <th>label</th>
              <th>web</th>
              <th>effort</th>
              <th className="num">$/1M in</th>
              <th className="num">$/1M out</th>
              <th>auto</th>
              <th>headers (JSON)</th>
              <th>params (JSON)</th>
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
                    onChange={(e) => update(i, { id: e.target.value })}
                  />
                </td>
                <td>
                  <select
                    className="select-input"
                    value={r.provider}
                    onChange={(e) =>
                      update(i, { provider: e.target.value })
                    }
                  >
                    {MODEL_PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    value={r.model ?? ""}
                    onChange={(e) => update(i, { model: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    placeholder="http://localhost:11434/v1"
                    value={r.baseURL ?? ""}
                    onChange={(e) => update(i, { baseURL: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    placeholder="BASETEN_API_KEY"
                    value={r.apiKeyEnv ?? ""}
                    onChange={(e) => update(i, { apiKeyEnv: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    placeholder="Authorization"
                    value={r.apiKeyHeader ?? ""}
                    onChange={(e) => update(i, { apiKeyHeader: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    value={r.label}
                    onChange={(e) => update(i, { label: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.webSearch ?? false}
                    onChange={(e) =>
                      update(i, { webSearch: e.target.checked })
                    }
                  />
                </td>
                <td>
                  <select
                    className="select-input"
                    value={r.reasoningEffort ?? "high"}
                    onChange={(e) =>
                      update(i, {
                        reasoningEffort: e.target.value as ReasoningEffort,
                      })
                    }
                  >
                    {EFFORTS.map((eff) => (
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
                    onChange={(e) =>
                      update(i, { costPer1MIn: parseNum(e.target.value) })
                    }
                  />
                </td>
                <td className="num">
                  <input
                    type="number"
                    className="num-input"
                    value={r.costPer1MOut ?? ""}
                    onChange={(e) =>
                      update(i, { costPer1MOut: parseNum(e.target.value) })
                    }
                  />
                </td>
                <td>
                  <input
                    type="checkbox"
                    checked={r.autoPanel}
                    onChange={(e) =>
                      update(i, { autoPanel: e.target.checked })
                    }
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    placeholder='{ "X-Title": "app" }'
                    value={r.headersText}
                    onChange={(e) => update(i, { headersText: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    className="text-input cell-input"
                    placeholder='{ "temperature": 0.2 }'
                    value={r.extraParamsText}
                    onChange={(e) => update(i, { extraParamsText: e.target.value })}
                  />
                </td>
                <td>
                  <button
                    type="button"
                    className="btn-ghost btn-small"
                    onClick={() => remove(i)}
                  >
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
          Add model
        </button>
        <button
          type="button"
          className="composer-send"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save models"}
        </button>
      </div>
    </section>
  );
}

/* ---------- Settings ---------- */

function SettingsSection({
  config,
  onSaved,
}: {
  config: FusionConfig;
  onSaved: () => void;
}) {
  const [defaultJudge, setDefaultJudge] = useState(config.defaultJudge);
  const [classifierModel, setClassifierModel] = useState(
    config.classifierModel,
  );
  const [panelSize, setPanelSize] = useState(config.panelSize);
  const [webSearch, setWebSearch] = useState(config.webSearch);
  const [explorationRate, setExplorationRate] = useState(
    config.explorationRate,
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null,
  );

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
      await updateConfig({
        defaultJudge,
        classifierModel,
        panelSize,
        webSearch,
        explorationRate,
      });
      setMsg({ kind: "ok", text: "Settings saved." });
      onSaved();
    } catch (err: unknown) {
      setMsg({
        kind: "err",
        text: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setBusy(false);
    }
  };

  const modelIds = config.models.map((m) => m.id);

  return (
    <section className="card">
      <h3 className="card-title">Settings</h3>
      {msg && (
        <div
          className={`banner inline-error ${
            msg.kind === "ok" ? "banner-ok" : "banner-error"
          }`}
        >
          {msg.text}
        </div>
      )}
      <div className="setup-settings">
        <label className="settings-inline">
          Default judge
          <select
            className="select-input"
            value={defaultJudge}
            onChange={(e) => setDefaultJudge(e.target.value)}
          >
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-inline">
          Classifier model
          <select
            className="select-input"
            value={classifierModel}
            onChange={(e) => setClassifierModel(e.target.value)}
          >
            {modelIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>
        </label>
        <label className="settings-inline">
          Panel size
          <input
            type="number"
            min={1}
            className="num-input"
            value={panelSize}
            onChange={(e) =>
              setPanelSize(Math.max(1, Math.floor(Number(e.target.value) || 1)))
            }
          />
        </label>
        <label className="settings-inline">
          <input
            type="checkbox"
            checked={webSearch}
            onChange={(e) => setWebSearch(e.target.checked)}
          />
          Web search
        </label>
        <label className="settings-inline">
          Exploration rate
          <input
            type="number"
            min={0}
            max={1}
            step={0.05}
            className="num-input"
            value={explorationRate}
            onChange={(e) =>
              setExplorationRate(
                clampRate(Number(e.target.value)),
              )
            }
          />
        </label>
      </div>
      <div className="setup-actions">
        <button
          type="button"
          className="composer-send"
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "Saving…" : "Save settings"}
        </button>
      </div>
    </section>
  );
}

/* ---------- helpers ---------- */

function toRows(config: FusionConfig): ModelRow[] {
  const auto = new Set(config.autoPanel);
  return config.models.map((m) => ({
    ...m,
    autoPanel: auto.has(m.id),
    headersText: m.headers ? JSON.stringify(m.headers) : "",
    extraParamsText: m.extraParams ? JSON.stringify(m.extraParams) : "",
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
