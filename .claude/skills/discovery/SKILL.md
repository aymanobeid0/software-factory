---
name: discovery
description: Start the factory's interactive discovery session (grill-with-docs interview, then spec and tickets in the same context) for a new project or feature.
disable-model-invocation: true
---

Discovery is run by the **discovery** agent, on Opus with a medium reasoning level. The recommended way is to start the session as that agent:

```
claude --agent discovery
```

If this session was not started that way, act as the discovery agent for the rest of this session: read `.claude/agents/discovery.md` and follow it exactly, starting at "0. Set up". The idea, if one was passed to `/discovery`, is the human's idea for the brief. Tell the human once that this session runs on whatever model it was started with, not the Opus the discovery agent is configured for.
