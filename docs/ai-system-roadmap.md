# AI System Roadmap

> Generated 2026-05-18 — Phase 9 of AI system transformation.

## Current State Assessment

### What Was Built

| Area | Files | Purpose |
|------|-------|---------|
| Agents | 8 in `.claude/agents/` | Specialized agent definitions with explicit responsibilities and boundaries |
| Rules | 12 in `.claude/rules/` | Category-separated engineering rules |
| Workflows | 7 in `.claude/workflows/` | Defined execution order and validation gates |
| Memory | 5 in `.claude/memory/` | Operational learnings, pitfalls, and standards |
| Evaluations | 7 in `/evaluations/` | Quality checklists and drift detection |
| Tools | 6 in `/tools/` | Validation scripts for PRD, routes, schemas, deps, security |
| Analysis | 1 in `/docs/` | Repository and system analysis |

### Weaknesses

1. **Agent Prompts.md (41K tokens)** preserved alongside new system — should be archived
2. **No automated CI pipeline** — validation tools exist but not wired into CI
3. **No Crashlytics integration** (TD-04) — referenced but unimplemented
4. **Tools are standalone** — not integrated into hooks or pre-commit
5. **No agent-to-agent communication protocol**
6. **No coverage analyzer tool** — only percentage targets in rules

## Highest Leverage Improvements

### Short-Term (Next Session)
1. Archive Agent Prompts.md → `docs/archive/` to prevent confusion
2. Wire tools into pre-commit hook — add route-auditor, schema-checker, security-audit
3. Create `scripts/run-all-checks.sh` — single command for all linters, tests, and validators

### Medium-Term (2-3 Sessions)
4. Crashlytics integration — unblock TD-04
5. CI pipeline config — GitHub Actions for PR checks
6. Coverage enforcement tool with >80% threshold
7. Document agent handoff contracts

### Long-Term (Next Quarter)
8. Auto-generated API contracts from functions code
9. Self-validating agents against rules
10. Cross-component integration tests with Firebase emulators

## Prompt Optimization

- Keep all files under 100 lines (current max: ~80 lines)
- No duplicate project context across files — reference CLAUDE.md
- Consistent terminology across all agent, rule, and workflow files
- Update CLAUDE.md to reference the new `.claude/` structure

## Hallucination Reduction

### Built-In
- Code Skeptic agent tasked with hallucination detection
- PRD drift checklist in evaluations/
- Implementation quality checklist with verification items
- Project-specific security review checklist

### Recommended
- Add "verify against filesystem" step — agents must confirm file existence
- API verification — confirm documented endpoints match function exports
- Dependency verification — confirm package versions exist

## Workflow Hardening

- Add enforceable gate checklist sign-off
- Add timing expectations per step
- Document failure modes for gate bypass

## Summary

The system is now modular (45 small files vs 1 monolithic 41K file), includes adversarial review via Code Skeptic, has explicit validation gates in every workflow, is project-specific, and has automated validation tools. Key next step: archive the old Agent Prompts.md and wire tools into CI.
