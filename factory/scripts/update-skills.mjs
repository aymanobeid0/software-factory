#!/usr/bin/env node
// Keeps the factory's copy of Matt Pocock's skills on the latest upstream version, under control:
//   - factory/skills.lock.json pins the upstream commit and a content hash per skill.
//   - `check` fetches upstream, reports updated / new / deprecated skills and local edits. Changes nothing.
//   - `apply` copies updates in. It refuses while a factory project is in progress (never change
//     agent behaviour mid-project) and never overwrites a skill you edited locally unless told to.
//   - every applied update is recorded in factory/skills-changelog.md.
//
// Usage:
//   node factory/scripts/update-skills.mjs check [--quiet]
//   node factory/scripts/update-skills.mjs apply [skill ...] [--force] [--overwrite-local]
//   node factory/scripts/update-skills.mjs track <skill> [--used-by "<who>"]
//   node factory/scripts/update-skills.mjs dismiss [skill ...]   (seen, not used: stop flagging it as new)
//   node factory/scripts/update-skills.mjs pin            (re-pin the lock to the files on disk)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FACTORY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT = path.resolve(FACTORY, "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills");
const LOCK = path.join(FACTORY, "skills.lock.json");
const STATUS = path.join(FACTORY, "skills-status.json");
const HISTORY = path.join(FACTORY, "skills-changelog.md");
const SOURCE = "https://github.com/mattpocock/skills";
const SHIPPED = ["engineering", "productivity"]; // buckets upstream ships as stable skills

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const positional = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !(all[i - 1] ?? "").startsWith("--used-by"));
const readJSON = (f, d) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const writeJSON = (f, d) => fs.writeFileSync(f, JSON.stringify(d, null, 2) + "\n");
const now = () => new Date().toISOString();

// ---------- hashing (line endings normalised so Windows checkouts don't look edited) ----------
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join("/")];
  }).sort();
}
function hashDir(dir) {
  const h = crypto.createHash("sha256");
  for (const f of listFiles(dir)) {
    h.update(f + "\0");
    h.update(fs.readFileSync(path.join(dir, f), "utf8").replace(/\r\n/g, "\n") + "\0");
  }
  return h.digest("hex").slice(0, 16);
}
function copyDir(src, dst) {
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, { recursive: true });
}

// ---------- upstream ----------
function git(cwd, ...a) { return execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString().trim(); }
function fetchUpstream() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "factory-mp-skills-"));
  try { git(os.tmpdir(), "clone", "--quiet", "--depth", "300", SOURCE, dir); }
  catch (e) { fs.rmSync(dir, { recursive: true, force: true }); throw new Error(`cannot reach ${SOURCE}: ${String(e.stderr || e.message).trim()}`); }
  const commit = git(dir, "rev-parse", "--short", "HEAD");
  const commitDate = git(dir, "log", "-1", "--format=%cs");
  const version = readJSON(path.join(dir, "package.json"), {}).version ?? null;
  // every skill upstream, by folder name
  const skills = {};
  for (const bucket of fs.readdirSync(path.join(dir, "skills"))) {
    const b = path.join(dir, "skills", bucket);
    if (!fs.statSync(b).isDirectory()) continue;
    for (const name of fs.readdirSync(b)) {
      const p = path.join(b, name);
      if (!fs.existsSync(path.join(p, "SKILL.md"))) continue;
      const md = fs.readFileSync(path.join(p, "SKILL.md"), "utf8");
      const desc = (md.match(/^description:\s*"?(.+?)"?\s*$/m) || [, ""])[1];
      skills[name] = { bucket, path: `skills/${bucket}/${name}`, abs: p, description: desc, hash: hashDir(p) };
    }
  }
  return { dir, commit, commitDate, version, skills, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
function commitsSince(up, from, p) {
  try { return git(up.dir, "log", "--format=%h %cs %s", `${from}..HEAD`, "--", p).split("\n").filter(Boolean); }
  catch { return ["(history before the pinned commit is not available; compare manually)"]; }
}

// ---------- project-in-progress guard ----------
function projectInProgress() {
  const s = readJSON(path.join(FACTORY, "state.json"), null);
  if (!s) return null;
  if (s.phase === "finished") return null;
  return `project "${s.project}" is in phase "${s.phase}"`;
}

// ---------- commands ----------
function check({ quiet = false } = {}) {
  const lock = readJSON(LOCK, null);
  if (!lock) { console.error("No factory/skills.lock.json. Run: node factory/scripts/update-skills.mjs pin"); process.exit(1); }
  const up = fetchUpstream();
  try {
    const status = { checkedAt: now(), current: { commit: lock.commit, date: lock.commitDate, version: lock.version },
      latest: { commit: up.commit, date: up.commitDate, version: up.version }, updates: [], localEdits: [], missingUpstream: [], newSkills: [] };
    for (const [name, s] of Object.entries(lock.skills)) {
      const local = path.join(SKILLS_DIR, name);
      if (fs.existsSync(local) && hashDir(local) !== s.hash) status.localEdits.push(name);
      const u = up.skills[name];
      if (!u) { status.missingUpstream.push(name); continue; }
      const moved = u.path !== s.path;
      if (u.hash !== s.hash || moved) status.updates.push({ skill: name, from: s.path, to: u.path, moved,
        deprecated: u.bucket === "deprecated", commits: commitsSince(up, lock.commit, u.path).concat(moved ? commitsSince(up, lock.commit, s.path) : []) });
    }
    for (const [name, u] of Object.entries(up.skills))
      if (!lock.skills[name] && SHIPPED.includes(u.bucket) && !(lock.reviewed ?? []).includes(name))
        status.newSkills.push({ skill: name, bucket: u.bucket, description: u.description });
    lock.checkedAt = status.checkedAt; writeJSON(LOCK, lock);
    writeJSON(STATUS, status);
    rebuildDashboard();
    if (!quiet || status.updates.length || status.newSkills.length || status.localEdits.length) printStatus(status);
    return status;
  } finally { up.cleanup(); }
}

function printStatus(s) {
  const same = s.current.commit === s.latest.commit;
  console.log(`Matt Pocock skills · pinned ${s.current.commit} (${s.current.date}, v${s.current.version}) · latest ${s.latest.commit} (${s.latest.date}, v${s.latest.version})${same ? " · up to date" : ""}`);
  for (const u of s.updates) {
    console.log(`  UPDATE  ${u.skill}${u.moved ? ` (moved ${u.from} → ${u.to})` : ""}${u.deprecated ? " [DEPRECATED upstream]" : ""}`);
    for (const c of u.commits.slice(0, 6)) console.log(`          ${c}`);
  }
  for (const n of s.localEdits) console.log(`  LOCAL   ${n} was edited in this project; apply skips it unless --overwrite-local`);
  for (const n of s.missingUpstream) console.log(`  GONE    ${n} no longer exists upstream`);
  for (const n of s.newSkills) console.log(`  NEW     ${n.skill} (${n.bucket}): ${n.description.slice(0, 110)}`);
  if (!s.updates.length && !s.newSkills.length) console.log("  No skill updates.");
  if (s.updates.length) console.log("Apply with: node factory/scripts/update-skills.mjs apply");
}

function apply() {
  const busy = projectInProgress();
  if (busy && !flag("--force")) {
    console.error(`Refusing to update skills: ${busy}. Agents must keep the same rules for the whole project.\nFinish the project first, or pass --force if you accept the change mid-project.`);
    process.exit(1);
  }
  const lock = readJSON(LOCK, null);
  const up = fetchUpstream();
  try {
    const only = positional.length ? new Set(positional) : null;
    const applied = [], skipped = [];
    for (const [name, s] of Object.entries(lock.skills)) {
      if (only && !only.has(name)) continue;
      const u = up.skills[name];
      if (!u) { skipped.push(`${name}: not found upstream`); continue; }
      if (u.hash === s.hash && u.path === s.path) continue;
      const local = path.join(SKILLS_DIR, name);
      if (fs.existsSync(local) && hashDir(local) !== s.hash && !flag("--overwrite-local")) { skipped.push(`${name}: edited locally (use --overwrite-local)`); continue; }
      const commits = commitsSince(up, lock.commit, u.path);
      copyDir(u.abs, local);
      lock.skills[name] = { ...s, path: u.path, hash: u.hash };
      applied.push({ name, commits });
    }
    // The pinned commit moves only when every tracked skill now matches it.
    const allCurrent = Object.entries(lock.skills).every(([n, s]) => up.skills[n] && up.skills[n].hash === s.hash && up.skills[n].path === s.path);
    if (allCurrent) { lock.commit = up.commit; lock.commitDate = up.commitDate; lock.version = up.version; }
    if (applied.length) lock.updatedAt = now();
    copyLicense(up);
    writeJSON(LOCK, lock);
    if (applied.length) {
      const entry = [`## ${now().slice(0, 10)} · ${lock.commit} (v${up.version})`, ""];
      for (const a of applied) { entry.push(`- **${a.name}**`); a.commits.slice(0, 10).forEach((c) => entry.push(`  - ${c}`)); }
      if (skipped.length) entry.push("", "Skipped:", ...skipped.map((x) => `- ${x}`));
      appendHistory(entry.join("\n") + "\n\n");
    }
    console.log(applied.length ? `Updated: ${applied.map((a) => a.name).join(", ")}` : "Nothing to update.");
    skipped.forEach((x) => console.log(`Skipped ${x}`));
  } finally { up.cleanup(); }
  check({ quiet: true });
}

function track() {
  const name = positional[0];
  if (!name) { console.error("usage: track <skill> [--used-by \"<agent or step>\"]"); process.exit(1); }
  const lock = readJSON(LOCK, null);
  if (lock.skills[name]) { console.log(`${name} is already tracked.`); return; }
  const up = fetchUpstream();
  try {
    const u = up.skills[name];
    if (!u) { console.error(`${name} not found upstream.`); process.exit(1); }
    copyDir(u.abs, path.join(SKILLS_DIR, name));
    lock.skills[name] = { path: u.path, hash: u.hash, usedBy: opt("--used-by") ? [opt("--used-by")] : [] };
    lock.reviewed = (lock.reviewed ?? []).filter((n) => n !== name);
    writeJSON(LOCK, lock);
    appendHistory(`## ${now().slice(0, 10)} · tracked **${name}** (${u.path} @ ${up.commit})\n\n`);
    console.log(`Tracking ${name} from ${u.path} @ ${up.commit}.`);
  } finally { up.cleanup(); }
  check({ quiet: true });
}

function pin() {
  const old = readJSON(LOCK, null);
  const up = fetchUpstream();
  try {
    const skills = {};
    for (const name of fs.readdirSync(SKILLS_DIR)) {
      const p = path.join(SKILLS_DIR, name);
      if (!fs.existsSync(path.join(p, "SKILL.md")) || !up.skills[name]) continue; // factory's own skills are not tracked
      skills[name] = { path: up.skills[name].path, hash: hashDir(p), usedBy: old?.skills?.[name]?.usedBy ?? [] };
      if (skills[name].hash !== up.skills[name].hash) console.log(`note: ${name} differs from upstream ${up.commit}`);
    }
    writeJSON(LOCK, { source: SOURCE, commit: up.commit, commitDate: up.commitDate, version: up.version,
      pinnedAt: now(), checkedAt: now(), reviewed: old?.reviewed ?? [], skills });
    console.log(`Pinned ${Object.keys(skills).length} skills to ${up.commit} (${up.commitDate}).`);
  } finally { up.cleanup(); }
}

// Mark upstream skills as seen-and-not-used, so `check` only flags skills that are genuinely new.
function dismiss() {
  const lock = readJSON(LOCK, null);
  const names = positional.length ? positional : (readJSON(STATUS, {}).newSkills ?? []).map((n) => n.skill);
  lock.reviewed = [...new Set([...(lock.reviewed ?? []), ...names])].sort();
  writeJSON(LOCK, lock);
  const st = readJSON(STATUS, null);
  if (st) { st.newSkills = (st.newSkills ?? []).filter((n) => !names.includes(n.skill)); writeJSON(STATUS, st); rebuildDashboard(); }
  console.log(`Marked as reviewed (not used by the factory): ${names.join(", ") || "nothing"}`);
}

function copyLicense(up) { try { fs.copyFileSync(path.join(up.dir, "LICENSE"), path.join(SKILLS_DIR, "LICENSE-mattpocock-skills")); } catch {} }
function appendHistory(text) {
  if (!fs.existsSync(HISTORY)) fs.writeFileSync(HISTORY, "# Skills update history\n\nEvery change to the factory's copy of Matt Pocock's skills.\n\n");
  fs.appendFileSync(HISTORY, text);
}
function rebuildDashboard() {
  try { execFileSync(process.execPath, [path.join(FACTORY, "scripts", "factory.mjs"), "build"], { stdio: "ignore" }); } catch {}
}

try {
  ({ check: () => check({ quiet: flag("--quiet") }), apply, track, dismiss, pin }[args[0]] ??
    (() => { console.log("usage: update-skills.mjs check|apply|track|dismiss|pin"); process.exit(1); }))();
} catch (e) { console.error(`update-skills: ${e.message}`); process.exit(1); }
