# Software factory

This project runs a sequential agent factory. Start a project with `claude --agent discovery` (live interview, spec and tickets), then build it with `claude --agent orchestrator`.

- Main session = the `orchestrator` agent (`claude --agent orchestrator`). Agents, one per stage: `.claude/agents/` (discovery, planner, test-writer, diagnoser, implementer, tester, auditor, reviewer, final-reviewer, retro). Bugs: `factory.mjs bug` makes a bug ticket that the diagnoser reproduces and locks with a failing regression test before the implementer fixes it. After the final review, `retro` proposes environment changes in `factory/retro/`; the human accepts them with `factory.mjs retro-accept`. Reviews follow `factory/REVIEW-PROTOCOL.md` (strict, and every finding teaches a LESSON); lessons live in `factory/lessons/`. Models and reasoning levels per agent: `factory/config.json` → `models`, `effort`, `effortEscalation`.
- Routing state machine: `factory/scripts/factory.mjs` (`next`, `record`, `resume`, `status`). Never route by hand.
- Safety: `factory/scripts/guard.mjs` (PreToolUse hook) blocks destructive commands and limits where each agent may write; `factory.mjs record` runs the code gates (commit, clean tree, tests kept, checks, read-only scope). Never bypass either.
- Tracking: `factory/spec.md`, `factory/tickets/`, `factory/reports/<ticket>/<agent>-<attempt>.md`, `factory/log.md`.
- Dashboard: `factory/dashboard.html` (reads `factory/data.js`, regenerated on every step and by the token hook).
- Engineering discipline comes from Matt Pocock's skills in `.claude/skills/` (MIT, see `LICENSE-mattpocock-skills`).
