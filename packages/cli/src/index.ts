#!/usr/bin/env node
import { Command } from "commander";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import chalk from "chalk";
import * as p from "@clack/prompts";
import {
  fuse,
  loadEnv,
  loadConfig,
  saveConfig,
  setProviderKey,
  authModeFor,
  setProviderAuthMode,
  apiKeyFor,
  configPath,
  fusionHome,
  FusionStore,
  availableAutoPanel,
  configuredProviders,
  type FusionConfig,
  type ProviderName,
  type ProviderAuthMode,
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

/**
 * Provider → subscription CLI wiring (grounded against the published packages).
 * Mirrors CLI_SPECS in @era-fusion/core; kept here for the wizard's install +
 * version flows and the doctor readout (these need bin/pkg + login hints).
 */
const PROVIDER_CLI: Record<
  ProviderName,
  { bin: string; pkg: string; loginHint: string }
> = {
  anthropic: { bin: "claude", pkg: "@anthropic-ai/claude-code", loginHint: "claude /login" },
  openai: { bin: "codex", pkg: "@openai/codex", loginHint: "codex login" },
  google: { bin: "gemini", pkg: "@google/gemini-cli", loginHint: "gemini" },
};

/** npm package powering this CLI — used for the self-version check. */
const ENGINE_PKG = "@alexanderollman/llm-fusion";

/** Run `<bin> --version` and return the first semver found, or null. */
function cliVersion(bin: string): string | null {
  try {
    const out = execFileSync(bin, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = out.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
    return m ? m[0] : null;
  } catch {
    return null;
  }
}

/** Latest published version of an npm package, or null on any failure. */
function latestNpm(pkg: string): string | null {
  try {
    const out = execFileSync("npm", ["view", pkg, "version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const v = out.trim();
    return v || null;
  } catch {
    return null;
  }
}

/** True if the package is installed as a global npm package. */
function isNpmGlobal(pkg: string): boolean {
  try {
    execFileSync("npm", ["ls", "-g", pkg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Install/update a package globally via npm. Returns success. */
function installNpmGlobal(pkg: string): boolean {
  try {
    execFileSync("npm", ["i", "-g", pkg], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of a resolvable command (for "managed outside npm" hints). */
function whichPath(bin: string): string | null {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
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

    log(chalk.bold("\nPer-provider auth mode"));
    const PROV_LABELS: { name: ProviderName; label: string }[] = [
      { name: "anthropic", label: "Anthropic (Claude)" },
      { name: "openai", label: "OpenAI (GPT)" },
      { name: "google", label: "Google (Gemini)" },
    ];
    for (const { name, label } of PROV_LABELS) {
      const mode = authModeFor(name, config);
      const cli = PROVIDER_CLI[name];
      if (mode === "subscription") {
        const present = onPath(cli.bin);
        const ver = present ? cliVersion(cli.bin) : null;
        const detail = present
          ? `${cli.bin}${ver ? ` v${ver}` : ""} present`
          : `${cli.bin} not found — npm i -g ${cli.pkg}`;
        log(`  ${opt(present)} ${label.padEnd(20)} ${chalk.dim("subscription")} — ${detail}`);
      } else {
        const keyed = !!apiKeyFor(name);
        log(`  ${opt(keyed)} ${label.padEnd(20)} ${chalk.dim("api")} — ${keyed ? "key set" : "no key"}`);
      }
    }

    log(chalk.bold("\nOptional CLIs (subscription / fallback backend, no keys needed)"));
    log(`  ${opt(onPath("codex"))} codex   ${chalk.dim("(GPT panelist)")}`);
    log(`  ${opt(onPath("gemini"))} gemini  ${chalk.dim("(Gemini panelist)")}`);
    log(`  ${opt(onPath("claude"))} claude  ${chalk.dim("(Claude panelist / judge)")}`);

    // Engine self-version check (skip silently if the package isn't published).
    const engineLatest = latestNpm(ENGINE_PKG);
    if (engineLatest && engineLatest !== program.version()) {
      log(chalk.bold("\nEngine"));
      log(
        `  ${chalk.yellow("!")} fuse v${program.version()} installed, v${engineLatest} available — ` +
          `update: ${chalk.cyan(`npm i -g ${ENGINE_PKG}`)}`,
      );
    }

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

// ---- setup (interactive wizard: provider keys + defaults + skill install) ----
function locateSkillsDir(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "skills"), // packaged: <pkg>/dist -> <pkg>/skills
    join(here, "..", "..", "..", "skills"), // dev: packages/cli/dist -> repo/skills
  ];
  return candidates.find((dir) => existsSync(join(dir, "fuse", "SKILL.md"))) ?? null;
}

/** Copy the /fuse skill + command into Claude Code and OpenCode. Returns installed harness labels. */
function installSkill(): string[] {
  const skills = locateSkillsDir();
  if (!skills) throw new Error("Could not locate bundled skill assets.");
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
  const installed: string[] = [];
  for (const t of targets) {
    mkdirSync(join(t.skillDir, "fuse"), { recursive: true });
    mkdirSync(t.cmdDir, { recursive: true });
    cpSync(join(skills, "fuse"), join(t.skillDir, "fuse"), { recursive: true });
    copyFileSync(join(skills, "commands", "fuse.md"), join(t.cmdDir, "fuse.md"));
    installed.push(t.label);
  }
  return installed;
}

const SETUP_PROVIDERS: { name: ProviderName; env: string; label: string; required: boolean }[] = [
  { name: "anthropic", env: "ANTHROPIC_API_KEY", label: "Anthropic (Claude)", required: true },
  { name: "openai", env: "OPENAI_API_KEY", label: "OpenAI (GPT)", required: false },
  { name: "google", env: "GOOGLE_API_KEY", label: "Google (Gemini)", required: false },
];

function maskKey(v: string): string {
  return v.length <= 8 ? "•".repeat(v.length) : `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function readinessLine(config: FusionConfig): string {
  const available = availableAutoPanel(config);
  if (available.length >= 2) return chalk.green(`✓ ${available.length} models available — full fusion ready`);
  if (available.length === 1)
    return chalk.yellow("! only 1 model available — add another provider key for true multi-model fusion");
  return chalk.red("✗ no providers — set a key with `fuse setup` or export ANTHROPIC_API_KEY");
}

function bail(): never {
  p.cancel("Setup cancelled — no changes beyond keys already saved.");
  process.exit(0);
}

/**
 * Subscription-mode setup for one provider: ensure its CLI is installed and
 * (if managed by npm) up to date, then persist the auth mode and print the
 * exact login command. Never auto-launches an interactive browser login.
 */
async function setupSubscription(prov: { name: ProviderName; label: string }): Promise<void> {
  const cli = PROVIDER_CLI[prov.name];

  if (!cliAvailableOnPath(cli.bin)) {
    const doInstall = await p.confirm({
      message: `${cli.bin} not found. Install ${cli.pkg} via \`npm i -g\` now?`,
      initialValue: true,
    });
    if (p.isCancel(doInstall)) bail();
    if (doInstall) {
      const s = p.spinner();
      s.start(`Installing ${cli.pkg}…`);
      const ok = installNpmGlobal(cli.pkg);
      s.stop(ok ? `Installed ${cli.pkg}` : `Install failed for ${cli.pkg}`);
      if (!ok) p.log.warn(`Could not install ${cli.pkg} — install it manually, then re-run setup.`);
    } else {
      p.log.warn(`${prov.label} subscription mode won't work until ${cli.bin} is installed.`);
    }
  } else {
    // Installed — offer an update only when npm manages it and versions differ.
    const installed = cliVersion(cli.bin);
    const latest = latestNpm(cli.pkg);
    if (installed && latest && installed !== latest) {
      if (isNpmGlobal(cli.pkg)) {
        const doUpdate = await p.confirm({
          message: `${cli.bin} v${installed} installed, v${latest} available — update?`,
          initialValue: true,
        });
        if (p.isCancel(doUpdate)) bail();
        if (doUpdate) {
          const s = p.spinner();
          s.start(`Updating ${cli.pkg}…`);
          const ok = installNpmGlobal(cli.pkg);
          s.stop(ok ? `Updated ${cli.pkg} → v${latest}` : `Update failed for ${cli.pkg}`);
        }
      } else {
        const at = whichPath(cli.bin) ?? cli.bin;
        p.note(
          `${cli.bin} v${installed} is managed outside npm at ${at} (v${latest} available) — update there, not via npm.`,
          "Heads up",
        );
      }
    }
  }

  setProviderAuthMode(prov.name, "subscription");
  p.note(
    `Log in to your ${prov.label} subscription if you haven't:\n  ${chalk.cyan(cli.loginHint)}`,
    `${prov.label} — subscription mode`,
  );
}

/** Local PATH check (mirrors onPath; named for the wizard's readability). */
function cliAvailableOnPath(bin: string): boolean {
  return onPath(bin);
}

async function runSetupWizard(install: boolean): Promise<void> {
  p.intro(chalk.bold("Era Fusion setup"));

  // 1) Per-provider auth: API key, subscription (CLI login), or skip.
  for (const prov of SETUP_PROVIDERS) {
    const current =
      process.env[prov.env] || (prov.name === "google" ? process.env.GEMINI_API_KEY : "") || "";
    const cli = PROVIDER_CLI[prov.name];
    const cliPresent = cliAvailableOnPath(cli.bin);
    const currentMode = authModeFor(prov.name);

    // Preselect the current/likely choice: configured subscription, an existing
    // key, an available CLI, else skip (or "api" for the required provider).
    const initial: ProviderAuthMode | "skip" =
      currentMode === "subscription"
        ? "subscription"
        : current
          ? "api"
          : cliPresent
            ? "subscription"
            : prov.required
              ? "api"
              : "skip";

    const keyHint = current ? ` ${chalk.dim(`(key set: ${maskKey(current)})`)}` : "";
    const cliHint = cliPresent ? ` ${chalk.dim(`(${cli.bin} present)`)}` : "";
    const choice = await p.select({
      message: `${prov.label} — how should it authenticate?`,
      options: [
        { value: "api", label: `API key${keyHint}` },
        { value: "subscription", label: `Subscription login (use your Pro/Max plan)${cliHint}` },
        { value: "skip", label: "Skip" },
      ],
      initialValue: initial,
    });
    if (p.isCancel(choice)) bail();
    const mode = choice as ProviderAuthMode | "skip";

    if (mode === "api") {
      const hint = current
        ? `set (${maskKey(current)}) — Enter to keep`
        : prov.required
          ? "required — paste key, or Enter to set later"
          : "optional — Enter to skip";
      const value = await p.password({ message: `${prov.label} API key  ${chalk.dim(hint)}` });
      if (p.isCancel(value)) bail();
      const v = (value as string).trim();
      if (v) {
        const path = setProviderKey(prov.name, v);
        p.log.success(`${prov.label} key saved → ${path}`);
      } else if (!current && prov.required) {
        p.log.warn(`No ${prov.label} key yet — fusion needs at least one provider configured.`);
      }
      setProviderAuthMode(prov.name, "api");
    } else if (mode === "subscription") {
      await setupSubscription(prov);
    }
    // skip → leave existing config untouched.
  }

  // 2) Defaults — prefilled from existing config.
  const config = loadConfig(true);
  const judge = await p.select({
    message: "Default judge / synthesizer model",
    options: config.models.map((m) => ({ value: m.id, label: `${m.id}  ${chalk.dim(m.label)}` })),
    initialValue: config.defaultJudge,
  });
  if (p.isCancel(judge)) bail();

  const sizeRaw = await p.text({
    message: "Panel size (models per fusion)",
    initialValue: String(config.panelSize),
    validate: (s) => (s && /^[1-9]\d*$/.test(s.trim()) ? undefined : "enter a positive integer"),
  });
  if (p.isCancel(sizeRaw)) bail();

  const web = await p.confirm({ message: "Enable web search by default?", initialValue: config.webSearch });
  if (p.isCancel(web)) bail();

  saveConfig({
    ...config,
    defaultJudge: judge as string,
    panelSize: parseInt((sizeRaw as string).trim(), 10),
    webSearch: web as boolean,
  });

  // 3) Skill install into harnesses.
  let doInstall = install;
  if (doInstall) {
    const ans = await p.confirm({
      message: "Install the /fuse skill + command into Claude Code & OpenCode?",
      initialValue: true,
    });
    if (p.isCancel(ans)) bail();
    doInstall = ans as boolean;
  }
  if (doInstall) {
    try {
      const installed = installSkill();
      p.log.success(`Installed /fuse for ${installed.join(", ")}`);
    } catch (e) {
      p.log.warn(`Skill install skipped: ${(e as Error).message}`);
    }
  }

  // 4) Readiness summary.
  const fresh = loadConfig(true);
  p.note(
    `providers: ${configuredProviders().join(", ") || "none"}\n` +
      `panel:     ${availableAutoPanel(fresh).join(", ") || "none"}\n` +
      readinessLine(fresh),
    "Readiness",
  );

  // 5) Engine self-version check (skip silently if unpublished/unreachable).
  const engineLatest = latestNpm(ENGINE_PKG);
  if (engineLatest && engineLatest !== program.version()) {
    p.log.info(
      `fuse v${program.version()} installed, v${engineLatest} available — update: ${chalk.cyan(
        `npm i -g ${ENGINE_PKG}`,
      )}`,
    );
  }

  p.outro(`Done. Try ${chalk.cyan('fuse "your question"')}  ·  health: ${chalk.cyan("fuse doctor")}`);
}

program
  .command("setup")
  .description("interactive setup: provider keys, defaults, and /fuse skill install")
  .option("--skill-only", "skip the wizard; just install the /fuse skill into harnesses")
  .option("--no-install", "run the wizard but skip installing the /fuse skill")
  .action(async (opts) => {
    const skillOnly = !!opts.skillOnly;
    // Non-interactive (piped/CI) or --skill-only: copy skill assets, no prompts.
    if (skillOnly || !process.stdin.isTTY) {
      if (!skillOnly)
        log(chalk.yellow("Non-interactive shell — installing the skill only. Run `fuse setup` in a terminal to enter keys."));
      try {
        for (const label of installSkill()) log(chalk.green(`✓ installed /fuse for ${label}`));
        log(chalk.dim("\nThe skill calls `fuse-run` (on PATH from this package). Run `fuse doctor` to verify keys.\n"));
      } catch (e) {
        log(chalk.red((e as Error).message));
        process.exit(1);
      }
      return;
    }
    await runSetupWizard(opts.install !== false);
  });

function bar(score: number): string {
  const n = Math.round(score * 5);
  return "█".repeat(n) + "░".repeat(5 - n);
}

program.parseAsync();
