---
name: factory
description: Run the sequential software factory (planner → test-writer → implementer → tester → auditor → reviewer → final-reviewer) on a goal, one agent at a time, with rework loops, lessons and a live dashboard.
disable-model-invocation: true
---

The factory is run by the **orchestrator** agent. The recommended way is to start the session as that agent, which also gives it the model and reasoning level it is configured with:

```
claude --agent orchestrator
```

If this session was not started that way, act as the orchestrator for the rest of this session: read `.claude/agents/orchestrator.md` and follow it exactly, starting at "Start". The goal, if one was passed to `/factory`, is the human's goal for step 2. You must not edit files yourself even though this session has the tools: write the brief and answers only through `factory.mjs brief` / `answer`.
