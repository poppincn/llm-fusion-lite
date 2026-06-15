import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatMessage,
  FusionConfig,
  FusionResult,
  JudgeAnalysis,
  PanelMember,
  Rating,
} from "../types";
import { sendFeedback, streamFuse } from "../api";
import { SettingsBar } from "./SettingsBar";
import type { FusionSettings } from "./SettingsBar";
import { Composer } from "./Composer";
import { PanelCard } from "./PanelCard";
import type { PanelState } from "./PanelCard";
import { AnalysisPanel } from "./AnalysisPanel";

interface AssistantTurn {
  id: string;
  role: "assistant";
  result: FusionResult;
}

interface UserTurn {
  id: string;
  role: "user";
  content: string;
}

type Turn = UserTurn | AssistantTurn;

interface LiveRun {
  category: string;
  panelMembers: PanelMember[];
  panels: Record<string, PanelState>;
  panelOrder: string[];
  judgeModelId: string | null;
  analysis: JudgeAnalysis | null;
  answer: string;
  phase: "selecting" | "panel" | "judging" | "finalizing";
}

function emptyRun(): LiveRun {
  return {
    category: "",
    panelMembers: [],
    panels: {},
    panelOrder: [],
    judgeModelId: null,
    analysis: null,
    answer: "",
    phase: "selecting",
  };
}

interface Props {
  config: FusionConfig | null;
}

export function ChatView({ config }: Props) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [live, setLive] = useState<LiveRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<FusionSettings | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Initialize settings once config arrives.
  useEffect(() => {
    if (config && settings === null) {
      setSettings({
        webSearch: config.webSearch,
        judge: config.defaultJudge,
        panelSize: config.panelSize,
        panel: [],
      });
    }
  }, [config, settings]);

  // Autoscroll on new content.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns, live]);

  // Cancel any in-flight run on unmount.
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const inFlight = live !== null;

  const conversationMessages = useMemo<ChatMessage[]>(() => {
    return turns.map((t) =>
      t.role === "user"
        ? { role: "user" as const, content: t.content }
        : { role: "assistant" as const, content: t.result.finalAnswer },
    );
  }, [turns]);

  const send = async (text: string) => {
    if (inFlight) return;
    setError(null);

    const userTurn: UserTurn = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    const history: ChatMessage[] = [
      ...conversationMessages,
      { role: "user", content: text },
    ];

    setTurns((prev) => [...prev, userTurn]);
    setLive(emptyRun());

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      await streamFuse(
        {
          messages: history,
          panel: settings && settings.panel.length > 0 ? settings.panel : undefined,
          judge: settings?.judge || undefined,
          panel_size: settings?.panelSize,
          web_search: settings?.webSearch,
        },
        (event) => {
          setLive((prev) => reduceLive(prev, event));
          if (event.type === "done") {
            const result = event.result;
            setTurns((prev) => [
              ...prev,
              { id: crypto.randomUUID(), role: "assistant", result },
            ]);
            setLive(null);
          } else if (event.type === "error") {
            setError(event.message);
          }
        },
        controller.signal,
      );
    } catch (err: unknown) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // If the stream ended without a `done` event, clear the live block.
      setLive((prev) => (prev ? null : prev));
      abortRef.current = null;
    }
  };

  const cancel = () => {
    abortRef.current?.abort();
    setLive(null);
  };

  return (
    <div className="chat">
      <div className="chat-scroll" ref={scrollRef}>
        {turns.length === 0 && !live && (
          <div className="empty-state">
            <h2>Fuse the best of every model</h2>
            <p className="muted">
              Your prompt is dispatched to a panel of models in parallel. A
              judge synthesizes one best answer and the system learns each
              model's strengths over time.
            </p>
          </div>
        )}

        {turns.map((t) =>
          t.role === "user" ? (
            <UserBubble key={t.id} content={t.content} />
          ) : (
            <AssistantBubble key={t.id} result={t.result} />
          ),
        )}

        {live && <LiveBlock run={live} />}

        {error && (
          <div className="banner banner-error inline-error">{error}</div>
        )}
      </div>

      <div className="chat-footer">
        {settings && (
          <SettingsBar
            config={config}
            settings={settings}
            onChange={setSettings}
            disabled={inFlight}
          />
        )}
        <div className="composer-row">
          <Composer onSend={send} disabled={inFlight} />
          {inFlight && (
            <button type="button" className="btn-ghost cancel-btn" onClick={cancel}>
              Stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function reduceLive(prev: LiveRun | null, event: import("../types").FusionEvent): LiveRun | null {
  const run = prev ?? emptyRun();
  switch (event.type) {
    case "category":
      return { ...run, category: event.category };
    case "panel_selected": {
      const panels: Record<string, PanelState> = {};
      const order: string[] = [];
      for (const m of event.panel) {
        panels[m.id] = {
          modelId: m.id,
          label: m.label,
          text: "",
          done: false,
        };
        order.push(m.id);
      }
      return {
        ...run,
        panelMembers: event.panel,
        panels,
        panelOrder: order,
        phase: "panel",
      };
    }
    case "panel_start": {
      const existing = run.panels[event.modelId];
      const panels = {
        ...run.panels,
        [event.modelId]: existing ?? {
          modelId: event.modelId,
          label: event.label,
          text: "",
          done: false,
        },
      };
      const order = run.panelOrder.includes(event.modelId)
        ? run.panelOrder
        : [...run.panelOrder, event.modelId];
      return { ...run, panels, panelOrder: order, phase: "panel" };
    }
    case "panel_token": {
      const existing = run.panels[event.modelId];
      if (!existing) return run;
      return {
        ...run,
        panels: {
          ...run.panels,
          [event.modelId]: { ...existing, text: existing.text + event.token },
        },
      };
    }
    case "panel_done": {
      const r = event.response;
      const existing = run.panels[r.modelId];
      return {
        ...run,
        panels: {
          ...run.panels,
          [r.modelId]: {
            modelId: r.modelId,
            label: r.label || existing?.label || r.modelId,
            text: r.text || existing?.text || "",
            done: true,
            response: r,
          },
        },
      };
    }
    case "judge_start":
      return { ...run, judgeModelId: event.judgeModelId, phase: "judging" };
    case "analysis":
      return { ...run, analysis: event.analysis, phase: "finalizing" };
    case "answer_token":
      return { ...run, answer: run.answer + event.token, phase: "finalizing" };
    case "done":
    case "error":
      return run;
    default:
      return run;
  }
}

function UserBubble({ content }: { content: string }) {
  return (
    <div className="turn turn-user">
      <div className="bubble bubble-user">{content}</div>
    </div>
  );
}

function LiveBlock({ run }: { run: LiveRun }) {
  const panels = run.panelOrder
    .map((id) => run.panels[id])
    .filter((p): p is PanelState => Boolean(p));

  return (
    <div className="turn turn-assistant">
      <div className="fusion-live">
        <div className="fusion-status">
          <span className="spinner" aria-hidden="true" />
          <span>{phaseLabel(run.phase)}</span>
          {run.category && <span className="badge">{run.category}</span>}
        </div>

        {run.panelMembers.length > 0 && (
          <div className="panel-chips">
            {run.panelMembers.map((m) => (
              <span key={m.id} className="chip">
                {m.label}
              </span>
            ))}
          </div>
        )}

        {panels.length > 0 && (
          <div className="panel-grid">
            {panels.map((p) => (
              <PanelCard key={p.modelId} panel={p} defaultCollapsed={false} />
            ))}
          </div>
        )}

        {(run.answer.length > 0 || run.judgeModelId) && (
          <div className="synth">
            <div className="synth-head">
              <h3>Synthesized answer</h3>
              {run.judgeModelId && (
                <span className="badge badge-judge">
                  judge: {run.judgeModelId}
                </span>
              )}
            </div>
            <div className="answer-text">
              {run.answer.length > 0 ? (
                run.answer
              ) : (
                <span className="muted">Synthesizing…</span>
              )}
              {run.phase === "finalizing" && (
                <span className="caret" aria-hidden="true" />
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function phaseLabel(phase: LiveRun["phase"]): string {
  switch (phase) {
    case "selecting":
      return "Selecting panel…";
    case "panel":
      return "Panel is responding…";
    case "judging":
      return "Judge is analyzing responses…";
    case "finalizing":
      return "Synthesizing final answer…";
  }
}

function AssistantBubble({ result }: { result: FusionResult }) {
  const [collapsed, setCollapsed] = useState(true);
  const [vote, setVote] = useState<Rating | null>(null);
  const [voting, setVoting] = useState(false);

  const submitVote = async (rating: Rating) => {
    if (voting) return;
    setVoting(true);
    const prev = vote;
    setVote(rating);
    try {
      await sendFeedback({ runId: result.id, rating });
    } catch {
      setVote(prev); // revert on failure
    } finally {
      setVoting(false);
    }
  };

  const cost = result.usage.estCostUsd;

  return (
    <div className="turn turn-assistant">
      <div className="fusion-result">
        <div className="synth">
          <div className="synth-head">
            <h3>Synthesized answer</h3>
            <span className="badge badge-judge">
              judge: {result.judgeModelId}
            </span>
          </div>
          <div className="answer-text">{result.finalAnswer}</div>
        </div>

        <div className="result-footer">
          <div className="result-meta">
            <span className="badge">{result.category}</span>
            <span className="muted">
              {result.usage.inputTokens + result.usage.outputTokens} tokens
              {typeof cost === "number" && ` · $${cost.toFixed(4)}`}
            </span>
            {result.webSearch && <span className="badge">web</span>}
          </div>

          <div className="feedback">
            <button
              type="button"
              className={`vote ${vote === 1 ? "vote-on" : ""}`}
              disabled={voting}
              aria-label="Helpful"
              onClick={() => submitVote(1)}
            >
              👍
            </button>
            <button
              type="button"
              className={`vote ${vote === -1 ? "vote-on" : ""}`}
              disabled={voting}
              aria-label="Not helpful"
              onClick={() => submitVote(-1)}
            >
              👎
            </button>
            {vote !== null && (
              <span className="vote-thanks muted">Thanks for the feedback</span>
            )}
          </div>
        </div>

        <button
          type="button"
          className="panels-toggle"
          aria-expanded={!collapsed}
          onClick={() => setCollapsed((c) => !c)}
        >
          <span className="chevron" aria-hidden="true">
            {collapsed ? "▸" : "▾"}
          </span>{" "}
          {collapsed ? "Show" : "Hide"} {result.panel.length} panelist
          {result.panel.length === 1 ? "" : "s"}
        </button>

        {!collapsed && (
          <div className="panel-grid">
            {result.panel.map((p) => (
              <PanelCard
                key={p.modelId}
                panel={{
                  modelId: p.modelId,
                  label: p.label,
                  text: p.text,
                  done: true,
                  response: p,
                }}
                defaultCollapsed
              />
            ))}
          </div>
        )}

        <AnalysisPanel analysis={result.analysis} panel={result.panel} />
      </div>
    </div>
  );
}
