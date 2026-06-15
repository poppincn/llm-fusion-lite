import { useCallback, useEffect, useState } from "react";
import type { Usage } from "../types";
import { getUsage } from "../api";

export function UsageView() {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const u = await getUsage();
      setUsage(u);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const totals = usage?.totals;
  const byProvider = usage?.byProvider ?? [];
  const byModel = [...(usage?.byModel ?? [])].sort(
    (a, b) => b.costUsd - a.costUsd,
  );
  const maxProviderCost = Math.max(
    1e-9,
    ...byProvider.map((p) => p.costUsd),
  );

  const empty = totals !== undefined && totals.calls === 0;

  return (
    <div className="strengths">
      <div className="strengths-bar">
        <h2>Usage</h2>
        <div className="strengths-controls">
          <button
            type="button"
            className="btn-ghost"
            onClick={() => void load()}
            disabled={loading}
          >
            {loading ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </div>

      {error && <div className="banner banner-error inline-error">{error}</div>}

      {!usage ? (
        <p className="muted">{loading ? "Loading…" : "No data."}</p>
      ) : empty ? (
        <section className="card">
          <p className="muted">No usage yet — run some fusions.</p>
        </section>
      ) : (
        <>
          {totals && (
            <div className="usage-cards">
              <div className="usage-card">
                <span className="usage-card-value">
                  {totals.runs.toLocaleString()}
                </span>
                <span className="usage-card-label">Runs</span>
              </div>
              <div className="usage-card">
                <span className="usage-card-value">
                  {totals.calls.toLocaleString()}
                </span>
                <span className="usage-card-label">Model calls</span>
              </div>
              <div className="usage-card">
                <span className="usage-card-value">
                  {fmtTokens(totals.inputTokens)}
                </span>
                <span className="usage-card-label">Input tokens</span>
              </div>
              <div className="usage-card">
                <span className="usage-card-value">
                  {fmtTokens(totals.outputTokens)}
                </span>
                <span className="usage-card-label">Output tokens</span>
              </div>
              <div className="usage-card">
                <span className="usage-card-value">
                  {fmtCost(totals.costUsd)}
                </span>
                <span className="usage-card-label">Est. cost</span>
              </div>
            </div>
          )}

          <div className="strengths-grid">
            <section className="card">
              <h3 className="card-title">By provider</h3>
              {byProvider.length === 0 ? (
                <p className="muted">No data.</p>
              ) : (
                <table className="strengths-table">
                  <thead>
                    <tr>
                      <th>Provider</th>
                      <th className="num">Calls</th>
                      <th className="num">Input</th>
                      <th className="num">Output</th>
                      <th className="col-score">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byProvider.map((p) => (
                      <tr key={p.provider}>
                        <td>
                          <span className="badge">{p.provider}</span>
                        </td>
                        <td className="num">{p.calls.toLocaleString()}</td>
                        <td className="num">{fmtTokens(p.inputTokens)}</td>
                        <td className="num">{fmtTokens(p.outputTokens)}</td>
                        <td className="col-score">
                          <div className="score-cell">
                            <div className="score-track">
                              <div
                                className="score-fill"
                                style={{
                                  width: `${(p.costUsd / maxProviderCost) * 100}%`,
                                }}
                              />
                            </div>
                            <span className="score-num">
                              {fmtCost(p.costUsd)}
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="card">
              <h3 className="card-title">By model</h3>
              {byModel.length === 0 ? (
                <p className="muted">No data.</p>
              ) : (
                <table className="strengths-table">
                  <thead>
                    <tr>
                      <th>Model</th>
                      <th>Provider</th>
                      <th className="num">Calls</th>
                      <th className="num">Input</th>
                      <th className="num">Output</th>
                      <th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {byModel.map((m) => (
                      <tr key={m.modelId}>
                        <td>{m.modelId}</td>
                        <td>
                          <span className="badge">{m.provider}</span>
                        </td>
                        <td className="num">{m.calls.toLocaleString()}</td>
                        <td className="num">{fmtTokens(m.inputTokens)}</td>
                        <td className="num">{fmtTokens(m.outputTokens)}</td>
                        <td className="num">{fmtCost(m.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}

function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}
