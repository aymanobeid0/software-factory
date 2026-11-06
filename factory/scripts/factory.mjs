#!/usr/bin/env node
// Software factory state machine.
// The orchestrator never decides the next step itself: it asks this script (`next`),
// runs the agent it names, then calls `record`. All routing (forward, rework, disputes,
// plan revision, human escalation), every deterministic gate, and the lessons ledger
// live here, so the loop is predictable and costs no model tokens to steer.
//
// Commands:
//   init "<project name>"      start a fresh factory run (lessons from earlier projects are kept)
//   next                       print the next action as JSON (and mark it started)
//   record                     read the current agent's report, run the gates, apply the VERDICT
//   resume [<ticket> retry|skip]  continue after a human answered / unblocked
//   status                     one-screen summary
//   build                      regenerate factory/data.js for the dashboard
//   brief  < text              write factory/brief.md (the orchestrator has no Write tool)
//   answer < text              append the human's answers to factory/answers.md
//   plan-ready                 end of discovery: validate spec, tickets and commands, then start building
//   retro-accept <ids>|all|none   the human's decision on the retro's proposals
//   bug [--feature F<n>] < text   report a bug: it becomes a bug ticket, diagnosed before it is fixed

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FACTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(FACTORY, "..");
const P = (...p) => path.join(FACTORY, ...p);
const rel = (abs) => path.relative(ROOT, abs).split(path.sep).join("/");

// One agent per stage. "gate" is code, not an agent.
const PIPELINE = ["test-writer", "implementer", "tester", "auditor", "reviewer"];
const STAGES = ["test-writer", "implementer", "gate", "tester", "auditor", "reviewer"];
// A bug ticket starts with the diagnoser (reproduce, root cause, failing regression test) instead of the test-writer.
const firstStage = (t) => (t?.type === "bug" ? "diagnoser" : "test-writer");
const pipelineFor = (t) => [firstStage(t), ...PIPELINE.slice(1)];
const stagesFor = (t) => [firstStage(t), ...STAGES.slice(1)];
const isTestStage = (a) => a === "test-writer" || a === "diagnoser";
const REVIEWERS = ["tester", "auditor", "reviewer", "final-reviewer"];
const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|[._-](test|spec)s?\.[a-z]+$/i;
const ASSERT = /\b(expect|assert\w*|should)\s*[.(]|\.to(Be|Equal|Throw|Match|Contain|Have)\w*\(/;
const DISABLE = /\b(it|test|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|@Disabled|@pytest\.mark\.skip|\bt\.Skip\(/;
const now = () => new Date().toISOString();

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJSON(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
const config = () => readJSON(P("config.json"), {});
const accDir = (cfg = config()) => (cfg.acceptance?.dir || "tests/acceptance").replace(/\\/g, "/").replace(/\/$/, "");
const loadState = () => {
  const s = readJSON(P("state.json"), null);
  if (!s) { console.error("No factory/state.json. Run: node factory/scripts/factory.mjs init \"<name>\""); process.exit(1); }
  return s;
};
function save(state) { writeJSON(P("state.json"), state); build(state); }

function event(state, e) {
  state.events.push({ ts: now(), ...e });
  const line = `- ${new Date().toISOString().slice(0, 16).replace("T", " ")} · **${e.ticket}** · ${e.agent ?? "-"}` +
    `${e.attempt ? ` #${e.attempt}` : ""} · \`${e.type}\`${e.summary ? ` — ${e.summary}` : ""}` +
    `${e.report ? ` ([report](${path.relative(FACTORY, path.join(ROOT, e.report)).split(path.sep).join("/")}))` : ""}\n`;
  fs.appendFileSync(P("log.md"), line);
}

function sh(cmd) { return execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] }).toString(); }
function git(cmd, raw = false) {
  try { const out = sh(`git ${cmd}`); return raw ? out : out.trim(); } catch { return null; }
}
const isGit = () => git("rev-parse --is-inside-work-tree") === "true";

// Files changed in the working tree, outside factory/ (the factory's own bookkeeping).
function dirtyFiles() {
  const out = git("status --porcelain --untracked-files=all", true);
  if (out == null) return null;
  return out.split("\n").filter(Boolean)
    .map((l) => l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop())
    .filter((f) => !f.startsWith("factory/")).sort();
}
function listFiles(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`]);
}
const hashFile = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, f), "utf8").replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);

// ---------- lessons ledger ----------
// Every LESSON line in a review report is stored against the agent that made the mistake.
// That agent reads factory/lessons/<agent>.md before every run. Repeats are counted.
const LESSONS = P("lessons", "lessons.json");
const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N} ]+/gu, " ").replace(/\s+/g, " ").trim();

function extractLessons(text, defaultTarget) {
  return [...text.matchAll(/^\s*[-*]?\s*\**LESSON(?:\(([\w-]+)\))?\**\s*:?\**\s*(.+)$/gmi)]
    .map((m) => ({ target: (m[1] || defaultTarget).toLowerCase(), text: m[2].replace(/\*+$/, "").trim() }))
    .filter((l) => l.text.length > 3);
}

function addLessons(state, lessons, ctx) {
  if (!lessons.length) return;
  const db = readJSON(LESSONS, {});
  for (const l of lessons) {
    const book = (db[l.target] ??= {});
    const key = norm(l.text);
    const hit = book[key];
    if (hit) {
      hit.count++; hit.lastSeen = now(); hit.tickets = [...new Set([...hit.tickets, ctx.ticket])];
      event(state, { type: "lesson_repeat", ticket: ctx.ticket, agent: l.target, summary: `${l.text} (×${hit.count})`, from: ctx.from });
    } else {
      book[key] = { text: l.text, count: 1, firstSeen: now(), lastSeen: now(), from: ctx.from, tickets: [ctx.ticket], project: state.project };
      event(state, { type: "lesson", ticket: ctx.ticket, agent: l.target, summary: l.text, from: ctx.from });
    }
  }
  writeJSON(LESSONS, db);
  for (const agent of new Set(lessons.map((l) => l.target))) renderLessons(agent, db[agent]);
}

function renderLessons(agent, book) {
  const items = Object.values(book ?? {}).sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen)).slice(0, 30);
  const L = [`# Lessons for the ${agent}`, "",
    "These come from real rejections of your work, in this and earlier projects. Read them before you start and follow every one.",
    "A lesson marked ×N is a mistake you already made N times: reviewers fail repeated mistakes on sight.", ""];
  items.forEach((x, i) => L.push(`${i + 1}. ${x.count > 1 ? `**(×${x.count})** ` : ""}${x.text}`));
  fs.writeFileSync(P("lessons", `${agent}.md`), L.join("\n") + "\n");
}
const lessonsFile = (agent) => fs.existsSync(P("lessons", `${agent}.md`)) ? `factory/lessons/${agent}.md` : null;

// ---------- spec features + tickets ----------
function readFeatures() {
  const spec = fs.existsSync(P("spec.md")) ? fs.readFileSync(P("spec.md"), "utf8") : "";
  const out = [];
  for (const m of spec.matchAll(/^#{2,4}\s*(F\d+)\s*[:.\-—]\s*(.+)$/gm)) {
    const after = spec.slice(m.index + m[0].length).split(/\n#{1,4}\s/)[0].trim().split("\n")[0] ?? "";
    out.push({ id: m[1].toUpperCase(), name: m[2].trim(), description: after.replace(/^[-*]\s*/, "").trim() });
  }
  return out;
}

function importTickets(state) {
  const dir = P("tickets");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+.*\.md$/.test(f)).sort() : [];
  state.features = readFeatures();
  const brief = fs.existsSync(P("brief.md")) ? fs.readFileSync(P("brief.md"), "utf8") : "";
  state.description = brief.replace(/^#.*$/m, "").trim().split("\n").find((l) => l.trim()) ?? state.description ?? "";
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const id = f.match(/^(\d+)/)[1].padStart(2, "0");
    const title = (text.match(/^#\s*\d+\s*[:.\-]\s*(.+)$/m) || [, f])[1].trim();
    const blockedLine = (text.match(/\*\*Blocked by:\*\*(.*)$/mi) || [, ""])[1];
    const blockedBy = /none/i.test(blockedLine) ? [] : [...blockedLine.matchAll(/\b(\d{1,3})\b/g)].map((m) => m[1].padStart(2, "0"));
    const feature = ((text.match(/\*\*Feature:\*\*\s*(F\d+|BUGS)/i) || [])[1] || "").toUpperCase() || null;
    const type = /\*\*Type:\*\*\s*bug/i.test(text) ? "bug" : "feature";
    const criteria = [...text.matchAll(/^\s*-\s*\[[ xX]\]\s*(.+)$/gm)].map((m) => m[1].trim());
    const what = ((text.match(/\*\*What to build:\*\*\s*(.+)$/mi) || [])[1] || "").trim();
    const existing = state.tickets.find((t) => t.id === id);
    const fields = { title, file: rel(path.join(dir, f)), blockedBy, feature, criteria, what, type };
    if (existing) { Object.assign(existing, fields); continue; }
    const t = { type };
    state.tickets.push({
      id, ...fields, status: "pending", stage: firstStage(t), attempt: 1,
      stages: Object.fromEntries(stagesFor(t).map((a) => [a, "pending"])), gates: {}, locked: null, testsSkipped: false,
      reworkFrom: null, lastRejection: null, base: null, startedAt: null, finishedAt: null,
    });
  }
}

// The active ticket finishes first; then reported bugs go before planned feature work.
function readyTicket(state) {
  const done = new Set(state.tickets.filter((t) => t.status === "done" || t.status === "skipped").map((t) => t.id));
  const ready = (t) => t.status === "pending" && t.blockedBy.every((b) => done.has(b));
  return state.tickets.find((t) => t.status === "active") ||
    state.tickets.find((t) => ready(t) && t.type === "bug") || state.tickets.find(ready);
}

// A bug report becomes a ticket. Text on stdin; optional --feature F<n>.
function reportBug(args) {
  const state = loadState();
  // Bug-fix-only use on an existing project: no spec and no tickets yet means there is no feature work to plan,
  // so the factory skips discovery and runs bug tickets alone (and skips the final review, which needs a spec).
  const bugOnly = (state.phase === "discovery" || state.phase === "planning") && !state.tickets.length && !fs.existsSync(P("spec.md"));
  if ((state.phase === "discovery" || state.phase === "planning") && !bugOnly) { console.error("Discovery is in progress: report bugs once the plan is ready (plan-ready)."); process.exit(1); }
  const text = readStdin().trim();
  if (!text) { console.error("bug: pass the bug report on stdin"); process.exit(1); }
  const fi = args.indexOf("--feature");
  const feature = fi >= 0 ? String(args[fi + 1] || "").toUpperCase() : "BUGS";
  const dir = P("tickets"); fs.mkdirSync(dir, { recursive: true });
  const next = Math.max(0, ...fs.readdirSync(dir).filter((f) => /^\d+/.test(f)).map((f) => +f.match(/^(\d+)/)[1])) + 1;
  const id = String(next).padStart(2, "0");
  const first = text.split("\n").find((l) => l.trim()).trim();
  const title = `خطأ: ${first.length > 70 ? first.slice(0, 67) + "…" : first}`;
  const slug = `bug-${id}`;
  fs.writeFileSync(path.join(dir, `${id}-${slug}.md`), [
    `# ${id}: ${title}`, "", "**Type:** bug", "", `**Feature:** ${feature}`, "",
    `**What to build:** إيجاد السبب الجذري للعَرَض المُبلَّغ عنه وإصلاحه، لا إخفاء العَرَض.`, "", "**Blocked by:** None", "",
    `**Reported:** ${now().slice(0, 10)}`, "", "## Symptom", "", text, "",
    "- [ ] العَرَض المُبلَّغ عنه لم يعد يحدث: أمر حلقة التشخيص في تقرير المشخّص ينجح.",
    "- [ ] اختبار انحدار عند الـ seam الصحيح فشل قبل الإصلاح وينجح بعده.", "",
  ].join("\n"));
  importTickets(state);
  if (bugOnly) { state.phase = "building"; state.bugOnly = true; state.plan = { ...state.plan, status: "skipped", mode: "bug-only" }; }
  if (state.phase === "finished" || state.phase === "final" || state.phase === "retro") { state.phase = "building"; state.bugRound = true; state.finalRounds = 0; }
  event(state, { type: "bug_reported", ticket: id, summary: first });
  save(state);
  console.log(`Bug ticket ${id} created (factory/tickets/${id}-${slug}.md). It runs next: the diagnoser reproduces it first.`);
}

// ---------- deterministic gates (no model involved) ----------
function runCmd(name, cmd, cfg) {
  const timeout = (cfg.gates?.checkTimeoutSec ?? 900) * 1000;
  try {
    const out = execSync(cmd, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], timeout }).toString();
    return { name, cmd, ok: true, tail: out.split("\n").slice(-5).join("\n") };
  } catch (e) {
    const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
    return { name, cmd, ok: false, tail: out.split("\n").filter(Boolean).slice(-40).join("\n") || String(e.message) };
  }
}
const runChecks = (cfg) => Object.entries(cfg.checks ?? {}).filter(([, c]) => c && String(c).trim()).map(([n, c]) => runCmd(n, c, cfg));
const acceptanceCmd = (cfg, t) => (cfg.acceptance?.command || "").trim().replaceAll("{dir}", `${accDir(cfg)}/${t.id}`);

const GATE_LESSONS = {
  written: "Write at least one acceptance test per criterion, under the acceptance directory for the ticket.",
  coverage: "List a COVERS line for every acceptance criterion; a criterion without a test is not covered.",
  red: "Acceptance tests must fail before the implementation exists; a test that already passes checks nothing new.",
  commit: "Commit your work before returning PASS, with the message `ticket NN: <title>`.",
  clean: "Run `git status` before returning PASS: nothing may stay uncommitted.",
  testsKept: "Never delete a test to make the suite pass; fix the code, or report the conflict.",
  locked: "Never edit or delete acceptance tests; if one contradicts the ticket, return DISPUTE with the exact reason.",
  notWeakened: "Never add skip/only or remove assertions from existing tests to get green; fix the code instead.",
  acceptance: "Run the ticket's acceptance tests yourself and make every one pass before returning PASS.",
  checks: "Run every automated check (typecheck, lint, full test suite) yourself before returning PASS.",
};
const GATE_TARGET = { written: "test-writer", coverage: "test-writer", red: "test-writer" }; // "diagnoser" on bug tickets

// After the test-writer: tests exist, every criterion is mapped, tests are red. Then commit and lock them.
function testGate(t, cfg, reportText) {
  const dir = `${accDir(cfg)}/${t.id}`;
  const files = listFiles(dir);
  const g = { written: files.length ? "pass" : "fail" };
  const covered = new Set([...reportText.matchAll(/^\s*[-*]?\s*COVERS:\s*C(\d+)/gmi)].map((m) => +m[1]));
  const missing = t.criteria.map((_, i) => i + 1).filter((n) => !covered.has(n));
  g.coverage = missing.length ? "fail" : "pass"; g._missing = missing;
  const checks = [];
  const cmd = acceptanceCmd(cfg, t);
  if (cmd && files.length) {
    const r = runCmd("acceptance (must fail now)", cmd, cfg);
    g.red = r.ok ? "fail" : "pass";
    checks.push({ ...r, ok: !r.ok, expectRed: true });
  } else g.red = "skipped";
  const failed = Object.entries(g).filter(([k, v]) => !k.startsWith("_") && v === "fail").map(([k]) => k);
  if (!failed.length && isGit() && files.length) {
    git(`add -- "${dir}"`);
    git(`commit -q -m "ticket ${t.id}: acceptance tests (locked)" -- "${dir}"`);
  }
  if (!failed.length) t.locked = Object.fromEntries(files.map((f) => [f, hashFile(f)]));
  return { g, checks, failed };
}

// After the implementer: committed, clean, acceptance tests untouched and green, no test removed or weakened, checks green.
function implementerGate(t, cur, cfg) {
  const g = {};
  const dir = `${accDir(cfg)}/${t.id}/`;
  if (isGit()) {
    g.commit = git("rev-parse HEAD") !== cur.snap?.head ? "pass" : "fail";
    g.clean = (dirtyFiles() ?? []).length === 0 ? "pass" : "fail";
    const deleted = (git(`diff --name-only --diff-filter=D ${t.base}..HEAD`) ?? "").split("\n").filter((f) => f && TEST_FILE.test(f));
    g.testsKept = deleted.length ? "fail" : "pass"; g._deleted = deleted;
    // tests the implementer changed: no skip/only added, no net loss of assertions in tests that existed before
    const lockedCommit = git(`log -1 --format=%H --grep="ticket ${t.id}: acceptance tests" ${t.base}..HEAD`) || t.base;
    const changed = (git(`diff --name-only ${lockedCommit}..HEAD`) ?? "").split("\n").filter((f) => f && TEST_FILE.test(f) && !f.startsWith(dir));
    const weak = [];
    for (const f of changed) {
      const d = git(`diff -U0 ${lockedCommit}..HEAD -- "${f}"`, true) ?? "";
      const add = d.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++"));
      const del = d.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"));
      if (add.some((l) => DISABLE.test(l))) weak.push(`${f}: test disabled (skip/only)`);
      const existed = git(`cat-file -e ${lockedCommit}:"${f}"`) !== null;
      const lost = del.filter((l) => ASSERT.test(l)).length - add.filter((l) => ASSERT.test(l)).length;
      if (existed && lost > 0) weak.push(`${f}: ${lost} assertion(s) removed`);
    }
    g.notWeakened = weak.length ? "fail" : "pass"; g._weak = weak;
  }
  if (t.locked) {
    const broken = Object.entries(t.locked).filter(([f, h]) => !fs.existsSync(path.join(ROOT, f)) || hashFile(f) !== h).map(([f]) => f);
    g.locked = broken.length ? "fail" : "pass"; g._broken = broken;
  }
  const checks = [];
  const cmd = acceptanceCmd(cfg, t);
  if (cmd && t.locked && Object.keys(t.locked).length) { const r = runCmd("acceptance", cmd, cfg); checks.push(r); g.acceptance = r.ok ? "pass" : "fail"; }
  const rc = runChecks(cfg); checks.push(...rc);
  g.checks = rc.length ? (rc.every((c) => c.ok) ? "pass" : "fail") : "skipped";
  const failed = Object.entries(g).filter(([k, v]) => !k.startsWith("_") && v === "fail").map(([k]) => k);
  return { g, checks, failed };
}

function writeGateReport(file, t, title, g, checks, failed) {
  const L = [`# ${title} — ticket ${t.id}, attempt ${t.attempt}`, "", "Code, not a model, ran these checks. Every failure below must be fixed.", ""];
  const detail = {
    written: `no test files under the acceptance directory`,
    coverage: `criteria without a COVERS line: ${(g._missing ?? []).map((n) => `C${n}`).join(", ")}`,
    red: `the acceptance tests already pass before any implementation`,
    commit: `no new commit since the run started`,
    clean: `uncommitted changes remain: ${(dirtyFiles() ?? []).join(", ")}`,
    testsKept: `test files were deleted: ${(g._deleted ?? []).join(", ")}`,
    locked: `locked acceptance tests were changed or deleted: ${(g._broken ?? []).join(", ")}`,
    notWeakened: (g._weak ?? []).join("; "),
    acceptance: `the ticket's acceptance tests fail`,
    checks: `automated checks fail`,
  };
  let n = 0;
  for (const k of failed) {
    n++;
    L.push(`### Finding ${n}: gate \`${k}\` failed`, `- Where: ${detail[k]}`, `- Rule: factory gate \`${k}\``,
      `- Fix: ${k === "locked" ? "restore the acceptance tests from the lock commit; return DISPUTE if one is wrong" : "make the gate condition true, then return PASS"}`,
      `- LESSON${GATE_TARGET[k] ? `(${GATE_TARGET[k]})` : ""}: ${GATE_LESSONS[k]}`, "");
  }
  for (const c of checks) {
    L.push(`- ${c.ok ? "✅" : "❌"} **${c.name}** \`${c.cmd}\``);
    if (!c.ok || c.expectRed) L.push("```", c.tail, "```");
  }
  if (!checks.length) L.push("- ⚠️ no command configured for this gate in factory/config.json");
  L.push("", `VERDICT: ${failed.length ? "FAIL" : "PASS"}`, `SUMMARY: ${failed.length ? `gate failed: ${failed.join(", ")}` : "all gates passed"}`);
  fs.mkdirSync(path.dirname(path.join(ROOT, file)), { recursive: true });
  fs.writeFileSync(path.join(ROOT, file), L.join("\n") + "\n");
}

// A read-only agent must leave HEAD and the working tree exactly as it found them.
function scopeViolation(cur, cfg) {
  if (!cur.snap || cur.snap.head == null) return null;
  const head = git("rev-parse HEAD");
  if (head !== cur.snap.head) return "it created or changed commits";
  const allowed = cur.agent === "planner" ? (f) => /^(GLOSSARY(-MAP)?\.md|docs\/adr\/)/.test(f) || /\/GLOSSARY\.md$/.test(f)
    : isTestStage(cur.agent) ? (f) => f.startsWith(`${accDir(cfg)}/${cur.ticket}/`)
    : cur.agent === "retro" && cur.mode === "apply" ? (f) => (cur.targets ?? []).includes(f) : () => false;
  const before = new Set(cur.snap.dirty);
  const changed = (dirtyFiles() ?? []).filter((f) => !before.has(f) && !allowed(f));
  return changed.length ? `it changed files it must not touch: ${changed.slice(0, 8).join(", ")}` : null;
}

// ---------- prompts (context pointers only, never pasted content) ----------
function promptFor(state, step) {
  const cfg = config();
  const lang = cfg.language === "ar" ? "Write the SUMMARY line in Arabic." : "";
  const tail = `\nWrite your report to \`${step.report}\`. End it with:\nVERDICT: <one of ${step.verdicts.join(" | ")}>\nSUMMARY: <one line>\n${lang}\nReply to me with only the VERDICT and SUMMARY lines.`;
  const lessons = lessonsFile(step.agent) ? `Lessons from past rejections of your work: \`${lessonsFile(step.agent)}\`. Read it first and follow every lesson.\n` : "";
  const protocol = REVIEWERS.includes(step.agent) ? "Review protocol (strict, and teach with a LESSON per finding): `factory/REVIEW-PROTOCOL.md`.\n" : "";
  const spec = "factory/spec.md";
  const head = lessons + protocol;
  if (step.agent === "planner") {
    if (step.mode === "plan") {
      const answers = fs.existsSync(P("answers.md")) ? "factory/answers.md" : null;
      const mayAsk = state.plan.questionRounds < (cfg.maxQuestionRounds ?? 2);
      return head + `MODE: plan\nGoal: \`factory/brief.md\`.${answers ? ` Human answers so far: \`${answers}\` (questions: \`factory/questions.md\`).` : ""}\n` +
        (mayAsk ? `If decisions are still open, write them to \`factory/questions.md\` and return VERDICT: QUESTIONS.\n`
                : `Do not ask more questions: take your recommended answer for anything still open and record it in the spec.\n`) +
        `Otherwise write \`${spec}\` and the tickets in \`factory/tickets/\`, then return VERDICT: PASS.` + tail;
    }
    return head + `MODE: revise\nSpec: \`${spec}\`. Tickets: \`factory/tickets/\`.\nFinding to resolve: \`${step.reworkFrom}\`${step.ticket !== "final" ? ` (about ticket ${step.ticket})` : ""}.\n` +
      `Fix the spec/ticket, or add new numbered tickets for missing work. Never renumber or delete a done ticket.` + tail;
  }
  if (step.agent === "retro") {
    if (step.mode === "propose")
      return head + `MODE: propose\nFacts compiled by code from this run: \`factory/retro/facts.md\`. Lessons: \`factory/lessons/\`. Agents: \`.claude/agents/\`. Config: \`factory/config.json\`.` + tail;
    const r = state.retro;
    return head + `MODE: apply\nYour proposals: \`factory/retro/propose.md\`. The human accepted: ${r.accepted.join(", ")}.\nYou may change only these files: ${step.targets.map((t) => `\`${t}\``).join(", ")}.` + tail;
  }
  if (step.agent === "final-reviewer")
    return head + `MODE: final\nSpec: \`${spec}\`. All tickets: \`factory/tickets/\`. Whole change: \`git diff ${state.finalBase ?? "<first base>"}..HEAD\`.` + tail;
  const t = state.tickets.find((x) => x.id === step.ticket);
  const acc = `${accDir(cfg)}/${t.id}/`;
  const base = `Ticket: \`${t.file}\` (${t.criteria.length} acceptance criteria). Spec: \`${spec}\`. Attempt ${t.attempt} of ${cfg.maxAttempts ?? 3}.`;
  const diff = t.base ? `Diff under review: \`git diff ${t.base}..HEAD\`.` : "No git base: use the files listed in the implementer's latest report.";
  const rework = t.reworkFrom ? `\nREWORK: read \`${t.reworkFrom}\` first and fix every finding in it.` : "";
  const prev = t.lastRejection && t.lastRejection.agent === step.agent
    ? `\nYou rejected this ticket before: \`${t.lastRejection.report}\`. Confirm every finding there is fixed first; an unfixed one is an automatic FAIL.` : "";
  if (step.agent === "test-writer") {
    const mode = t.disputeFrom ? `\nDISPUTE: the implementer disputes your tests: \`${t.disputeFrom}\`. Fix the test if it is wrong; if it is right, keep it and teach the implementer why.` : rework || "\nFresh start.";
    return head + `${base}\nWrite acceptance tests only under \`${acc}\`. Code verifies, commits and locks them.${mode}` + tail;
  }
  if (step.agent === "diagnoser") {
    const info = fs.existsSync(P("answers.md")) ? ` Information the human gave so far: \`factory/answers.md\`.` : "";
    const mode = t.disputeFrom ? `\nDISPUTE: the implementer disputes your regression test: \`${t.disputeFrom}\`. Fix it if it is wrong; if it is right, keep it and teach the implementer why.` : rework || "\nFresh start.";
    return head + `${base} This is a BUG ticket: the symptom is in the ticket.${info}\nWrite the regression test only under \`${acc}\`. Code verifies it fails, then commits and locks it. Revert all instrumentation before you finish.${mode}` + tail;
  }
  const bug = t.type === "bug";
  const firstReport = `factory/reports/${t.id}/${firstStage(t)}-${t.attempt}.md`;
  const accLine = t.testsSkipped ? `The ${firstStage(t)} marked this ticket SKIP (no locked test); its report explains why.`
    : `Locked ${bug ? "regression test" : "acceptance tests"}: \`${acc}\` (${firstStage(t)} report: \`${firstReport}\` or the latest one).`;
  const bugLine = bug ? `\nThis is a BUG ticket. The diagnosis (feedback loop command, root cause, fix direction) is in the diagnoser's report. Fix the root cause, not the symptom, and run the feedback loop command: it must go green.` : "";
  if (step.agent === "implementer")
    return head + `${base}\n${accLine} You cannot edit them. Make them pass. If one contradicts the ticket, return DISPUTE with the exact reason.${bugLine}${rework || "\nFresh start."}` +
      (t.attempt > 1 ? ` Your previous report: \`factory/reports/${t.id}/implementer-${t.attempt - 1}.md\`.` : "") + tail;
  const tester = step.agent === "tester" ? (bug
    ? "\nThis is a BUG ticket: run the diagnoser's feedback loop command from its report and confirm it is green, and that the regression test really reproduces the reported symptom. If the regression test is wrong or too shallow, return FAIL_TESTS."
    : "\nAlso judge the acceptance tests: does each criterion have a test that really checks it (main case, implied boundaries and failures)? If the tests are wrong or incomplete, return FAIL_TESTS.") : "";
  const reviewerBug = step.agent === "reviewer" && bug ? "\nThis is a BUG ticket: check the fix addresses the root cause named in the diagnoser's report, not just the symptom, and that nothing else changed." : "";
  return head + `${base}\n${accLine}\nImplementer report: \`factory/reports/${t.id}/implementer-${t.attempt}.md\`. Gate report: \`factory/reports/${t.id}/gate-${t.attempt}.md\`.\n${diff}${prev}${tester}${reviewerBug}` + tail;
}

function verdictsFor(agent, mode) {
  return {
    planner: mode === "plan" ? ["PASS", "QUESTIONS"] : ["PASS"],
    "test-writer": ["PASS", "SKIP"],
    diagnoser: ["PASS", "SKIP", "NEED_INFO"],
    implementer: ["PASS", "FAIL", "DISPUTE"],
    tester: ["PASS", "FAIL", "FAIL_TESTS"],
    reviewer: ["PASS", "FAIL", "FAIL_PLAN"],
    retro: mode === "propose" ? ["PASS"] : ["PASS", "FAIL"],
  }[agent] ?? ["PASS", "FAIL"];
}

// ---------- next ----------
function computeNext(state) {
  const cfg = config();
  if (state.pending) return { action: "ask_human", ...state.pending };
  if (state.phase === "finished") return { action: "finished" };
  if (state.phase === "discovery")
    return { action: "ask_human", type: "discovery", ticket: "plan",
      reason: "The plan is written in an interactive discovery session with the human. Ask them to run `claude --agent discovery` (or /discovery), then start the build again once it says plan-ready passed." };

  let step;
  if (state.planRevision) {
    const n = ++state.plan.runs;
    step = { agent: "planner", mode: "revise", ticket: state.planRevision.ticket, attempt: n, reworkFrom: state.planRevision.report };
  } else if (state.phase === "planning") {
    const n = ++state.plan.runs;
    step = { agent: "planner", mode: "plan", ticket: "plan", attempt: n };
  } else if (state.phase === "building") {
    const t = readyTicket(state);
    if (!t) {
      if (state.tickets.every((x) => x.status === "done" || x.status === "skipped")) {
        if (state.bugOnly) { state.phase = "finished"; event(state, { type: "finished", ticket: "final" }); return { action: "finished" }; }
        state.phase = "final"; return computeNext(state);
      }
      state.pending = { type: "stuck", ticket: "-", reason: "No ticket is ready: the remaining ones are blocked." };
      return { action: "ask_human", ...state.pending };
    }
    if (t.status !== "active") {
      t.status = "active"; t.startedAt = now();
      t.base = git("rev-parse HEAD");
      state.finalBase ??= t.base;
    }
    step = { agent: t.stage, ticket: t.id, attempt: t.attempt };
  } else if (state.phase === "final") {
    state.finalRounds = (state.finalRounds ?? 0) + 1;
    step = { agent: "final-reviewer", mode: "final", ticket: "final", attempt: state.finalRounds };
  } else if (state.phase === "retro") {
    const r = state.retro ?? (state.retro = { status: "pending", proposals: [], accepted: [] });
    if (r.status === "pending") { writeRetroFacts(state); step = { agent: "retro", mode: "propose", ticket: "retro", attempt: 1 }; }
    else if (r.status === "accepted") step = { agent: "retro", mode: "apply", ticket: "retro", attempt: 1,
      targets: [...new Set(r.proposals.filter((p) => r.accepted.includes(p.id)).flatMap((p) => p.targets))] };
    else { state.phase = "finished"; return { action: "finished" }; }
  }
  const dir = step.ticket === "plan" ? "plan" : step.ticket;
  step.report = step.agent === "retro" ? `factory/retro/${step.mode}.md`
    : `factory/reports/${dir}/${step.agent}-${step.mode === "revise" ? "revise-" : ""}${step.attempt}.md`;
  step.verdicts = verdictsFor(step.agent, step.mode);
  step.model = (cfg.models ?? {})[step.agent];
  step.effort = effortFor(cfg, step.agent, step.attempt, step.ticket);
  step.prompt = promptFor(state, step);
  return { action: "run", ...step };
}

// Reasoning level per agent, from config. On rework the agent that redoes the work thinks harder:
// one level up per extra attempt, capped at effortEscalation.max.
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
function effortFor(cfg, agent, attempt, ticket) {
  const base = (cfg.effort ?? {})[agent];
  if (!EFFORTS.includes(base)) return null;
  const esc = cfg.effortEscalation ?? {};
  if (!esc.enabled || !(esc.agents ?? []).includes(agent) || ticket === "plan" || ticket === "final") return base;
  const cap = EFFORTS.indexOf(esc.max ?? "xhigh");
  return EFFORTS[Math.min(EFFORTS.indexOf(base) + Math.max(0, (attempt ?? 1) - 1), Math.max(cap, EFFORTS.indexOf(base)))];
}

// The orchestrator has no file-writing tools: it hands the brief and the human's answers to these commands.
// End of the discovery session: check what it produced before the factory may build from it.
// Every problem is listed so the discovery agent can fix them all in one pass.
// ---------- retro ----------
const RETRO_HISTORY = P("retro", "history.json");
const RETRO_TARGET_OK = /^(CODING_STANDARDS\.md|CONTRIBUTING\.md|CLAUDE\.md|AGENTS\.md|docs\/.+|\.claude\/agents\/[\w-]+\.md|factory\/config\.json|factory\/REVIEW-PROTOCOL\.md|package\.json|\.husky\/.+|\.github\/workflows\/.+|[^/]*(eslint|prettier|biome|tsconfig|vitest|jest|ruff|pyproject|setup\.cfg|\.editorconfig)[^/]*)$/i;

// Everything the retro agent needs as numbers, compiled by code so it does not spend tokens gathering them.
function writeRetroFacts(state) {
  const E = state.events, usage = readJSON(P("usage.json"), { runs: {} });
  const runs = Object.values(usage.runs ?? {});
  const lessons = readJSON(LESSONS, {});
  const L = [`# Retro facts: ${state.project}`, "", `Compiled by factory.mjs at ${now()}. Numbers only; open the reports it points to for detail.`, ""];
  const count = (f) => E.filter(f).length;
  L.push("## Outcome", `- Tickets: ${state.tickets.length} (${state.tickets.filter((t) => t.status === "done").length} done, ${state.tickets.filter((t) => t.status === "skipped").length} skipped)`,
    `- Rejections back to the implementer: ${count((e) => e.type === "fail" || (e.type === "gate_fail" && e.agent === "gate"))}`,
    `- Rejections back to the test-writer: ${count((e) => e.type === "fail_tests" || (e.type === "gate_fail" && e.agent === "testgate"))}, disputes: ${count((e) => e.type === "dispute")}`,
    `- Plan errors (back to the planner): ${count((e) => e.type === "fail_plan")}, final-review rounds: ${state.finalRounds ?? 0}`,
    `- Permission violations: ${count((e) => e.type === "violation")}, tickets that hit the attempt limit: ${count((e) => e.type === "blocked")}`, "");
  L.push("## Rejections by stage", "| stage | count | reports |", "|---|---|---|");
  const byStage = {};
  for (const e of E.filter((e) => ["fail", "gate_fail", "fail_tests", "fail_plan", "dispute"].includes(e.type))) {
    const k = `${e.agent} (${e.type})`; (byStage[k] ??= []).push(e);
  }
  for (const [k, es] of Object.entries(byStage).sort((a, b) => b[1].length - a[1].length))
    L.push(`| ${k} | ${es.length} | ${es.slice(0, 6).map((e) => `\`${e.report ?? "-"}\``).join(", ")} |`);
  if (!Object.keys(byStage).length) L.push("| none | 0 | |");
  const gateKinds = {};
  for (const e of E.filter((e) => e.type === "gate_fail")) for (const k of String(e.summary ?? "").replace(/.*:\s*/, "").split(/[،,]\s*/)) if (k) gateKinds[k] = (gateKinds[k] ?? 0) + 1;
  L.push("", "## Gate failures by kind", ...(Object.keys(gateKinds).length ? Object.entries(gateKinds).map(([k, n]) => `- ${k}: ${n}`) : ["- none"]));
  L.push("", "## Tickets", "| ticket | feature | attempts | status | rejected by | tokens |", "|---|---|---|---|---|---|");
  for (const t of state.tickets) {
    const rej = E.filter((e) => e.ticket === t.id && ["fail", "gate_fail", "fail_tests", "fail_plan", "dispute"].includes(e.type)).map((e) => e.agent);
    const tok = runs.filter((r) => r.ticket === t.id).reduce((a, r) => a + (r.total ?? 0), 0);
    L.push(`| ${t.id} ${t.title} | ${t.feature ?? "-"} | ${t.attempt} | ${t.status} | ${rej.join(", ") || "-"} | ${tok} |`);
  }
  L.push("", "## Lessons recorded or repeated in this project", "| agent | count | lesson |", "|---|---|---|");
  let any = false;
  for (const [agent, book] of Object.entries(lessons)) for (const x of Object.values(book))
    if (x.project === state.project || x.tickets.some((id) => state.tickets.some((t) => t.id === id))) { any = true; L.push(`| ${agent} | ${x.count} | ${x.text} |`); }
  if (!any) L.push("| none | | |");
  L.push("", "## Tokens by agent", "| agent | runs | tokens | model |", "|---|---|---|---|");
  const byAgent = {};
  for (const r of runs) { const a = (byAgent[r.agent] ??= { runs: 0, total: 0, model: r.model }); a.runs++; a.total += r.total ?? 0; }
  for (const [a, v] of Object.entries(byAgent).sort((x, y) => y[1].total - x[1].total)) L.push(`| ${a} | ${v.runs} | ${v.total} | ${v.model ?? ""} |`);
  if (usage.main) L.push(`| orchestrator (main session) | - | ${usage.main.total ?? 0} | ${usage.main.model ?? ""} |`);
  if (usage.discovery) L.push(`| discovery (main session) | - | ${usage.discovery.total ?? 0} | ${usage.discovery.model ?? ""} |`);
  const blocks = fs.existsSync(P("guard-log.jsonl")) ? fs.readFileSync(P("guard-log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  L.push("", "## Actions the guard blocked", ...(blocks.length ? Object.entries(blocks.reduce((m, b) => { const k = `${b.agent ?? "main"}: ${b.reason}`; m[k] = (m[k] ?? 0) + 1; return m; }, {})).map(([k, n]) => `- ${n}× ${k}`) : ["- none"]));
  fs.mkdirSync(P("retro"), { recursive: true });
  fs.writeFileSync(P("retro", "facts.md"), L.join("\n") + "\n");
}

function parseProposals(text) {
  const out = [];
  for (const m of text.matchAll(/^###\s*(R\d+)\s*[:.\-—]\s*(.+)$/gm)) {
    const body = text.slice(m.index + m[0].length).split(/^###\s/m)[0];
    const field = (k) => ((body.match(new RegExp(`^\\s*-\\s*\\**${k}:?\\**\\s*:?\\s*(.+)$`, "mi")) || [])[1] || "").trim();
    const targets = field("Target").split(/[,،]/).map((s) => s.trim().replace(/^`|`$/g, "")).filter(Boolean);
    out.push({ id: m[1].toUpperCase(), title: m[2].trim(), category: field("Category"), severity: field("Severity").toLowerCase(),
      evidence: field("Evidence"), change: field("Change"), targets, status: "proposed",
      manual: targets.length === 0 || targets.some((t) => t === "manual" || !RETRO_TARGET_OK.test(t)) });
  }
  return out;
}

function saveRetroHistory(state) {
  const h = readJSON(RETRO_HISTORY, []);
  const entry = { project: state.project, at: now(), proposals: state.retro.proposals.map(({ id, title, category, severity, status, targets }) => ({ id, title, category, severity, status, targets })) };
  const i = h.findIndex((x) => x.project === state.project);
  if (i >= 0) h[i] = entry; else h.push(entry);
  writeJSON(RETRO_HISTORY, h);
}

function recordRetro(state, cfg, cur, verdict, summary, text, base, out) {
  const r = state.retro;
  if (cur.mode === "propose") {
    r.proposals = parseProposals(text);
    event(state, { type: "retro_proposed", ...base, summary: summary || `${r.proposals.length} مقترحات` });
    if (!r.proposals.length) { r.status = "done"; state.phase = "finished"; event(state, { type: "finished", ticket: "final" }); }
    else {
      r.status = "proposed";
      state.pending = { type: "retro_review", ticket: "retro", file: cur.report,
        reason: `The retro proposes ${r.proposals.length} change(s) to the factory. Show them to the human and run \`retro-accept <ids>\`, \`retro-accept all\` or \`retro-accept none\`.` };
    }
    saveRetroHistory(state);
    return out(verdict, summary);
  }
  // apply: commit exactly the accepted targets that changed
  const targets = cur.targets ?? [];
  const changed = targets.filter((t) => { const d = git(`status --porcelain -- "${t}"`); return d && d.trim(); });
  if (changed.length && isGit()) { git(`add -- ${changed.map((t) => `"${t}"`).join(" ")}`); git(`commit -q -m "retro: apply ${r.accepted.join(", ")}" -- ${changed.map((t) => `"${t}"`).join(" ")}`); }
  for (const p of r.proposals) if (r.accepted.includes(p.id)) p.status = verdict === "PASS" ? "applied" : (targets.length && p.targets.some((t) => changed.includes(t)) ? "applied" : "not-applied");
  r.status = "done"; state.phase = "finished";
  event(state, { type: "retro_applied", ...base, summary: summary || `${changed.length} files` });
  event(state, { type: "finished", ticket: "final" });
  saveRetroHistory(state);
  return out(verdict, summary);
}

function retroAccept(args) {
  const state = loadState();
  const r = state.retro;
  if (state.pending?.type !== "retro_review" || !r) { console.log("Nothing to accept: no retro proposals are waiting."); return; }
  const ids = args.map((a) => a.toUpperCase());
  const auto = r.proposals.filter((p) => !p.manual);
  const accepted = ids.includes("NONE") ? [] : ids.includes("ALL") ? auto.map((p) => p.id) : auto.filter((p) => ids.includes(p.id)).map((p) => p.id);
  const unknown = ids.filter((i) => !["ALL", "NONE"].includes(i) && !r.proposals.some((p) => p.id === i));
  if (unknown.length) { console.error(`Unknown proposal id(s): ${unknown.join(", ")}`); process.exit(1); }
  for (const p of r.proposals) p.status = accepted.includes(p.id) ? "accepted" : p.manual && ids.includes(p.id) ? "manual" : "rejected";
  r.accepted = accepted;
  state.pending = null;
  event(state, { type: "retro_decision", ticket: "retro", summary: accepted.length ? `قبلت ${accepted.join("، ")}` : "لم تقبل أي مقترح" });
  if (accepted.length) r.status = "accepted";
  else { r.status = "done"; state.phase = "finished"; event(state, { type: "finished", ticket: "final" }); }
  saveRetroHistory(state);
  save(state);
  const manual = r.proposals.filter((p) => p.manual && ids.includes(p.id));
  console.log(accepted.length ? `Accepted ${accepted.join(", ")}. Run \`next\`: the retro agent applies them.` : "No proposal accepted. The project is finished.");
  if (manual.length) console.log(`Needs a human (outside the factory's environment files): ${manual.map((p) => `${p.id} ${p.title}`).join("; ")}`);
}

function planReady() {
  const state = loadState();
  const cfg = config();
  const errors = [], warnings = [];
  if (state.phase !== "discovery") { console.log(`Nothing to do: the project is in phase "${state.phase}".`); return; }
  const spec = fs.existsSync(P("spec.md")) ? fs.readFileSync(P("spec.md"), "utf8") : "";
  if (!spec) errors.push("factory/spec.md is missing.");
  const features = readFeatures();
  if (spec && !features.length) errors.push("spec.md has no features: add one heading per feature, exactly `### F1: <name>`.");
  for (const [name, re] of [["Seams under test", /^#{1,4}\s*Seams under test/mi], ["Automated checks", /^#{1,4}\s*Automated checks/mi], ["Out of Scope", /^#{1,4}\s*Out of Scope/mi]])
    if (spec && !re.test(spec)) errors.push(`spec.md has no "${name}" section.`);
  const dir = P("tickets");
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d+.*\.md$/.test(f)).sort() : [];
  if (!files.length) errors.push("No tickets in factory/tickets/ (expected 01-<slug>.md, 02-…).");
  const ids = new Set(files.map((f) => f.match(/^(\d+)/)[1].padStart(2, "0")));
  const edges = {};
  for (const f of files) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    const id = f.match(/^(\d+)/)[1].padStart(2, "0");
    if (!/^#\s*\d+\s*[:.\-]\s*.+$/m.test(text)) errors.push(`${f}: first heading must be "# ${id}: <title>".`);
    const feat = ((text.match(/\*\*Feature:\*\*\s*(F\d+)/i) || [])[1] || "").toUpperCase();
    if (!feat) errors.push(`${f}: missing "**Feature:** F<n>".`);
    else if (!features.some((x) => x.id === feat)) errors.push(`${f}: feature ${feat} is not a "### ${feat}:" heading in spec.md.`);
    const bl = text.match(/\*\*Blocked by:\*\*(.*)$/mi);
    if (!bl) errors.push(`${f}: missing "**Blocked by:**" (write "None" if it can start immediately).`);
    const blockers = !bl || /none/i.test(bl[1]) ? [] : [...bl[1].matchAll(/\b(\d{1,3})\b/g)].map((m) => m[1].padStart(2, "0"));
    for (const b of blockers) if (!ids.has(b)) errors.push(`${f}: blocked by ${b}, which has no ticket file.`);
    edges[id] = blockers;
    const criteria = [...text.matchAll(/^\s*-\s*\[[ xX]\]\s*(.+)$/gm)].length;
    if (!criteria) errors.push(`${f}: no acceptance criteria (\`- [ ] ...\`).`);
    if (!/\*\*What to build:\*\*/i.test(text)) warnings.push(`${f}: no "**What to build:**" line.`);
  }
  // blocking edges must form a DAG
  const seen = {}, cyc = new Set();
  const visit = (n, stack) => { if (stack.includes(n)) { stack.slice(stack.indexOf(n)).forEach((x) => cyc.add(x)); return; } if (seen[n]) return; seen[n] = 1; (edges[n] ?? []).forEach((m) => visit(m, [...stack, n])); };
  Object.keys(edges).forEach((n) => visit(n, []));
  if (cyc.size) errors.push(`Blocking edges form a cycle between tickets ${[...cyc].sort().join(", ")}.`);
  if (files.length && !Object.values(edges).some((b) => !b.length)) errors.push("Every ticket is blocked by another: at least one must start immediately.");
  for (const f of features) if (!files.some((x) => new RegExp(`\\*\\*Feature:\\*\\*\\s*${f.id}\\b`, "i").test(fs.readFileSync(path.join(dir, x), "utf8")))) warnings.push(`Feature ${f.id} (${f.name}) has no tickets.`);
  if (!Object.values(cfg.checks ?? {}).some((c) => c && String(c).trim())) errors.push("factory/config.json → checks is empty: set the typecheck / lint / test commands.");
  if (!(cfg.acceptance?.command || "").trim()) errors.push("factory/config.json → acceptance.command is empty: set the command that runs one ticket's acceptance tests, with {dir}.");
  else if (!cfg.acceptance.command.includes("{dir}")) errors.push("acceptance.command must contain {dir}, the ticket's acceptance folder.");
  // discovery must not have changed source code on the working branch
  const branch = git("rev-parse --abbrev-ref HEAD");
  if (branch && branch.startsWith("prototype/")) errors.push(`You are on ${branch}: return to the working branch before plan-ready.`);
  const allowed = (f) => /^(GLOSSARY(-MAP)?\.md|docs\/adr\/|prototypes\/)/.test(f) || /\/GLOSSARY\.md$/.test(f);
  const touched = (dirtyFiles() ?? []).filter((f) => !allowed(f));
  if (touched.length) errors.push(`Discovery changed files outside its scope: ${touched.slice(0, 8).join(", ")}. Move prototype code to a prototype/<name> branch or prototypes/.`);

  if (errors.length) {
    console.log(`plan-ready: ${errors.length} problem(s) to fix:`);
    errors.forEach((e) => console.log(`  ✗ ${e}`));
    warnings.forEach((w) => console.log(`  ! ${w}`));
    process.exit(1);
  }
  importTickets(state);
  state.plan = { ...state.plan, status: "done", mode: "interactive", runs: state.plan.runs };
  state.phase = "building";
  const rounds = fs.existsSync(P("discovery", "session.md")) ? (fs.readFileSync(P("discovery", "session.md"), "utf8").match(/^#{2,3}\s*(Round|الجولة)/gmi) || []).length : 0;
  event(state, { type: "pass", ticket: "plan", agent: "discovery",
    summary: `${features.length} ميزات و${state.tickets.length} مهام${rounds ? ` بعد ${rounds} جولات أسئلة` : ""}`, report: fs.existsSync(P("discovery", "session.md")) ? "factory/discovery/session.md" : undefined });
  save(state);
  warnings.forEach((w) => console.log(`  ! ${w}`));
  console.log(`plan-ready: OK. ${features.length} features, ${state.tickets.length} tickets. Start the build in a new session: claude --agent orchestrator`);
}

function readStdin() { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } }
function writeBrief() {
  const text = readStdin().trim();
  if (!text) { console.error("brief: pass the goal on stdin"); process.exit(1); }
  fs.writeFileSync(P("brief.md"), `# Brief\n\n${text}\n`);
  console.log("Wrote factory/brief.md");
}
function writeAnswers() {
  const text = readStdin().trim();
  if (!text) { console.error("answer: pass the human's answers on stdin"); process.exit(1); }
  const s = readJSON(P("state.json"), null);
  const round = s?.plan?.questionRounds ?? 1;
  fs.appendFileSync(P("answers.md"), `${fs.existsSync(P("answers.md")) ? "\n" : "# Answers\n\n"}## Round ${round}\n\n${text}\n`);
  console.log(`Appended round ${round} to factory/answers.md`);
}

function next() {
  const state = loadState();
  if (state.current) {
    const { snap, ...cur } = state.current;
    console.log(JSON.stringify({ action: "run", ...cur, note: "already running; run `record` after the agent finishes" }, null, 2));
    return;
  }
  const out = computeNext(state);
  if (out.action === "run") {
    const { action, ...cur } = out;
    state.current = { ...cur, startedAt: now(), snap: { head: git("rev-parse HEAD"), dirty: dirtyFiles() ?? [] } };
    const t = state.tickets.find((x) => x.id === out.ticket);
    if (t) t.stages[out.agent] = "running";
    event(state, { type: "start", ticket: out.ticket, agent: out.agent, attempt: out.attempt });
  }
  save(state);
  console.log(JSON.stringify(out, null, 2));
}

// ---------- record ----------
function sendBack(state, t, cfg, fromStage, report, summary, target = "implementer") {
  t.lastRejection = { agent: fromStage, report };
  if (t.attempt >= (cfg.maxAttempts ?? 3)) {
    t.status = "blocked";
    state.pending = { type: "blocked", ticket: t.id, file: report,
      reason: `Ticket ${t.id} failed ${t.attempt} attempts. Ask the human, then run \`resume ${t.id} retry\` or \`resume ${t.id} skip\`.` };
    event(state, { type: "blocked", ticket: t.id, summary });
    return;
  }
  if (target === "test-writer") target = firstStage(t); // the test stage of a bug ticket is the diagnoser
  t.attempt++; t.stage = target; t.reworkFrom = report;
  if (isTestStage(target)) t.locked = null; // tests will be rewritten, then verified and locked again
  stagesFor(t).forEach((a) => { t.stages[a] = "pending"; });
  if (target === "implementer" && t.locked) t.stages[firstStage(t)] = "pass"; // tests stay locked and valid
  t.stages[fromStage] = "fail";
}

function recordGate(state, t, cfg, kind, res) {
  const file = `factory/reports/${t.id}/${kind === "test" ? "test-gate" : "gate"}-${t.attempt}${kind === "final" ? "-final" : ""}.md`;
  writeGateReport(file, t, kind === "test" ? "Acceptance test gate" : "Gate report", res.g, res.checks, res.failed);
  t.gates = Object.fromEntries(Object.entries({ ...t.gates, ...res.g }).filter(([k]) => !k.startsWith("_")));
  if (kind !== "test") t.stages.gate = res.failed.length ? "fail" : "pass";
  state.gateStats ??= { pass: 0, fail: 0 };
  state.gateStats[res.failed.length ? "fail" : "pass"]++;
  const label = kind === "test" ? "بوابة الاختبارات" : "البوابة الآلية";
  event(state, { type: res.failed.length ? "gate_fail" : "gate_pass", ticket: t.id, agent: kind === "test" ? "testgate" : "gate", attempt: t.attempt,
    summary: res.failed.length ? `${label} رفضت: ${res.failed.join("، ")}` : `${label}: كل الشروط تحققت`, report: file });
  if (res.failed.length) {
    const target = kind === "test" ? firstStage(t) : "implementer";
    const lessons = extractLessons(fs.readFileSync(path.join(ROOT, file), "utf8"), target).map((l) => ({ ...l, target: l.target === "test-writer" ? firstStage(t) : l.target }));
    addLessons(state, lessons, { ticket: t.id, from: kind === "test" ? "testgate" : "gate" });
  }
  return file;
}

function record() {
  const state = loadState();
  const cfg = config();
  const cur = state.current;
  if (!cur) { console.log(JSON.stringify({ ok: false, error: "nothing running; call next" })); return; }
  const reportAbs = path.join(ROOT, cur.report);
  const text = fs.existsSync(reportAbs) ? fs.readFileSync(reportAbs, "utf8") : "";
  let verdict = (text.match(/^\s*\**VERDICT:?\**\s*:?\s*([A-Z_]+)/mi) || [])[1]?.toUpperCase();
  let summary = (text.match(/^\s*\**SUMMARY:?\**\s*:?\s*(.+)$/mi) || [, text ? "" : "no report written"])[1].trim();
  if (!cur.verdicts.includes(verdict)) { verdict = "FAIL"; summary ||= "report has no valid VERDICT line"; }
  const durationMs = Date.now() - Date.parse(cur.startedAt);
  const base = { ticket: cur.ticket, agent: cur.agent, attempt: cur.attempt, summary, report: cur.report, durationMs };
  const t = state.tickets.find((x) => x.id === cur.ticket);
  const out = (v, s) => { save(state); console.log(JSON.stringify({ ok: true, verdict: v, summary: s, next: "run `next`" })); };

  // Gate: every role except the implementer must not change code or git history.
  if (cur.agent !== "implementer") {
    const v = scopeViolation(cur, cfg);
    if (v) {
      state.current = null;
      if (t) t.stages[cur.agent] = "pending";
      state.pending = { type: "violation", ticket: cur.ticket, file: cur.report,
        reason: `The ${cur.agent} broke its permissions: ${v}. Inspect and revert those changes, then run \`resume\` (the ${cur.agent} runs again).` };
      event(state, { type: "violation", ...base, summary: v });
      return out("VIOLATION", v);
    }
  }
  state.current = null;

  // Teaching: collect every LESSON in a review, routed to the agent whose work was judged.
  if (REVIEWERS.includes(cur.agent) || isTestStage(cur.agent)) {
    const target = isTestStage(cur.agent) ? "implementer"
      : verdict === "FAIL_TESTS" ? firstStage(t) : verdict === "FAIL_PLAN" ? "planner" : cur.agent === "final-reviewer" ? "planner" : "implementer";
    // a reviewer may address the test stage as test-writer; on a bug ticket that is the diagnoser
    const lessons = extractLessons(text, target).map((l) => ({ ...l, target: l.target === "test-writer" && t ? firstStage(t) : l.target }));
    addLessons(state, lessons, { ticket: cur.ticket, from: cur.agent });
  }

  if (cur.agent === "planner") {
    if (verdict === "QUESTIONS") {
      state.plan.questionRounds++;
      state.pending = { type: "questions", ticket: "plan", file: "factory/questions.md",
        reason: "Planner needs decisions. Show the questions to the human, append their answers to factory/answers.md, then run `resume`." };
      event(state, { type: "questions", ...base });
    } else if (verdict === "PASS") {
      importTickets(state);
      const rev = state.planRevision;
      state.planRevision = null;
      event(state, { type: "pass", ...base });
      if (!state.tickets.length) {
        state.pending = { type: "blocked", ticket: "plan", file: cur.report, reason: "Planner returned PASS but wrote no tickets in factory/tickets/." };
      } else if (rev && rev.ticket !== "final") { // the plan changed: rebuild the ticket from its tests
        const rt = state.tickets.find((x) => x.id === rev.ticket);
        if (rt) { rt.stage = firstStage(rt); rt.locked = null; rt.reworkFrom = rev.report; stagesFor(rt).forEach((a) => (rt.stages[a] = "pending")); }
      }
      if (state.phase === "planning" || state.phase === "final") state.phase = "building";
      state.plan.status = "done";
    } else {
      state.pending = { type: "blocked", ticket: cur.ticket, file: cur.report, reason: "Planner failed to produce a plan." };
      event(state, { type: "fail", ...base });
    }
    return out(verdict, summary);
  }

  if (cur.agent === "retro") return recordRetro(state, cfg, cur, verdict, summary, text, base, out);

  if (cur.agent === "final-reviewer") {
    if (verdict === "PASS") {
      event(state, { type: "pass", ...base });
      // a round of bug fixes after delivery is re-checked by the final review, without another retro
      if (cfg.retro?.enabled === false || state.bugRound) { state.phase = "finished"; state.bugRound = false; event(state, { type: "finished", ticket: "final" }); }
      else { state.phase = "retro"; state.retro = { status: "pending", proposals: [], accepted: [] }; }
    }
    else if (state.finalRounds >= (cfg.maxFinalRounds ?? 2)) {
      state.pending = { type: "blocked", ticket: "final", file: cur.report, reason: "Final review still failing after the allowed rounds." };
      event(state, { type: "fail", ...base });
    } else { state.planRevision = { ticket: "final", report: cur.report }; event(state, { type: "fail_plan", ...base }); }
    return out(verdict, summary);
  }

  // ----- ticket stages -----
  if (isTestStage(cur.agent)) {
    const me = cur.agent;
    t.disputeFrom = null;
    if (verdict === "NEED_INFO") { // the diagnoser could not build a feedback loop: the human must provide something
      state.pending = { type: "bug_info", ticket: t.id, file: cur.report,
        reason: `The diagnoser cannot reproduce bug ${t.id} without more from the human. Show them what its report asks for, pass their reply with \`answer\`, then run \`resume\`.` };
      t.stages[me] = "pending";
      event(state, { type: "bug_info", ...base });
      return out(verdict, summary);
    }
    if (verdict === "SKIP") {
      t.testsSkipped = true; t.locked = {}; t.stages[me] = "pass"; t.stage = "implementer";
      event(state, { type: "pass", ...base, summary: `${me === "diagnoser" ? "بلا اختبار انحدار (لا يوجد seam صحيح)" : "بدون اختبارات قبول"}: ${summary}` });
      return out(verdict, summary);
    }
    t.testsSkipped = false;
    event(state, { type: "pass", ...base });
    const res = testGate(t, cfg, text);
    recordGate(state, t, cfg, "test", res);
    if (res.failed.length) { sendBack(state, t, cfg, me, `factory/reports/${t.id}/test-gate-${t.attempt}.md`, res.failed.join(", "), me); return out("GATE_FAIL", res.failed.join(", ")); }
    t.stages[me] = "pass"; t.stage = "implementer";
    return out(verdict, summary);
  }

  t.stages[cur.agent] = verdict === "PASS" ? "pass" : "fail";
  if (verdict === "PASS") {
    event(state, { type: "pass", ...base });
    if (cur.agent === "implementer") {
      const res = implementerGate(t, cur, cfg);
      const file = recordGate(state, t, cfg, "impl", res);
      if (res.failed.length) { sendBack(state, t, cfg, "gate", file, res.failed.join(", ")); return out("GATE_FAIL", res.failed.join(", ")); }
    }
    if (cur.agent === "reviewer" && cfg.gates?.recheckBeforeDone !== false) {
      const checks = runChecks(cfg);
      const cmd = acceptanceCmd(cfg, t);
      if (cmd && t.locked && Object.keys(t.locked).length) checks.unshift(runCmd("acceptance", cmd, cfg));
      const res = { g: { checks: checks.length ? (checks.every((c) => c.ok) ? "pass" : "fail") : "skipped" }, checks };
      res.failed = res.g.checks === "fail" ? ["checks"] : [];
      const file = recordGate(state, t, cfg, "final", res);
      if (res.failed.length) { sendBack(state, t, cfg, "gate", file, "checks"); return out("GATE_FAIL", "checks"); }
    }
    const pipe = pipelineFor(t), i = pipe.indexOf(cur.agent);
    if (i === pipe.length - 1) { t.status = "done"; t.finishedAt = now(); t.reworkFrom = null; t.lastRejection = null; event(state, { type: "done", ticket: t.id }); }
    else t.stage = pipe[i + 1];
  } else if (verdict === "FAIL_PLAN") {
    event(state, { type: "fail_plan", ...base });
    t.lastRejection = { agent: cur.agent, report: cur.report };
    state.planRevision = { ticket: t.id, report: cur.report };
  } else if (verdict === "FAIL_TESTS") {
    event(state, { type: "fail_tests", ...base });
    sendBack(state, t, cfg, cur.agent, cur.report, summary, "test-writer");
  } else if (verdict === "DISPUTE") {
    event(state, { type: "dispute", ...base });
    t.disputeFrom = cur.report;
    sendBack(state, t, cfg, "implementer", cur.report, summary, "test-writer");
    t.stages.implementer = "pending";
  } else {
    event(state, { type: "fail", ...base });
    sendBack(state, t, cfg, cur.agent, cur.report, summary); // every other failure goes back to the implementer
  }
  return out(verdict, summary);
}

// ---------- resume ----------
function resume(ticketId, how) {
  const state = loadState();
  const p = state.pending;
  if (!p) { console.log("Nothing pending."); return; }
  if (ticketId && how) {
    const t = state.tickets.find((x) => x.id === ticketId.padStart(2, "0"));
    if (!t) { console.error("Unknown ticket"); process.exit(1); }
    if (how === "skip") t.status = "skipped";
    else { t.status = "active"; t.attempt = 1; t.stage = t.locked ? "implementer" : firstStage(t); stagesFor(t).forEach((a) => (t.stages[a] = "pending")); }
  }
  if (p.ticket === "final") state.finalRounds = 0;
  event(state, { type: "human", ticket: p.ticket, summary: how ? `${how}` : "answered" });
  state.pending = null;
  save(state);
  console.log("Resumed. Run `next`.");
}

// ---------- status / build ----------
function status() {
  const s = loadState();
  const done = s.tickets.filter((t) => t.status === "done").length;
  console.log(`${s.project} · phase ${s.phase} · tickets ${done}/${s.tickets.length}`);
  for (const t of s.tickets) console.log(`  ${t.id} [${t.status}] ${t.feature ?? "-"} ${t.title} · stage ${t.stage} · attempt ${t.attempt}`);
  if (s.current) console.log(`running: ${s.current.agent} on ${s.current.ticket}`);
  if (s.pending) console.log(`WAITING ON HUMAN: ${s.pending.reason}`);
}

function build(state = readJSON(P("state.json"), null)) {
  if (!state) return;
  const usage = readJSON(P("usage.json"), { runs: {}, main: null });
  const { snap, ...current } = state.current ?? {};
  const skills = { lock: readJSON(P("skills.lock.json"), null), status: readJSON(P("skills-status.json"), null) };
  const lessons = readJSON(LESSONS, {});
  const retroHistory = readJSON(RETRO_HISTORY, []);
  const data = { generatedAt: now(), config: config(), state: { ...state, current: state.current ? current : null }, usage, skills, lessons, retroHistory };
  fs.writeFileSync(P("data.js"), `window.FACTORY = ${JSON.stringify(data)};\n`);
}

function init(name) {
  if (fs.existsSync(P("state.json")) && !process.argv.includes("--force")) {
    console.error("factory/state.json already exists. Add --force to start over."); process.exit(1);
  }
  const state = {
    project: name || path.basename(ROOT), description: "", createdAt: now(),
    phase: config().discovery === "planner" ? "planning" : "discovery",
    plan: { status: "pending", runs: 0, questionRounds: 0 }, features: [],
    tickets: [], current: null, pending: null, planRevision: null, finalBase: null, finalRounds: 0,
    gateStats: { pass: 0, fail: 0 }, events: [],
  };
  fs.writeFileSync(P("log.md"), `# Factory log — ${state.project}\n\n`);
  writeJSON(P("usage.json"), { runs: {}, main: null });
  fs.mkdirSync(P("lessons"), { recursive: true }); // lessons persist across projects on purpose
  if (!fs.existsSync(P("brief.md"))) fs.writeFileSync(P("brief.md"), "# Brief\n\nDescribe what to build here.\n");
  importTickets(state);
  event(state, { type: "init", ticket: "plan", summary: state.project });
  save(state);
  console.log(`Factory initialised for "${state.project}". Write the goal in factory/brief.md, then run \`next\`.`);
}

const [cmd, ...args] = process.argv.slice(2);
({ init: () => init(args.filter((a) => a !== "--force").join(" ")), next, record, brief: writeBrief, answer: writeAnswers, "plan-ready": planReady, bug: () => reportBug(args),
   resume: () => resume(args[0], args[1]), status, build: () => build(), "retro-accept": () => retroAccept(args) }[cmd] ??
  (() => { console.log("usage: factory.mjs init|next|record|resume|status|build|brief|answer|plan-ready|retro-accept|bug"); process.exit(1); }))();
