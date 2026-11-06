#!/usr/bin/env node
// PreToolUse guard: enforced in code, so an agent cannot talk its way past it.
// Exit code 2 blocks the tool call and shows stderr to the agent as the reason.
//
// Layer 1 (everyone, main session included): destructive or outward-facing commands.
// Layer 2 (factory agents): each role may write only where its job needs to.
//   planner      -> factory/spec.md, factory/tickets/, factory/questions.md, factory/config.json,
//                   GLOSSARY.md, docs/adr/, its own report
//   test-writer  -> only the acceptance directory of the current ticket, and its report
//   implementer  -> source code anywhere, but never the acceptance tests, factory/ or .claude/ (except its report)
//   tester / auditor -> only its own report
//   reviewer / final-reviewer -> its own report and factory/PR.md
// No factory agent may run the factory's scripts, read secrets, or (except the implementer) change git state.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const FACTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(FACTORY, "..");
const AGENTS = ["planner", "test-writer", "diagnoser", "implementer", "tester", "auditor", "reviewer", "final-reviewer", "retro"];
const ACC = (() => { try { return (JSON.parse(fs.readFileSync(path.join(FACTORY, "config.json"), "utf8")).acceptance?.dir || "tests/acceptance").replace(/\\/g, "/").replace(/\/$/, ""); } catch { return "tests/acceptance"; } })();

const DANGER = [
  [/\bgit\s+push\b/, "git push is reserved for the human"],
  [/\bgit\s+reset\s+--hard\b/, "git reset --hard destroys work"],
  [/\bgit\s+clean\s+-\w*f/, "git clean -f deletes untracked files"],
  [/\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/, "discarding all changes is not allowed"],
  [/\bgit\s+(rebase|filter-branch|filter-repo)\b|\bgit\s+commit\b[^|;&]*--amend/, "rewriting history is not allowed"],
  [/\bgit\s+branch\s+-D\b|\bgit\s+push\b.*--force|--force-with-lease/, "force operations are not allowed"],
  [/--no-verify\b/, "skipping git hooks is not allowed"],
  [/\brm\s+-\w*r\w*\s+(-\w+\s+)*(\/|~|\.\.?|\*|[A-Za-z]:[\\/]?)(\s|$)/, "recursive delete of a root, home, parent or whole folder"],
  [/\b(curl|wget|iwr|Invoke-WebRequest)\b[^|]*\|\s*(ba|z)?sh\b|\biex\b/, "piping a download into a shell"],
  [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b/, "publishing packages is reserved for the human"],
  [/\bsudo\b|\bchmod\s+-R\s+777\b|\bmkfs\b|\bdd\s+if=|\bformat\s+[a-z]:/i, "system-level command"],
  [/\b(drop\s+(database|table)|truncate\s+table)\b/i, "destructive database statement"],
  [/\b(shutdown|reboot)\b/, "machine control"],
];
const SECRET = /(^|[\\/])(\.env(\.[\w.-]+)?|id_rsa|id_ed25519|\.npmrc|\.pypirc|credentials(\.json)?|.*\.pem|.*\.key)$/i;
const SECRET_IN_CMD = /(^|[\s"'\\/])(\.env(\.[\w-]+)?|id_rsa|id_ed25519|\.npmrc|credentials\.json)\b/;
// Bash commands a read-only role may not run (writes go through the Write tool, to the report only).
const MUTATING = /\bgit\s+(commit|add|checkout|switch|stash|merge|cherry-pick|revert|apply|tag|mv|rm)\b|(^|[\s;&|])(rm|mv|cp|del|rmdir|touch|truncate)\s|\bsed\s+-i|\bperl\s+-i|\btee\s|\bnpm\s+(install|i|uninstall|update)\b|>\s*(?!&|\/dev\/null|nul\b)[^\s>]/;

function rel(p) {
  if (!p) return "";
  const abs = path.isAbsolute(p) ? p : path.join(ROOT, p);
  return path.relative(ROOT, abs).split(path.sep).join("/");
}

// Every block is logged: the retro agent reads it to find agents whose instructions don't say what to do instead.
let logCtx = {};
function block(reason) {
  try {
    if (fs.existsSync(path.join(FACTORY, "state.json")))
      fs.appendFileSync(path.join(FACTORY, "guard-log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...logCtx, reason }) + "\n");
  } catch {}
  process.stderr.write(`BLOCKED by factory guard: ${reason}. Do not try to work around this; if the task truly needs it, say so in your report.`);
  process.exit(2);
}

function canWrite(agent, file, cur) {
  if (file.startsWith("..")) return false;           // outside the project
  const own = cur?.report && file === cur.report;
  switch (agent) {
    case "planner":
      return own || /^factory\/(spec\.md|questions\.md|config\.json|tickets\/[^/]+\.md)$/.test(file) ||
        file === "GLOSSARY.md" || file === "GLOSSARY-MAP.md" || /^docs\/adr\//.test(file) || /(^|\/)GLOSSARY\.md$/.test(file);
    case "test-writer":
      return own || (cur?.ticket && file.startsWith(`${ACC}/${cur.ticket}/`));
    case "diagnoser": // its regression test, plus temporary instrumentation in source (code checks it is all reverted)
      return own || (cur?.ticket && file.startsWith(`${ACC}/${cur.ticket}/`)) ||
        !(/^factory\//.test(file) || /^\.claude\//.test(file) || /^\.git\//.test(file) || file.startsWith(`${ACC}/`));
    case "implementer":
      return own || !(/^factory\//.test(file) || /^\.claude\//.test(file) || /^\.git\//.test(file) || file.startsWith(`${ACC}/`));
    case "reviewer":
    case "final-reviewer":
      return own || file === "factory/PR.md";
    case "retro": // proposes read-only; applies only the files of the proposals the human accepted
      return own || (cur?.mode === "apply" && (cur.targets ?? []).includes(file));
    default: // tester, auditor
      return own;
  }
}

async function main() {
  let raw = "";
  for await (const c of process.stdin) raw += c;
  const hook = JSON.parse(raw || "{}");
  const tool = hook.tool_name;
  const input = hook.tool_input ?? {};
  const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(FACTORY, "state.json"), "utf8")); } catch { return null; } })();

  // Who is calling? Subagent hook payloads carry agent_type; the main session's do not.
  const agent = hook.agent_type ?? (hook.agent_id ? state?.current?.agent : null);
  const isFactoryAgent = AGENTS.includes(agent);
  const cur = state?.current;
  logCtx = { agent: agent ?? "main", tool, ticket: cur?.ticket };

  // Orchestrator control: a factory agent may only be started as the exact step factory.mjs handed out,
  // with the model and reasoning level it chose and its prompt unchanged.
  if ((tool === "Agent" || tool === "Task") && AGENTS.includes(input.subagent_type) && state && state.phase !== "finished") {
    const want = cur ? `${cur.agent} (ticket ${cur.ticket}, attempt ${cur.attempt})` : "nothing: run `node factory/scripts/factory.mjs next` first";
    if (!cur || cur.agent !== input.subagent_type) block(`out of sequence: the factory's current step is ${want}`);
    if (input.model && cur.model && input.model !== cur.model) block(`the ${cur.agent} must run on model ${cur.model} (config.json), not ${input.model}`);
    if (input.effort && cur.effort && input.effort !== cur.effort) block(`the ${cur.agent} must run at reasoning level ${cur.effort}, not ${input.effort}`);
    if (cur.effort && !input.effort) block(`pass effort: "${cur.effort}" for the ${cur.agent} (from factory.mjs next)`);
    if (cur.report && !String(input.prompt ?? "").includes(cur.report)) block("pass the prompt from `factory.mjs next` verbatim");
    return;
  }

  if (tool === "Bash" || tool === "PowerShell") {
    const cmd = String(input.command ?? "");
    for (const [re, why] of DANGER) if (re.test(cmd)) block(why);
    if (agent === "discovery") {
      if (/factory[\\/]scripts[\\/]factory\.mjs["']?\s+(next|record|resume|build)\b/.test(cmd)) block("discovery writes the plan; the orchestrator runs the build in its own session");
      if (/factory[\\/]scripts[\\/](guard|track-tokens)\.mjs/.test(cmd)) block("the factory's own scripts are not run by hand");
      if (/factory[\\/]scripts[\\/]update-skills\.mjs["']?\s+(apply|pin)\b/.test(cmd)) block("skill updates are applied by the orchestrator, with the human's yes");
      if (SECRET_IN_CMD.test(cmd)) block("secret files stay unread");
      return;
    }
    if (agent === "orchestrator") {
      const ok = /^\s*node\s+["']?factory[\\/]scripts[\\/](factory|update-skills)\.mjs\b/.test(cmd) ||
        /^\s*git\s+(status|log|diff\s+--stat|show\s+--stat)\b[^;&|>]*$/.test(cmd);
      if (!ok) block("the orchestrator may only run the factory scripts and read-only git commands");
      return;
    }
    if (isFactoryAgent) {
      if (/factory[\\/]scripts[\\/](factory|guard|track-tokens|update-skills)\.mjs/.test(cmd)) block("agents may not run or edit the factory's own scripts");
      if (SECRET_IN_CMD.test(cmd)) block("agents may not read secret files");
      if (agent === "implementer" && cmd.replace(/\\/g, "/").includes(`${ACC}/`) && MUTATING.test(cmd))
        block("the acceptance tests are locked: the implementer may run them, never change, move or delete them (return DISPUTE if one is wrong)");
      if (agent === "diagnoser") {
        if (/\bgit\s+(commit|add|checkout|switch|stash|merge|cherry-pick|revert|apply|tag|mv|rm|reset)\b/.test(cmd))
          block("the diagnoser may not change git state: it instruments and reverts by hand, and code commits its regression test");
        if (cmd.replace(/\\/g, "/").includes(`${ACC}/`) && !cmd.replace(/\\/g, "/").includes(`${ACC}/${cur?.ticket}/`) && MUTATING.test(cmd))
          block("other tickets' acceptance tests are locked");
        return;
      }
      if (agent !== "implementer" && MUTATING.test(cmd))
        block(`the ${agent} is read-only: it may run and inspect, never change files or git state (write your report with the Write tool)`);
    }
    return;
  }

  const file = input.file_path ?? input.notebook_path ?? input.path;
  if (!file) return;
  const r = rel(file);
  if ((isFactoryAgent || agent === "discovery") && SECRET.test(r)) block("agents may not read or write secret files");
  if (agent === "discovery" && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const onPrototype = (() => { try { return execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().startsWith("prototype/"); } catch { return false; } })();
    const ok = /^factory\/(brief\.md|spec\.md|config\.json|tickets\/[^/]+\.md|discovery\/.+)$/.test(r) || /^(GLOSSARY(-MAP)?\.md|docs\/adr\/|prototypes\/)/.test(r) ||
      /(^|\/)GLOSSARY\.md$/.test(r) || (onPrototype && !/^(factory|\.claude|\.git)\//.test(r) && !r.startsWith(".."));
    if (!ok) block(`discovery may not write ${r}: it writes the brief, spec, tickets, discovery notes, glossary, ADRs and prototypes (UI prototypes on a prototype/<name> branch)`);
    return;
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(tool)) {
    if (isFactoryAgent && !canWrite(agent, r, cur))
      block(`the ${agent} may not write ${r}${cur?.report ? ` (its report is ${cur.report})` : ""}`);
    if (!isFactoryAgent && /^factory\/(state|usage)\.json$/.test(r)) block("factory state is written only by factory.mjs");
  }
}

main().catch(() => process.exit(0));
