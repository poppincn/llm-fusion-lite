#!/usr/bin/env node
/**
 * Era Fusion MCP server — exposes `fuse` as a tool to any MCP-capable agentic
 * coding stack (Claude Code, Codex, Cursor, Windsurf, Zed, Continue, …). The
 * agent calls it when IT decides a problem warrants a multi-model council —
 * fusion is an escalation tool, not a per-turn model.
 *
 * Runs the engine in-process with the user's ~/.era-fusion config + keys, so the
 * learning store persists and agentic mode uses their LOCAL sandbox container.
 * stdio transport (the standard for local MCP): stdout carries the JSON-RPC
 * protocol ONLY — all human-readable output goes to stderr.
 *
 * Install (Claude Code .mcp.json / Codex config / Cursor): run
 *   npx -y @alexanderollman/llm-fusion fuse-mcp
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { fuse, loadConfig, loadEnv, FusionStore } from "@era-fusion/core";

loadEnv();
// One store for the process — learning accumulates across calls.
const store = new FusionStore();

const server = new McpServer({ name: "era-fusion", version: "0.1.0" });

server.registerTool(
  "fuse",
  {
    title: "Fuse — multi-model consensus",
    description:
      "Escalate a HARD, high-stakes, or ambiguous question to a panel of multiple frontier AI models and return one synthesized best answer (influence-weighted judge that learns each model's per-subject strengths). Use for architecture decisions, planning, deep research, or tricky debugging where multi-model consensus beats a single model — NOT for trivial or quick questions (it is slower and more expensive). Set agentic=true to let panelists use sandboxed tools (code execution, web search) to ground computation and current facts.",
    inputSchema: {
      prompt: z.string().describe("The question or task to fuse. Be specific and include the context the panel needs to reason well."),
      depth: z.enum(["light", "standard", "deep"]).optional().describe("Reasoning depth. Omit to auto-select per the request; 'deep' turns on all techniques (refine, rank, self-consistency, verify)."),
      agentic: z.boolean().optional().describe("Run panelists as sandboxed tool-using agents (requires the era-fusion sandbox container running). Best for exact computation or current-information questions."),
      panel: z.array(z.string()).optional().describe("Explicit model ids to use as the panel (otherwise adaptive selection by learned subject expertise)."),
      judge: z.string().optional().describe("Judge/synthesizer model id (otherwise the configured default)."),
    },
  },
  async (args) => {
    const config = loadConfig();
    try {
      const r = await fuse(
        { prompt: args.prompt, depth: args.depth, agentic: args.agentic, panel: args.panel, judge: args.judge },
        { config, store },
      );
      const header = `[fusion · ${r.category} · depth ${r.depth}${args.agentic ? " · agentic" : ""} · panel: ${r.panel
        .map((p) => p.label)
        .join(", ")} · judge: ${r.judgeModelId}]`;
      return { content: [{ type: "text" as const, text: `${header}\n\n${r.finalAnswer}` }] };
    } catch (err) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `Fusion failed: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("era-fusion MCP server ready (stdio). Tool: fuse");
