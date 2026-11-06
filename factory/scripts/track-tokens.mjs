#!/usr/bin/env node
// Token accounting hook.
//   SubagentStop  -> node track-tokens.mjs          (one factory agent run)
//   Stop          -> node track-tokens.mjs --main   (the orchestrator's own session)
// Reads the transcript JSONL, sums `usage` per assistant message (deduplicated by
// message id), and stores it in factory/usage.json keyed by agent run. It attributes
// the run to the ticket/agent/attempt that factory/state.json says is running.
// A hook must never break the session: every error is swallowed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const FACTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const P = (...p) => path.join(FACTORY, ...p);
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };

function sumTranscript(file, { skipSidechain }) {
  const byId = new Map();
  const models = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    const m = e.message;
    if (e.type !== "assistant" || !m?.usage) continue;
    if (skipSidechain && e.isSidechain) continue;
    byId.set(m.id ?? e.uuid, { usage: m.usage, model: m.model });
  }
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: byId.size };
  for (const { usage: u, model } of byId.values()) {
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheWrite += u.cache_creation_input_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    if (model && model !== "<synthetic>") models[model] = (models[model] ?? 0) + 1;
  }
  t.model = Object.entries(models).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  t.total = t.input + t.output + t.cacheWrite + t.cacheRead;
  return t;
}

function newestSubagentTranscript(hook) {
  // Fallback when the hook payload lacks agent_transcript_path:
  // <project>/<session>.jsonl  ->  <project>/<session>/subagents/agent-*.jsonl
  const dir = path.join(path.dirname(hook.transcript_path), hook.session_id, "subagents");
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files[0]?.f;
}

async function main() {
  const state = readJSON(P("state.json"), null);
  if (!state) return; // factory not initialised in this project
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  const hook = JSON.parse(raw || "{}");
  const usage = readJSON(P("usage.json"), { runs: {}, main: null });

  if (process.argv.includes("--main")) {
    if (!hook.transcript_path) return;
    // One entry per main session. Its role is fixed by the phase at its first stop:
    // a session that started during discovery stays "discovery" even after plan-ready.
    usage.sessions ??= {};
    const sid = hook.session_id || path.basename(hook.transcript_path, ".jsonl");
    const role = usage.sessions[sid]?.role ?? (state.phase === "discovery" ? "discovery" : "orchestrator");
    usage.sessions[sid] = { ...sumTranscript(hook.transcript_path, { skipSidechain: true }), role, updatedAt: new Date().toISOString() };
    const total = (r) => Object.values(usage.sessions).filter((s) => s.role === r)
      .reduce((a, s) => ({ input: a.input + s.input, output: a.output + s.output, cacheWrite: a.cacheWrite + s.cacheWrite, cacheRead: a.cacheRead + s.cacheRead, total: a.total + s.total, model: s.model || a.model }),
        { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, model: null });
    usage.main = total("orchestrator");
    usage.discovery = total("discovery");
  } else {
    const file = hook.agent_transcript_path || newestSubagentTranscript(hook);
    if (!file || !fs.existsSync(file)) return;
    const cur = state.current ?? {};
    const agentType = hook.agent_type || cur.agent || "unknown";
    const known = ["planner", "test-writer", "diagnoser", "implementer", "tester", "auditor", "reviewer", "final-reviewer", "retro"].includes(agentType);
    const key = hook.agent_id || path.basename(file, ".jsonl");
    usage.runs[key] = {
      ...sumTranscript(file, { skipSidechain: false }),
      agent: agentType,
      ticket: known ? cur.ticket ?? "-" : "-",
      attempt: known ? cur.attempt ?? null : null,
      mode: known ? cur.mode ?? null : null,
      at: new Date().toISOString(),
    };
  }
  fs.writeFileSync(P("usage.json"), JSON.stringify(usage, null, 2));
  // One writer for the dashboard data: factory.mjs build (keeps every section in step).
  execFileSync(process.execPath, [path.join(FACTORY, "scripts", "factory.mjs"), "build"], { stdio: "ignore" });
}

main().catch(() => {}).finally(() => process.exit(0));
