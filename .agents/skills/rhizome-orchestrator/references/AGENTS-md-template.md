# AGENTS.md Protocol Section — Orchestrator Authoring Template

This is the canonical template you copy into the target project's `AGENTS.md` when bootstrapping a hub (§3 of SKILL.md). Every `<placeholder>` is **project-specific** — replace it with the real value before committing. The skill body is generic on purpose; this section is where the project speaks.

---

## Orchestrator Protocol (<project-name>)

> **Activation:** active while Rhizome <HUB-ISSUE-ID> ("ORCHESTRATOR LOOP") is open.
> On its closure this section retires and normal single-agent workflow applies.

Roles: **orchestrator** (instructs, answers, verifies — skill: `rhizome-orchestrator`)
and **builder** (builds, reports, asks — skill: `rhizome-builder`). Load your skill
at session start.

- Hub: <HUB-ISSUE-ID>. All coordination is comments there.
- Builder tags: `STEP <n>:` after every build step (even small), `STAGE REPORT:`
  at stage end, `QUESTION:` for clarifications and follow-ups.
- Orchestrator tags: stage orders, `ANSWER:`, `OWNER-DECISION:`, `VERIFIED:`.
- The builder never contacts the owner; business/risk/money/irreversible items
  route through the orchestrator.
- Both roles check Rhizome intermittently; silence never means approval.
- Verification rule: a stage advances only after three-pillar verification
  (repo, CI on the exact head SHA, and <LIVE-SURFACE-DEFINITION — e.g. `/health`
  version must match master tip; "healthy" is not "current">).
- Project standing rules: <PER-PROJECT NON-NEGOTIABLES — secrets, licensing /
  clean-room constraints, deploy quirks, commit format, migration discipline>.

---

## How to use this file

1. Copy the block above into the target project's `AGENTS.md` under a top-level
   `## Orchestrator Protocol` heading. Keep the surrounding AGENTS.md structure
   intact.
2. Replace every `<placeholder>` with the project's specifics:
   - `<project-name>` — short, human-readable project identifier.
   - `<HUB-ISSUE-ID>` — the issue ID you created in §3 step 1 (e.g. `ISSUE-42`,
     or the full issue ULID).
   - `<LIVE-SURFACE-DEFINITION>` — concrete probe the orchestrator runs to
     confirm the deployed version matches the just-verified commit. If the
     project has no live surface (library, docs), say so explicitly:
     `N/A — library project; verification reduces to build-output checks`.
   - `<PER-PROJECT NON-NEGOTIABLES ...>` — anything that cannot be traded off
     without owner sign-off. Keep the list short and concrete.
3. Commit the AGENTS.md change as the **first** action of the orchestrator's
   onboarding — the builder needs it to boot.
4. When the hub closes (§11), update the activation line to read:
   `> **Activation:** retired. Hub <HUB-ISSUE-ID> closed on <date>; this section
   remains for historical context.`
   The clause already self-retires; the line just names reality.

## What this section is NOT

- Not a stage plan. Stage state lives on the hub, not here.
- Not a changelog. Don't edit it to record progress — post on the hub.
- Not a policy doc. Project standing rules belong here; ad-hoc decisions
  belong on the hub as `ANSWER:` / `OWNER-DECISION:`.

Keep this section small and stable — it is the constitution, not the agenda.