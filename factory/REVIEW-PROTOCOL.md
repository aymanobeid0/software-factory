# Review protocol

Every agent that judges another agent's work (tester, auditor, reviewer, final-reviewer, and the test-writer when it answers a dispute) follows this protocol. Two duties, equally binding: **be strict**, and **teach**.

## Be strict

- PASS means: you checked everything in your scope and found nothing that must change. Not "mostly fine".
- Every hard problem is a FAIL. No "minor" label on something that breaks a criterion, a documented standard, or the spec.
- Check, don't trust. Run the command, open the file, read the diff. The other agent's report is a claim, not evidence.
- If the ticket was rejected before, open that rejection report first and confirm **every** finding in it is fixed. An unfixed finding is an automatic FAIL, and say it was repeated.
- Stay in your scope. The tester does not review style; the auditor does not judge the spec; the reviewer does not re-run style checks. Overlap wastes tokens and blurs the axes.
- Strict is not hostile: never invent problems to look rigorous. A finding you cannot point to (file, line, command, quote) is not a finding.

## Teach

The agent you reject reads your report and nothing else. Write so it can fix the problem in one go and never make it again.

Each finding uses exactly this shape:

```
### Finding <n>: <short title>
- Where: <file:line, test name, command, or the ticket/spec line quoted>
- Problem: <what is wrong, with the evidence (output, quote)>
- Rule: <the rule it breaks: spec line, ticket criterion, CODING_STANDARDS rule, skill section (e.g. tdd › Anti-patterns)>
- Fix: <the concrete change that resolves it>
- LESSON: <one general sentence the agent can apply on every future ticket>
```

The LESSON line is the teaching. It must be:
- **general**: about the habit, not this file ("Normalise Arabic text before comparing it", not "fix line 42 of search.ts");
- **actionable**: an instruction it can follow ("Run the full test suite before returning PASS");
- **short**: one sentence.

By default a LESSON goes to the agent whose work you reviewed. To address another agent, write `LESSON(<agent>): ...`, for example `LESSON(test-writer): ...` or `LESSON(planner): ...`.

You may add LESSON lines on a PASS too, for judgement calls worth learning (smells, naming). They teach without blocking.

Code collects every LESSON into `factory/lessons/<agent>.md`, which that agent reads before each run. A lesson that comes back again is counted and shown as a repeated mistake, so write the same lesson in the same words when you see the same mistake.
