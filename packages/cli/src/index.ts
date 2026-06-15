#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import chalk from "chalk";
import {
  fuse,
  loadEnv,
  loadConfig,
  configPath,
  fusionHome,
  FusionStore,
  availableAutoPanel,
  configuredProviders,
  type FusionEvent,
} from "@era-fusion/core";

loadEnv(); // pick up ~/.era-fusion/.env or ./.env (never overrides real env vars)

const err = process.stderr;
const log = (s = "") => err.write(s + "\n");

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

const program = new Command();
program
  .name("fuse")
  .description("Era Fusion — multi-model synthesis with adaptive, learned model strengths.")
  .version("0.1.0");

// ---- run (default) ----
program
  .argument("[prompt...]", "the prompt (or pipe via stdin)")
  .option("-p, --panel <ids>", "comma-separated model ids (overrides adaptive selection)")
  .option("-j, --judge <id>", "judge/synthesizer model id")
  .option("-s, --size <n>", "panel size for adaptive selection", (v) => parseInt(v, 10))
  .option("-c, --category <name>", "force a category (skips classification)")
  .option("--no-web", "disable web search")
  .option("-q, --quiet", "only print the final answer (no panel progress)")
  .option("--json", "print the full FusionResult as JSON")
  .action(async (promptParts: string[], opts) => {
    const stdin = await readStdin();
    const prompt = [stdin, promptParts.join(" ")].filter(Boolean).join("\n\n").trim();
    if (!prompt) {
      log(chalk.red("No prompt. Pass text as args or pipe via stdin."));
      program.help();
      return;
    }

    const config = loadConfig();
    if (availableAutoPanel(config).length === 0) {
      log(chalk.red("No models available. Set ANTHROPIC_API_KEY (and optionally OPENAI/GOOGLE)."));
      process.exit(1);
    }

    const store = new FusionStore();
    const quiet = opts.quiet || opts.json;
    let runId = "";

    const onEvent = (e: FusionEvent) => {
      if (quiet) {
        if (!opts.json && e.type === "answer_token") process.stdout.write(e.token);
        if (e.type === "done") runId = e.result.id;
        return;
      }
      switch (e.type) {
        case "category":
          log(chalk.dim(`category: ${e.category}`));
          break;
        case "panel_selected":
          log(chalk.cyan(`panel: ${e.panel.map((p) => p.label).join(", ")}`));
          break;
        case "panel_done": {
          const r = e.response;
          if (r.error) log(chalk.red(`  ✗ ${r.label}: ${r.error}`));
          else
            log(
              chalk.green(`  ✓ ${r.label}`) +
                chalk.dim(` (${r.latencyMs}ms${r.citations?.length ? `, ${r.citations.length} sources` : ""})`),
            );
          break;
        }
        case "judge_start":
          log(chalk.magenta(`\nsynthesizing (judge: ${e.judgeModelId})…\n`));
          break;
        case "answer_token":
          process.stdout.write(e.token);
          break;
        case "done":
          runId = e.result.id;
          break;
      }
    };

    try {
      const result = await fuse(
        {
          prompt,
          panel: opts.panel ? String(opts.panel).split(",").map((s) => s.trim()) : undefined,
          judge: opts.judge,
          panelSize: opts.size,
          category: opts.category,
          webSearch: opts.web,
          onEvent,
        },
        { config, store },
      );
      if (opts.json) {
        process.stdout.write(JSON.stringify(result, null, 2));
      } else {
        process.stdout.write("\n");
      }
      if (!quiet) {
        const cost = result.usage.estCostUsd;
        log(
          chalk.dim(
            `\n— run ${runId.slice(0, 8)} · ${result.usage.inputTokens + result.usage.outputTokens} tok` +
              (cost ? ` · ~$${cost.toFixed(4)}` : "") +
              ` · feedback: fuse feedback ${runId.slice(0, 8)} up|down`,
          ),
        );
      }
    } catch (e) {
      log(chalk.red(`\nfusion failed: ${e instanceof Error ? e.message : String(e)}`));
      process.exit(1);
    } finally {
      store.close();
    }
  });

// ---- serve ----
program
  .command("serve")
  .description("start the Era Fusion server (OpenAI-compatible endpoint + web UI)")
  .option("--port <n>", "port", (v) => parseInt(v, 10))
  .action(async (opts) => {
    const { startServer } = await import("@era-fusion/server");
    const { port } = startServer({ port: opts.port });
    log(chalk.green(`\n  Era Fusion → http://localhost:${port}`));
    log(chalk.dim(`  OpenAI-compatible base URL: http://localhost:${port}/v1\n`));
  });

// ---- stats ----
program
  .command("stats [category]")
  .description("show learned model strengths")
  .action((category?: string) => {
    const store = new FusionStore();
    const strengths = store
      .getStrengths(category)
      .sort((a, b) => b.score - a.score);
    store.close();
    if (!strengths.length) {
      log(chalk.dim("No data yet. Run some fusions first."));
      return;
    }
    log(chalk.bold(`\nLearned strengths${category ? ` · ${category}` : ""}\n`));
    log(
      chalk.dim(
        "model".padEnd(22) + "category".padEnd(12) + "score".padEnd(8) + "contrib".padEnd(9) + "fb".padEnd(7) + "runs",
      ),
    );
    for (const s of strengths) {
      log(
        s.modelId.padEnd(22) +
          s.category.padEnd(12) +
          bar(s.score).padEnd(8) +
          s.avgContribution.toFixed(2).padEnd(9) +
          (s.feedbackScore >= 0 ? "+" : "") +
          s.feedbackScore.toFixed(2).padEnd(6) +
          " " +
          String(s.runs),
      );
    }
    log("");
  });

// ---- usage ----
program
  .command("usage")
  .description("show total token/cost usage per provider and model")
  .action(() => {
    const store = new FusionStore();
    const u = store.getUsage();
    store.close();
    if (u.totals.calls === 0) {
      log(chalk.dim("No usage yet. Run some fusions first."));
      return;
    }
    const tok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
    log(chalk.bold("\nUsage totals"));
    log(
      chalk.dim(
        `  ${u.totals.runs} runs · ${u.totals.calls} model calls · ${tok(u.totals.inputTokens)} in / ${tok(
          u.totals.outputTokens,
        )} out · ~$${u.totals.costUsd.toFixed(4)}`,
      ),
    );
    log(chalk.bold("\nBy provider"));
    log(chalk.dim("provider".padEnd(12) + "calls".padEnd(8) + "in".padEnd(9) + "out".padEnd(9) + "cost"));
    for (const p of u.byProvider) {
      log(
        p.provider.padEnd(12) +
          String(p.calls).padEnd(8) +
          tok(p.inputTokens).padEnd(9) +
          tok(p.outputTokens).padEnd(9) +
          "$" +
          p.costUsd.toFixed(4),
      );
    }
    log(chalk.bold("\nBy model"));
    log(chalk.dim("model".padEnd(22) + "calls".padEnd(8) + "in".padEnd(9) + "out".padEnd(9) + "cost"));
    for (const m of u.byModel) {
      log(
        m.modelId.padEnd(22) +
          String(m.calls).padEnd(8) +
          tok(m.inputTokens).padEnd(9) +
          tok(m.outputTokens).padEnd(9) +
          "$" +
          m.costUsd.toFixed(4),
      );
    }
    log("");
  });

// ---- feedback ----
program
  .command("feedback <runId> <rating> [modelId]")
  .description("record feedback for a run: rating = up|down")
  .action((runId: string, rating: string, modelId?: string) => {
    const r = /^up|good|\+1?$/i.test(rating) ? 1 : /^down|bad|-1?$/i.test(rating) ? -1 : 0;
    if (r === 0) {
      log(chalk.red("rating must be up or down"));
      process.exit(1);
    }
    const store = new FusionStore();
    // Allow short run-id prefixes.
    const full = store.recentRuns(200).find((x) => x.id.startsWith(runId))?.id ?? runId;
    store.recordFeedback(full, r as 1 | -1, modelId);
    store.close();
    log(chalk.green(`recorded ${r > 0 ? "👍" : "👎"} for ${full.slice(0, 8)}${modelId ? ` · ${modelId}` : ""}`));
  });

// ---- config / models ----
program
  .command("config")
  .description("show config location and current settings")
  .action(() => {
    const config = loadConfig();
    log(chalk.bold("\nEra Fusion config"));
    log(chalk.dim(`  home:   ${fusionHome()}`));
    log(chalk.dim(`  config: ${configPath()}`));
    log(`  judge:  ${config.defaultJudge}`);
    log(`  panel:  size ${config.panelSize}, web search ${config.webSearch ? "on" : "off"}`);
    log(`  providers configured: ${configuredProviders().join(", ") || chalk.red("none")}`);
    log("");
  });

program
  .command("models")
  .description("list known models and availability")
  .action(() => {
    const config = loadConfig();
    const avail = new Set(availableAutoPanel(config));
    log(chalk.bold("\nModels\n"));
    for (const m of config.models) {
      const ok = avail.has(m.id);
      const tag = ok ? chalk.green("●") : chalk.dim("○");
      log(`${tag} ${m.id.padEnd(22)} ${chalk.dim(m.provider.padEnd(10))} ${m.label}`);
    }
    log(chalk.dim(`\n● = available (key set & in auto panel)   ○ = not available\n`));
  });

// ---- doctor ----
function onPath(cmd: string): boolean {
  try {
    execFileSync(process.platform === "win32" ? "where" : "which", [cmd], {
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

program
  .command("doctor")
  .description("check environment: provider keys, optional CLIs, and readiness")
  .action(() => {
    const config = loadConfig();
    const providers = configuredProviders();
    const ok = (b: boolean) => (b ? chalk.green("✓") : chalk.red("✗"));
    const opt = (b: boolean) => (b ? chalk.green("✓") : chalk.dim("○"));

    log(chalk.bold("\nEra Fusion — doctor\n"));
    log(chalk.bold("Node"));
    log(`  ${ok(true)} node ${process.version}`);

    log(chalk.bold("\nProvider API keys (service backend)"));
    log(`  ${ok(!!process.env.ANTHROPIC_API_KEY)} ANTHROPIC_API_KEY` + dimUnset(!!process.env.ANTHROPIC_API_KEY));
    log(`  ${opt(!!process.env.OPENAI_API_KEY)} OPENAI_API_KEY` + dimUnset(!!process.env.OPENAI_API_KEY));
    log(
      `  ${opt(!!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY))} GOOGLE_API_KEY` +
        dimUnset(!!(process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY)),
    );

    log(chalk.bold("\nOptional CLIs (fallback backend, no keys needed)"));
    log(`  ${opt(onPath("codex"))} codex   ${chalk.dim("(GPT panelist)")}`);
    log(`  ${opt(onPath("gemini"))} gemini  ${chalk.dim("(Gemini panelist)")}`);
    log(`  ${opt(onPath("claude"))} claude  ${chalk.dim("(Claude panelist / judge)")}`);

    log(chalk.bold("\nReadiness"));
    const available = availableAutoPanel(config);
    if (available.length >= 2) {
      log(`  ${ok(true)} ${available.length} models available — full fusion ready`);
    } else if (available.length === 1) {
      log(`  ${chalk.yellow("!")} only 1 model available — add another provider key for true multi-model fusion`);
    } else if (onPath("codex") || onPath("gemini") || onPath("claude")) {
      log(`  ${chalk.yellow("!")} no API keys, but CLIs present — use the /fuse skill's CLI fallback`);
    } else {
      log(`  ${chalk.red("✗")} no providers. Set ANTHROPIC_API_KEY (and optionally OPENAI/GOOGLE), or install codex/gemini CLIs.`);
    }
    log(chalk.dim(`\n  providers: ${providers.join(", ") || "none"}   panel: ${available.join(", ") || "none"}\n`));
  });

function dimUnset(set: boolean): string {
  return set ? "" : chalk.dim(" (unset)");
}

// ---- setup (install the /fuse skill into harnesses) ----
function locateSkillsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "skills"), // packaged: <pkg>/dist -> <pkg>/skills
    join(here, "..", "..", "..", "skills"), // dev: packages/cli/dist -> repo/skills
  ];
  return candidates.find((p) => existsSync(join(p, "fuse", "SKILL.md"))) ?? null;
}

program
  .command("setup")
  .description("install the /fuse skill + command into Claude Code and OpenCode")
  .action(() => {
    const skills = locateSkillsDir();
    if (!skills) {
      log(chalk.red("Could not locate bundled skill assets."));
      process.exit(1);
    }
    const targets = [
      {
        label: "Claude Code",
        skillDir: join(homedir(), ".claude", "skills"),
        cmdDir: join(homedir(), ".claude", "commands"),
      },
      {
        label: "OpenCode",
        skillDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "skill"),
        cmdDir: join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "opencode", "command"),
      },
    ];
    for (const t of targets) {
      mkdirSync(join(t.skillDir, "fuse"), { recursive: true });
      mkdirSync(t.cmdDir, { recursive: true });
      cpSync(join(skills, "fuse"), join(t.skillDir, "fuse"), { recursive: true });
      copyFileSync(join(skills, "commands", "fuse.md"), join(t.cmdDir, "fuse.md"));
      log(chalk.green(`✓ installed /fuse for ${t.label}`));
    }
    log(chalk.dim("\nThe skill calls `fuse-run` (on PATH from this package). Run `fuse doctor` to verify keys.\n"));
  });

function bar(score: number): string {
  const n = Math.round(score * 5);
  return "█".repeat(n) + "░".repeat(5 - n);
}

program.parseAsync();
