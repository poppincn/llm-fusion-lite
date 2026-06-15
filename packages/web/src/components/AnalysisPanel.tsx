import { useState } from "react";
import type { JudgeAnalysis, PanelResponse } from "../types";

interface Props {
  analysis: JudgeAnalysis;
  panel: PanelResponse[];
}

export function AnalysisPanel({ analysis, panel }: Props) {
  const [open, setOpen] = useState(false);

  const labelFor = (modelId: string): string =>
    panel.find((p) => p.modelId === modelId)?.label ?? modelId;

  const contributions = [...analysis.contributions].sort(
    (a, b) => b.score - a.score,
  );
  const maxScore = contributions.reduce((m, c) => Math.max(m, c.score), 0) || 1;

  return (
    <div className="analysis">
      <button
        type="button"
        className="analysis-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="chevron" aria-hidden="true">
          {open ? "▾" : "▸"}
        </span>{" "}
        How the answer was synthesized
      </button>

      {open && (
        <div className="analysis-body">
          {analysis.summary && (
            <p className="analysis-summary">{analysis.summary}</p>
          )}

          <ListSection title="Consensus" items={analysis.consensus} />
          <ListSection
            title="Contradictions"
            items={analysis.contradictions}
            tone="warn"
          />
          <ListSection title="Gaps" items={analysis.gaps} tone="muted" />

          {analysis.uniqueInsights.length > 0 && (
            <div className="analysis-section">
              <h4>Unique insights</h4>
              <ul className="insight-list">
                {analysis.uniqueInsights.map((ui, i) => (
                  <li key={`${ui.modelId}-${i}`}>
                    <span className="insight-model">
                      {labelFor(ui.modelId)}
                    </span>
                    <span className="insight-text">{ui.insight}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {contributions.length > 0 && (
            <div className="analysis-section">
              <h4>Model contributions</h4>
              <div className="contrib-list">
                {contributions.map((c) => (
                  <div className="contrib-row" key={c.modelId}>
                    <div className="contrib-head">
                      <span className="contrib-model">
                        {labelFor(c.modelId)}
                      </span>
                      <span className="contrib-score">
                        {Math.round(c.score * 100) / 100}
                      </span>
                    </div>
                    <div className="contrib-bar-track">
                      <div
                        className="contrib-bar-fill"
                        style={{
                          width: `${Math.max(2, (c.score / maxScore) * 100)}%`,
                        }}
                      />
                    </div>
                    {c.reason && (
                      <div className="contrib-reason muted">{c.reason}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ListSection({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone?: "warn" | "muted";
}) {
  if (!items || items.length === 0) return null;
  return (
    <div className="analysis-section">
      <h4>{title}</h4>
      <ul className={`bullet-list ${tone ? `bullet-${tone}` : ""}`}>
        {items.map((it, i) => (
          <li key={i}>{it}</li>
        ))}
      </ul>
    </div>
  );
}
