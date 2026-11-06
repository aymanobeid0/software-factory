---
name: bug
description: Report a bug to the factory. It becomes a bug ticket that the diagnoser reproduces and locks down with a failing regression test before the implementer fixes it. Works on an existing project with no plan (bug fixes only).
disable-model-invocation: true
---

Report the bug the human described (the argument to `/bug`, or ask for it in one question: what happened, what they expected, and how to make it happen).

1. If `factory/state.json` does not exist (an existing project, bug fixes only), set the factory up first:
   `node factory/scripts/factory.mjs brief <<'EOF'` + `Bug fixes` + `EOF`, then `node factory/scripts/factory.mjs init "<project name>"`.
2. File the bug in the human's words, with any error output they pasted:
   `node factory/scripts/factory.mjs bug <<'EOF'` + the report + `EOF`
   Add `--feature F<n>` after `bug` when the human says which feature it belongs to.
3. Say which ticket number it became, and that the orchestrator runs it next (`claude --agent orchestrator`, or continue the loop if this session is the orchestrator).
