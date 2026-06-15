import { useState } from "react";
import type { PanelResponse } from "../types";

export interface PanelState {
  modelId: string;
  label: string;
  text: string;
  done: boolean;
  response?: PanelResponse;
}

interface Props {
  panel: PanelState;
  /** Default collapsed state once a final answer exists. */
  defaultCollapsed: boolean;
}

export function PanelCard({ panel, defaultCollapsed }: Props) {
  // `undefined` => follow the defaultCollapsed prop; once user toggles, lock it.
  const [override, setOverride] = useState<boolean | null>(null);
  const collapsed = override ?? defaultCollapsed;

  const resp = panel.response;
  const hasError = Boolean(resp?.error);
  const sourceCount = resp?.citations?.length ?? 0;

  return (
    <div
      className={`panel-card ${hasError ? "panel-card-error" : ""} ${
        panel.done ? "panel-card-done" : "panel-card-active"
      }`}
    >
      <button
        type="button"
        className="panel-card-head"
        aria-expanded={!collapsed}
        onClick={() => setOverride(!collapsed)}
      >
        <span className="panel-card-title">
          {!panel.done && <span className="spinner" aria-hidden="true" />}
          {panel.label}
        </span>
        <span className="panel-card-meta">
          {hasError ? (
            <span className="badge badge-error">error</span>
          ) : panel.done ? (
            <>
              {resp && (
                <span className="badge">{formatLatency(resp.latencyMs)}</span>
              )}
              {sourceCount > 0 && (
                <span className="badge">
                  {sourceCount} source{sourceCount === 1 ? "" : "s"}
                </span>
              )}
            </>
          ) : (
            <span className="badge badge-thinking">thinking…</span>
          )}
          <span className="chevron" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>
        </span>
      </button>

      {!collapsed && (
        <div className="panel-card-body">
          {hasError ? (
            <div className="panel-error-text">{resp?.error}</div>
          ) : (
            <div className="panel-text">
              {panel.text.length > 0 ? (
                panel.text
              ) : (
                <span className="muted">Waiting for first token…</span>
              )}
            </div>
          )}
          {resp && resp.citations && resp.citations.length > 0 && (
            <ul className="citations">
              {resp.citations.map((c, i) => (
                <li key={`${c.url}-${i}`}>
                  <a href={c.url} target="_blank" rel="noreferrer noopener">
                    {c.title || c.url}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {resp && (
            <div className="panel-card-foot muted">
              {resp.provider}
              {resp.usage?.outputTokens != null &&
                ` · ${resp.usage.outputTokens} out tok`}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
