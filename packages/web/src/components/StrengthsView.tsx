import { useCallback, useEffect, useState } from "react";
import type { FusionConfig, ModelStrength, RunSummary } from "../types";
import { getRuns, getStrengths } from "../api";
import { useT } from "../i18n";

interface Props {
    config: FusionConfig | null;
}

export function StrengthsView({ config }: Props) {
    const { t } = useT();
    const [category, setCategory] = useState<string>("");
    const [strengths, setStrengths] = useState<ModelStrength[]>([]);
    const [runs, setRuns] = useState<RunSummary[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const [s, r] = await Promise.all([getStrengths(category || undefined), getRuns(25)]);
            setStrengths([...s].sort((a, b) => b.score - a.score));
            setRuns(r);
        } catch (err: unknown) {
            setError(err instanceof Error ? err.message : String(err));
        } finally {
            setLoading(false);
        }
    }, [category]);

    useEffect(() => {
        void load();
    }, [load]);

    const categories = config?.categories ?? [];
    const labelFor = (modelId: string): string => config?.models.find(m => m.id === modelId)?.label ?? modelId;

    return (
        <div className="strengths">
            <div className="strengths-bar">
                <h2>{t("strengths.title")}</h2>
                <div className="strengths-controls">
                    <label className="settings-inline">
                        {t("strengths.category")}
                        <select className="select-input" value={category} onChange={e => setCategory(e.target.value)}>
                            <option value="">{t("strengths.all")}</option>
                            {categories.map(c => (
                                <option key={c} value={c}>
                                    {c}
                                </option>
                            ))}
                        </select>
                    </label>
                    <button type="button" className="btn-ghost" onClick={() => void load()} disabled={loading}>
                        {loading ? t("strengths.refreshing") : t("strengths.refresh")}
                    </button>
                </div>
            </div>

            {error && <div className="banner banner-error inline-error">{error}</div>}

            <div className="strengths-grid">
                <section className="card">
                    <h3 className="card-title">
                        {t("strengths.scoresByModel")}
                        {category ? ` · ${category}` : ""}
                    </h3>
                    {strengths.length === 0 ?
                        <p className="muted">{loading ? t("strengths.loading") : t("strengths.empty")}</p>
                    :   <table className="strengths-table">
                            <thead>
                                <tr>
                                    <th>{t("strengths.colModel")}</th>
                                    <th>{t("strengths.colCategory")}</th>
                                    <th className="col-score">{t("strengths.colScore")}</th>
                                    <th className="num">{t("strengths.colAvgContrib")}</th>
                                    <th className="num">{t("strengths.colFeedback")}</th>
                                    <th className="num">{t("strengths.colRuns")}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {strengths.map(s => (
                                    <tr key={`${s.modelId}-${s.category}`}>
                                        <td>{labelFor(s.modelId)}</td>
                                        <td>
                                            <span className="badge">{s.category}</span>
                                        </td>
                                        <td className="col-score">
                                            <div className="score-cell">
                                                <div className="score-track">
                                                    <div
                                                        className="score-fill"
                                                        style={{ width: `${clamp01(s.score) * 100}%` }}
                                                    />
                                                </div>
                                                <span className="score-num">
                                                    {(clamp01(s.score) * 100).toFixed(0)}%
                                                </span>
                                            </div>
                                        </td>
                                        <td className="num">{s.avgContribution.toFixed(2)}</td>
                                        <td className="num">
                                            <span
                                                className={
                                                    s.feedbackScore > 0 ? "fb-pos"
                                                    : s.feedbackScore < 0 ?
                                                        "fb-neg"
                                                    :   "muted"
                                                }
                                            >
                                                {s.feedbackScore > 0 ? "+" : ""}
                                                {s.feedbackScore}
                                            </span>{" "}
                                            <span className="muted">({s.feedbackCount})</span>
                                        </td>
                                        <td className="num">{s.runs}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    }
                </section>

                <section className="card">
                    <h3 className="card-title">{t("strengths.recentRuns")}</h3>
                    {runs.length === 0 ?
                        <p className="muted">{loading ? t("strengths.loading") : t("strengths.noRuns")}</p>
                    :   <ul className="runs-list">
                            {runs.map(r => (
                                <li key={r.id} className="run-item">
                                    <div className="run-main">
                                        <span className="badge">{r.category}</span>
                                        <span className="run-judge muted">
                                            {t("strengths.runJudge", { label: labelFor(r.judge_model) })}
                                        </span>
                                    </div>
                                    <time className="run-time muted">{formatTime(r.created_at)}</time>
                                </li>
                            ))}
                        </ul>
                    }
                </section>
            </div>
        </div>
    );
}

function clamp01(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.min(1, Math.max(0, n));
}

function formatTime(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
