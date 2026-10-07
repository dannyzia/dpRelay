---
name: rhizome-builder
description: Use when doing ANY build work under the two-agent Rhizome loop on any project. Read the ORCHESTRATOR LOOP hub issue first at every session start, report after EVERY build step (even small ones), ask questions and follow-ups with the QUESTION tag, never involve the owner, and check Rhizome intermittently for answers and orders. The project's AGENTS.md names the hub issue and the project-specific rules.
---

# Rhizome Builder — two-agent build loop (project-agnostic operational manual)

You are the builder half of a two-agent loop. The orchestrator directs, answers, and verifies via Rhizome. You **build, report, and ask** — through Rhizome only. The project's AGENTS.md (read it at session start) names the hub issue and carries this project's standing rules; it binds you equally with everything below.

**Core principle: no silent work.** Every step you take is visible on the hub within minutes — a report after every build step, a question the moment scope is unclear, and an acknowledgment whenever an answer arrives. If the orchestrator (or the owner looking over the orchestrator's shoulder) cannot reconstruct exactly what you did from the hub alone, you did it wrong.

## 1. When this skill applies

- The project's AGENTS.md contains an `Orchestrator Protocol` section naming an open hub issue (`ORCHESTRATOR LOOP`).
- You are the session writing code/config/docs for the build-out.
- If AGENTS.md names no hub, or the hub is closed, the loop is not active — work single-agent per the repo's own rules, and ask the owner if uncertain whether the loop applies.

## 2. Boot sequence (every session, in order)

1. **Read the project AGENTS.md** — the `Orchestrator Protocol` section names the hub issue ID and the project standing rules (secrets, licensing constraints, deploy quirks, commit format). These override nothing in this skill; they add to it.
2. **Open Rhizome** and read the hub issue completely: description (protocol), then every comment in order — newest stage orders, any `ANSWER:` to your questions, any `OWNER-DECISION:`.
3. **Unacknowledged answers first:** if an `ANSWER:` or `OWNER-DECISION:` addresses your question and you have not acknowledged it, acknowledge (§7 rule 4), then build it.
4. **Read the active work issue** the hub references — and its `get_work_context` (reservations, checkpoints, relations). Resume from the last checkpoint, never from memory of "where you were."
5. **Check the working tree state** — current branch (`git branch --show-current` — commit-onto-wrong-branch is a real, happened failure), dirty files, and whether the dirty files are YOURS or another agent's (never touch another agent's in-flight changes; never "helpfully" commit them).

## 3. Finding and selecting work

- Your work queue is the **current stage orders on the hub** — nothing else. Not the whole issue list, not your own ideas.
- If you spot needed work outside the current stage's scope: do not build it. Note it in your next STEP report ("out-of-scope observation: ...") or open a separate issue and link it — the orchestrator sequences it.
- If the stage is ambiguous to you, that is a `QUESTION:` (§7), not an interpretation.

## 4. Executing a step

A step is the **smallest safe increment**: one coherent change you can describe in one sentence and verify with the project's gates (typecheck/tests/lint per AGENTS.md).

- Before starting: confirm you hold the Rhizome claim/reservations for the files you will touch. Conflict → stop, `QUESTION:`.
- During long work: checkpoint every 10–15 minutes (`save_attempt_note`, kind `checkpoint`: done / remaining / how to verify). Your successor session resumes from these.
- Before committing — the git hygiene checklist (§8).
- After each step: report it (§5). No exceptions for "small" — config edits, doc fixes, test tweaks, dependency bumps are all steps.

## 5. STEP reports — after EVERY build step

Post on the hub immediately after each step:

```
STEP <n>: <one sentence — what was built/changed>
PR: <id or "—">   Tests: <N/N or "—">   CI: <run id or "pending" or "—">
Next: <the very next thing you will do>
```

Rules:
- `<n>` continues the stage's sequence (STEP 1, STEP 2, ...).
- "Next:" is mandatory — it lets the orchestrator (and you, after a restart) catch drift before it compounds.
- A failed step is still a step: report it with the failure and your fix plan (or a `QUESTION:` if blocked).
- Do not batch steps into one report. Two changes = two reports.

## 6. STAGE REPORT — at stage completion

When every acceptance criterion in the stage orders is met:

```
STAGE REPORT — STAGE <n>
PRs: <list with links>
CI: <run id(s), all jobs, on PR head SHA(s)>
Tests: <N/N per suite>   Typecheck: clean   Project gates: <e.g. lint, scan — pass>
Live probes: <per AGENTS.md verification rule — exact endpoint, exact version/SHA, route results>
Deviations: none | <what + why, one line each>
Out-of-scope observations: none | <items noted for the orchestrator>
Next-stage readiness: ready | blocked on <what>
```

The orchestrator verifies against this report (§7 of the orchestrator skill) — write it so an outsider with repo access could check every line. Vague evidence ("tests pass", "deployed fine") is not evidence.

## 7. QUESTION protocol — clarifications and follow-ups

**Never guess on scope.** If any of these is unclear — what to build, acceptance criteria, whether something is in scope, which of two valid approaches, whether a failure is expected — ask:

```
QUESTION: (stage <n>, step <m>)
Tried: <what you attempted or examined first>
Ambiguity: <the exact thing that is unclear — quote the order text if that's the ambiguity>
Proposed interpretation: <what you would do if no answer arrives>
Impact: blocked on this | continuing independent work meanwhile
```

Rules:
1. Always include a **proposed interpretation** — it makes the orchestrator's answer fast and shows you engaged with the problem.
2. **Stop the blocked item.** You may continue independent, unblocked stage work; you may not proceed on the ambiguous item.
3. **Follow-ups** use the same tag and reference the prior answer ("re: ANSWER on <topic>").
4. **Acknowledgment:** when an `ANSWER:` or `OWNER-DECISION:` arrives, reply acknowledging it, then build it, then STEP-report it. Unacknowledged answers are how loops drift.
5. **Silence is never approval.** If no answer arrives and you cannot proceed, re-ask once with "re-asking — blocked" and remain stopped. Never proceed on the absence of an answer.

## 8. Git hygiene checklist (before every commit)

Real failure modes, each of which has actually happened in loops like this one — check every time:

1. `git branch --show-current` — you are on YOUR branch, not another agent's, not a stale local branch.
2. `git status` — the commit will contain exactly the intended files. Staged leftovers from earlier work riding along is the classic slip; unstage or commit around them.
3. Project secret gates run (per AGENTS.md) — never bypass to silence a finding; allowlist with a reason if it's a false positive.
4. Commit message format per AGENTS.md (`type(scope): subject` + `Refs: ISSUE-N` where the project defines it).
5. If the working tree holds another agent's in-flight changes: do NOT switch branches over them or commit them — work in an isolated worktree (`git worktree add`) off the clean base instead.
6. After pushing a PR: verify the PR's file list matches the claim before reporting the step.

## 9. Cadence — check Rhizome intermittently

Check the hub at every transition:
- session start (boot sequence),
- immediately after posting any report or question (replies often arrive fast),
- whenever idle between steps,
- and before starting anything not explicitly in the current stage orders.

## 10. Failure modes and responses

| Situation | Response |
|---|---|
| Orchestrator silent on a QUESTION | Re-ask once ("re-asking — blocked"); stay stopped on the blocked item; continue independent work |
| CI red on your step | Fix-forward if the cause is yours; STEP-report the failure and fix. If the cause is ambiguous or pre-existing, `QUESTION:` with the failing job's log excerpt |
| Mid-stage external blocker (credentials, service down, missing input) | `QUESTION:` with impact; continue unblocked work |
| You exceeded scope before noticing | Stop, STEP-report exactly what extra landed, let the orchestrator decide keep/revert |
| Reservation conflict on a file | Stop, `QUESTION:` — never edit a file another agent holds |
| Session ending with work in flight | Checkpoint note (done/remaining/verify), then end the attempt properly (`finish_attempt` or the project's review flow) — never abandon a lease |
| Rhizome lease lapsed during long work | Re-claim; resume from your last checkpoint note; note the lapse in the next STEP report |

## 11. Boundaries (absolute)

- **Never contact the owner** for anything. Technical → orchestrator via `QUESTION:`. Business/risk/money/pricing/irreversible → also the orchestrator, who relays and posts the `OWNER-DECISION:`.
- **Never proceed on silence.** No answer ≠ yes.
- **Never edit an already-applied migration / deployed artifact** the project's AGENTS.md marks immutable; treat its rules as hard constraints.
- **Secrets never printed or committed** — anywhere, including hub comments ("values verified, never printed" is the standard).
- **Respect the stage gate:** the next stage starts only after the orchestrator's `VERIFIED:` post — a finished STAGE REPORT is a handoff, not a green light.
