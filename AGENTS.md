# Project Rules & AI Instructions (Universal Base)

## 🧠 AI Communication & Workflow (ALWAYS APPLY)
- **Full Context Only:** Provide complete file paths with every edit suggestion (e.g., `### File: src/components/Header.tsx`).
- **No Truncation:** Never use `...` or `// rest of file`. Provide full files or precise search/replace diffs.
- **Error Handling Protocol:**
  1. Identify root cause.
  2. State fix strategy.
  3. Apply change.
- **Preserve Intent:** Do not delete existing comments or code unless they are explicitly tagged `[DEPRECATED]` or are directly conflicting with the requested change.

## ✅ Pre-Response Checklist (Self-Verification)
Before submitting **any** code response, verify the following silently. If any check fails, address it in the response or flag it explicitly:

- [ ] No hardcoded secrets, tokens, or environment-specific values present.
- [ ] No new dependencies added without flagging and justification.
- [ ] No files modified outside the explicit request scope.
- [ ] All new or modified public functions include docblocks.
- [ ] Any condition requiring a flag has been flagged per the Tagging Convention below.

## 🏷️ Tagging Convention (Critical)
When this document instructs you to **"flag"** something, you **must** prefix the relevant output with the following visible warning block before proceeding with any code:

> ⚠️ **FLAG:** [brief reason] — proceeding with [assumption/action] unless told otherwise.

*Example:* `> ⚠️ **FLAG:** This file has no existing tests — proceeding with modification but regression risk is unknown.`

## 🤔 Ambiguity & Clarification Protocol
- **Before large or complex changes:** If a request touches more than 3 files, **or** implies a structural/architectural decision not explicitly specified, state your interpretation and ask for confirmation **before** writing code.
- **When requirements conflict:** Flag the conflict explicitly. Do not silently pick one side. Example: *"You requested X, but the existing code enforces Y. Which should take precedence?"*
- **When information is missing:** Ask **one** targeted question rather than making multiple assumptions. If proceeding without waiting, state the assumption clearly in the response using the tagging convention.

## � Zero Assumptions Policy (ABSOLUTE — overrides all other rules)
- **Never assume anything about the user's context, environment, goals, end users, deployment target, or technical decisions.** If it was not explicitly stated, it is unknown.
- **Ask, don't infer.** When a decision requires context the user has not provided, stop and ask before proceeding.
- **Questions must come with options.** Do not ask an open-ended question alone. Always provide a numbered or lettered list of the most likely answers so the user can pick or correct. Example:
  > *"Who are the end users of this app?*
  > *(a) Developers running it locally*
  > *(b) Non-technical users via a web UI*
  > *(c) Other systems via API*
  > *(d) Other — please describe."*
- **No silent defaults.** Do not fall back to a "reasonable default" when information is missing. Flag the gap and ask.
- **This rule overrides all others.** Speed is not a reason to assume. Building the wrong thing fast is worse than asking one question.

## �🚫 Hard Prohibitions (DO NOT)
- Do **NOT** generate code for files not referenced or implied by the request.
- Do **NOT** rename, move, or restructure files unless explicitly asked.
- Do **NOT** add new dependencies (packages/libraries) without flagging them first and explaining why they are necessary.
- Do **NOT** silently upgrade or change an existing package version in `package.json`, `requirements.txt`, `Cargo.toml`, or `go.mod`.
- Do **NOT** generate database migration files unless explicitly requested. Schema changes must be confirmed before any migration code is written.
- Do **NOT** refactor, clean up, or "improve" code outside the direct scope of the request, even if the existing code is suboptimal. Instead, note it using the tagging convention:
  > ⚠️ **FLAG:** Noticed X could be improved — out of scope for this change.
- Do **NOT** remove `TODO`, `FIXME`, or commented-out debugging code unless explicitly instructed. These are intentional markers.
- Do **NOT** hardcode any value that could change between environments or over time. This includes: URLs, ports, file paths, credentials, API keys, tokens, magic numbers, timeout values, and feature flags. All such values must come from environment variables or a config file. If a value is hardcoded and no config mechanism exists yet, flag it:
  > ⚠️ **FLAG:** Value `X` is hardcoded — should be moved to an environment variable or config file.

## 🧠 AI Honesty & Limitations (Hallucination Guard)
- **Never fabricate APIs:** If unsure whether a method exists in the standard library or a third-party package, state this uncertainty. Do not generate plausible-looking but fictional code.
- **Flag uncertainty:** Prefix uncertain suggestions with `[UNVERIFIED]` when a specific version behavior, API signature, or config key cannot be confirmed from the provided context.
- **Prefer no answer over a wrong one** for security-sensitive code (authentication, cryptography, permissions, payment logic).

## 💅 Code Style & Formatting (Universal)
- **Indentation:** Spaces. (Default: 2 for frontend/web, 4 for backend/systems).
- **Quotes:** Prefer single quotes unless escaping is required.
- **Semicolons:** Include semicolons.
- **Imports Order:** 
  1. Built-in / Standard Library
  2. External Packages
  3. Internal Aliases/Modules
  4. Relative Imports
- **Import Sorting:** Within each group, sort **alphabetically** by module name. Flag if an import does not fit a clear group.
- **Line Endings:** LF (`\n`).

## 🧩 Language-Specific Rules (Apply Only If Detected)

### If TypeScript / JavaScript:
- **Type Safety:** No `any` type. Use `unknown` or proper generics.
- **React:** Keep hooks at component top. Memoize callbacks passed as props.
- **Node.js:** Do not block the event loop. Use async/await for I/O operations.

### If Python:
- **PEP8 Compliance:** `snake_case` for functions/variables, `PascalCase` for classes.
- **Type Hints:** All function signatures must include type hints.
- **Virtual Env:** Assume dependencies are managed in `venv` or `poetry`.

### If PHP (Laravel):
- **Models:** Avoid mass assignment without `$fillable` or `$guarded`.
- **Eloquent:** Use parameterized queries; never raw string concatenation for user input.

### If Go:
- **Error Handling:** Never ignore errors with `_`. Handle or explicitly wrap with context.

### If Rust:
- **Unwrap:** Never use `.unwrap()` in production code. Use `?` or proper `match` handling.

## 📁 Project-Specific Rules
This document defines universal base rules. **Project-specific conventions always take precedence.**
Read the project-specific rules before writing any code:
- **`docs/Plan/13-CONVENTIONS.md`** — naming conventions, language rules, git conventions for this project.
- **`docs/Plan/03-TECH-STACK.md`** — approved dependencies, off-limits patterns, environment targets.
- **`docs/Plan/11-ENV-VARS.md`** — all environment variables and where to get their values.

If any rule in this universal base conflicts with a project-specific rule, the project-specific rule wins.

## 🌍 Environment Awareness
- **Permissive Defaults:** Never set defaults that are safe in development but dangerous in production. This includes:
  - `DEBUG=True` or equivalent
  - `CORS: *` (Allow-Origin wildcard)
  - Plaintext error stack traces exposed to API clients
  - Verbose logging enabled by default
- **Configuration:** If environment-specific behavior is required, use environment variables. **Never** hardcode environment names (e.g., `if (env === 'production')`) in business logic. Use feature flags or configuration objects instead.

## 🏗️ Project Structure Guidance
- **Separation of Concerns:** Application logic should **not** live in the project root directory (e.g., `/src`, `/app`, `/lib`, `/packages` is preferred).
- **Framework Adherence:** Follow the standard directory layout for the detected framework (e.g., `app/` for Next.js, `module/` for NestJS, `project/` for Django). **Do not force a JS framework structure onto a Python/Rails project.**

## 🧪 Testing Principles
- **Coverage Requirement:** New features must include a corresponding unit or integration test.
- **Regression Tests:** Bug fixes must include a test that fails before the fix and passes after.
- **Determinism:** Tests must not rely on `Date.now()`, `Math.random()`, or real network latency without mocking. Tests must be repeatable.
- **Test Meaningfully:** A test that only asserts "function did not throw" is **not sufficient**. Tests must assert on specific output values, side effects, or expected errors.
- **Untested Code Modification:** If modifying a function or module that has **no existing tests**, flag this explicitly. Do not silently edit untested production logic without noting the regression risk.
- **Scope:**
  - **Unit tests:** Pure logic, no I/O.
  - **Integration tests:** Boundaries (Database, API, Filesystem). Use test doubles or in-memory alternatives where possible.

## 🚀 Performance & Scalability
- **Frontend:** Avoid unnecessary re-renders. Use memoization where state changes are frequent.
- **Backend:** Avoid N+1 database queries. Batch requests or use eager loading.
- **Async:** Do not block the event loop (Node) or main thread (Python/Ruby). Use async/await patterns.
- **Caching:** Do **not** add caching layers without flagging it. If caching is proposed, the solution **must** include the invalidation strategy (TTL, cache keys, purge mechanism).

## 🔒 Security & Input Handling (Universal)
- **Trust Boundary:** **Never trust user input.** Always validate, sanitize, and escape data at the system boundary.
- **Secrets:** **NO HARDCODED SECRETS.** Use environment variables (`.env`) for all API keys, DB passwords, and tokens.
- **Cryptography:** Never use `Math.random()` or non-cryptographic PRNGs for security tokens. Use the platform's cryptographic secure module (`crypto` in Node, `secrets` in Python).
- **Logging Privacy:** **Never log secrets, passwords, tokens, or PII** — even partially or redacted.

## 📋 Logging Standards
- **Use Established Logger:** Always use the project's configured logger. Never use `console.log`, `print()`, or `echo` in production paths unless it's a CLI tool specifically designed for stdout.
- **Python Specific:** Use the `logging` module (consistent with global standard).
- **Log Levels:**
  - `error`: Failures requiring immediate attention.
  - `warn`: Recoverable anomalies or deprecation warnings.
  - `info`: Significant state transitions (e.g., "Server started", "User logged in").
  - `debug`: Developer detail; not enabled in production.

## 📚 Documentation Requirements
- **Public API:** All exported/public functions or classes **must** have a descriptive docblock (JSDoc, Docstring, etc.).
- **Complex Logic:** Add an inline comment explaining **Why** (not What) whenever:
  - A non-obvious algorithmic choice is made (e.g., choosing BFS over DFS for memory constraints).
  - A workaround is introduced for a known bug, library limitation, or race condition.
  - Business logic is embedded in a technical layer (e.g., a DB query encodes a specific tax rule).
- **Narration Comments Prohibited:** Do **NOT** add comments that merely restate what the code does line-by-line (e.g., `// loop through users`, `// validate input`, `// return result`). Comments must explain **why**, never **what**.
- **README & Environment Contract:** Update **both** `README.md` **and** `.env.example` if the change introduces new environment variables, setup steps, or dependency installations.

## 🔁 Versioning & Breaking Changes
- **Flag Public Changes:** Flag any change that alters a public interface, exported function signature, or API contract.
- **Mark Breaking:** Do not introduce breaking changes silently. Mark with a `[BREAKING]` inline comment above the change and note it in the commit body.
- **Prefer Additive Changes:** Prefer adding new optional parameters or new methods over modifying existing signatures.

## 📝 Commit Message Standard
- **Format:** `type(scope): subject`
- **Types:** `feat`, `fix`, `docs`, `style`, `refactor`, `test`, `chore`, `perf`
- **Scope:** Use the primary directory or module changed (e.g., `auth`, `api`, `ui`, `db`). If multiple unrelated modules changed, consider suggesting separate commits.
- **Subject Line:** Imperative mood ("add" not "added"), max 72 characters. **No period at end.**
- **Example:** `fix(auth): resolve JWT expiration handling`
- **DO NOT** include "Generated by AI", "Co-authored by bot", or similar text in the commit message.

<!-- Generated by project-flow v1.0.0. Do not edit directly. -->

## Authenticator Project-Specific Instructions

### Tech Stack
- **Web**: React 18 + Vite 5 + TailwindCSS 3 (in `web/`)
- **Backend**: Node.js 20 Cloud Functions for Firebase v2 (in `functions/`)
- **Mobile (Authenticator)**: Kotlin 1.9 + Android Gradle Plugin 8.1, minSdk 26, targetSdk 34 (in `authenticator-app/`)
- **Client Library**: Kotlin SDK for ecommerce/medical apps (in `client/`)
- **Database**: Firebase Realtime Database + Firestore + Firebase Auth
- **Hosting**: Firebase Hosting (`web/dist`)
- **External**: Cloud Run (Firebase Functions v2 URLs in `BuildConfig`)

### Global Coding Rules
- **Universal base rules** (sections above this point) apply across all languages in this repo.
- **Language-specific addenda** below extend the universal base for each language used.

#### TypeScript / JavaScript (Web, Functions)
- **No `any` type.** Use `unknown` + narrowing, or proper generics.
- **No `console.log` in production paths** — use the project's logger (pino/winston) or structured `functions.logger`.
- **Firebase Admin SDK**: never expose service account JSON to the client; use `firebase-admin` only inside Cloud Functions.
- **Cloud Functions**: wrap async handlers in `try/catch`; return structured `{ ok, error, code }` responses; never `throw` from a v2 onRequest handler without the Cloud Error Framework.
- **Firestore/RTDB rules**: every rule change ships with a corresponding test in `firestore.indexes.json` / `database.rules.json` review.

#### Kotlin (Authenticator App, Client Library)
- **No `Log.d` / `Log.v` in committed code** — use `Log.i`, `Log.w`, `Log.e` only (TD-09 mitigation).
- **No `runBlocking` on the main thread** — coroutines on `Dispatchers.IO` for I/O, `Dispatchers.Default` for CPU.
- **No silent exception swallowing** — use `Result<T>` or sealed `Result` types; log at the right level.
- **HMAC comparison**: always `AuthCrypto.constantTimeEquals()` — never `==`/`equals()`.
- **EncryptedSharedPreferences** for any secret (e.g. `AUTHENTICATOR_ENROLLMENT_SECRET`); never compile secrets into `BuildConfig` (ADR-016, TD-13).
- **E.164 normalization** in any phone number path; never trust raw SMS `displayMessageBody` for routing decisions.

### Planning Documents
- `docs/Plan/02-ARCHITECTURE.md` — system architecture and request lifecycle
- `docs/Plan/03-TECH-STACK.md` — approved dependencies
- `docs/Plan/04-ADR.md` — Architecture Decision Records
- `docs/Plan/05-DATA-MODEL.md` — Firebase RTDB schema
- `docs/Plan/06-API.md` — API contract
- `docs/Plan/11-ENV-VARS.md` — environment variables
- `docs/Plan/13-CONVENTIONS.md` — coding conventions
- `docs/Plan/15-RUNBOOK-DEPLOY.md` — deployment runbook
- `docs/Plan/18-KNOWN-ISSUES.md` — active tech debt

---

## 🧠 Rhizome Task Coordination (MANDATORY — read first)

This project uses **rhizome-mcp** as the single source of truth for task tracking. Every coding agent session (Kilo, Claude Code, Codex, etc.) MUST use it. **No work is silent** — if it isn't in Rhizome, it didn't happen.

The server is already installed (`~/.local/bin/rhizome-mcp`, project DB at `~/.local/share/rhizome-mcp/projects/<id>/tasks.db`) and registered in `.kilo/kilo.jsonc`. To use the CLI directly: `npx rhizome-mcp <command>`.

### 0. Boot — orient every session

**First call in every session, before any other tool:**

```
rhizome-mcp open_project  (project_root = absolute repo path)
```

Retain the returned `project_ref` and pass it on every subsequent project-scoped call. The server is stateless; omitting `project_ref` only works if a default project is configured.

Then call `get_project` with that `project_ref` to load project-level instructions, supported values, limits, and the latest event ID. Use `get_changes(since_event_id=N)` to pick up what other sessions did while you were offline.

**Attribution (optional but recommended):** `create_agent_session` once → returns an `agent_session_handle` → pass it to every mutating call → `end_agent_session` at the end. Omitting it is supported; it just records `NULL` attribution.

### 1. Find work — never invent it

Three tools, in order of preference:

| Tool | Use when |
|---|---|
| `get_planning_graph(project_ref)` | You need to see dependencies, blockers, and the entry-point queue. |
| `list_issues(project_ref, is_claimable=true)` | You want a narrow "ready" queue with no graph reasoning. |
| `search(query)` | You're looking for historical knowledge, not current state. |

**Do not** use `list_issues` without filters and pick the first row. **Do not** start work on a blocked issue. **Do not** open two issues for the same intent.

If you have an idea that's not yet in Rhizome, **create an issue first** (`create_issue`) with type `task` or `bug`, acceptance criteria, and labels — then claim it. Don't start coding the idea and file the issue later; that loses the audit trail.

### 2. Load context — every claim

Before `claim_issue`, call `get_work_context(issue_id)` with the **default compact** context, then request only the additional sections you need:

```
get_work_context(issue_id, include=[
  "parent_epic", "relations", "related_issue_summaries",
  "recent_comments", "recent_attempt_notes", "decision_content",
  "attempt_history", "artifacts", "project_instructions",
  "changes_since_previous_attempt", "resource_reservations",
  "reservation_conflicts"
])
```

- Read **active decisions** and **acceptance criteria** as durable constraints. They override your assumptions.
- If the criteria are missing or contradictory, **add a comment or record a decision** before guessing. Do not silently reinterpret scope.
- For an epic, request `parent_epic` and `related_issue_summaries` to see the larger picture.

### 3. Claim — atomic, with a lease

```
claim_issue(issue_id, resources=[...], lease_seconds=1800)
```

- Only claimable states are `ready` and `review`. Never `in_progress` (it's derived, not stored).
- **Keep the returned `attempt_id` and `lease_token` private and reusable** until the attempt ends.
- For long work, call `renew_attempt` before the lease expires. A lost or expired lease is NOT ownership — another session can re-claim.
- **Always pass `resources`** if the work edits specific files, modules, or has logical dependencies (a port, a deploy slot, a feature flag). Reservation is all-or-nothing: a conflict fails the whole claim with `RESOURCE_RESERVATION_CONFLICT` naming the holder and their lease expiry. This prevents two sessions from editing the same code in parallel.

**Resource conventions for this repo:**

| Task type | Reserve |
|---|---|
| Modify `functions/index.js` | `{"kind":"file","path":"functions/index.js"}` |
| Modify `authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/SmsReceiver.kt` | `{"kind":"file","path":"authenticator-app/app/src/main/java/com/digitalpapyrus/authenticator/SmsReceiver.kt"}` |
| Edit Cloud Functions security rules | `{"kind":"file","path":"firestore.rules"}` and/or `{"kind":"file","path":"database.rules.json"}` |
| Deploy to Firebase | `{"kind":"logical","namespace":"deploy","name":"authenticator-15fb7"}` |
| Edit a whole subtree | `{"kind":"directory","path":"functions/"}` |

### 4. Execute — durably, with checkpoints

**Checkpoint cadence:** every 10–15 minutes of active work, or before any risky operation (deploy, schema change, secret rotation).

```
save_attempt_note(
  attempt_id, lease_token,
  kind="checkpoint",   # or "progress" / "finding" / "warning"
  content="""
    Done: ...    ## Self-contained, what is done
    Remaining: ...  ## What is left
    Verify: ...   ## How a successor can check
  """,
  artifacts=[...]    # Optional: commits, branches, files, URLs
)
```

Other rules:

- **Use comments for collaboration** (`add_comment`): "I need clarification on X", "PR is up for review at <url>", "blocked on external dependency".
- **Use decisions for durable choices** (`record_decision`): "We chose HMAC-SHA256 over HMAC-SHA512 for token minting because <reason>". Decisions are supersedable; mark old ones `superseded`.
- **Use `update_issue`** with the current `expected_version`. On `VERSION_CONFLICT`, refetch, reconcile, and retry — never blindly overwrite.
- **Validate multi-issue plans** with `validate_issue_plan` before `apply_issue_plan`. Atomic = all-or-nothing across issues/relations/decisions.

### 5. Review — request, approve, supersede

When work completes, call `finish_attempt(attempt_id, lease_token, outcome="completed", target_issue_status="review" | "done", result_summary, verification, artifacts)`.

Then, **separately**, open a review request:

```
create_review_request(
  issue_id, target_issue_version=N, target_event_id=<from finish_attempt>,
  purposes=["implementation", ...]
)
```

`target_issue_version` and `target_event_id` freeze what the reviewer will verify. Stale approvals are structurally impossible — if the work changes after, the request is invalidated.

To supersede an open request whose target has moved: `replace_review_request(predecessor_request_id, ...)`. Resolved requests cannot be replaced.

Reviewers complete with `finish_attempt(outcome="completed", review_outcome="approved" | "changes_requested" | "blocked")`. `changes_requested` returns the issue to `ready` and records follow-up work; a re-review needs a fresh `create_review_request` against the new target.

### 6. Handoff — never leave an attempt active

**Every attempt MUST end with `finish_attempt` — exactly once.** No silent abandonment, no leaving the lease to expire because the agent is stopping.

Outcomes:

| Outcome | Use |
|---|---|
| `completed` | Work done. Set `target_issue_status` to `review` (default) or `done` per project policy. |
| `failed` | Could not complete. Provide `failure_reason_code` and `reason_details`. |
| `interrupted` | Handing off to another session or stopping mid-task. Use `interruption_reason_code: handoff` and include `next_steps`. |
| `blocked` | External blocker. Provide `blocked_reason`. |

`finish_attempt` requires `attempt_id` + `lease_token` + `outcome` + `result_summary` + `acknowledged_changes` (the issue version and event ID you last saw). Returns the new `latest_event_id` and `target_issue_version` for the review request.

### 7. The "I died mid-task" guarantee

This is the whole point of Rhizome. If a session crashes, times out, or hits a context limit:

- The lease expires (default 60 min, renewable up to 60 min).
- The issue becomes claimable again.
- A new session claims it and calls `get_work_context(include=["changes_since_previous_attempt"])`.
- The new session reads the last `checkpoint` note and resumes.

**This works only if checkpoints are written.** If you do checkpoint-less work for 90 minutes and die, your successor has nothing to resume from. Treat `save_attempt_note(kind="checkpoint")` as a 10-minute alarm.

---

### Quick reference card (paste into your session if needed)

```
BOOT:
  open_project(project_root=<abs>)
  get_project(project_ref)

FIND:
  get_planning_graph(project_ref)
  list_issues(project_ref, is_claimable=true)

LOAD:
  get_work_context(issue_id, include=[...])

CLAIM:
  claim_issue(issue_id, resources=[...], lease_seconds=1800)
  -> keeps attempt_id, lease_token private

EXECUTE:
  save_attempt_note(attempt_id, lease_token, kind="checkpoint", content=...)
  add_comment(issue_id, content=...)
  record_decision(issue_id, title, summary, content, status="active")

FINISH:
  finish_attempt(attempt_id, lease_token, outcome="completed", target_issue_status="review", ...)
  create_review_request(issue_id, target_issue_version, target_event_id, purposes=[...])
```

---

## 🌿 House style for this project (additive to universal base)

- **Open a Rhizome issue before touching code** for any non-trivial change (>1 file, >10 lines, or anything that ships). The issue title becomes the commit subject.
- **Cross-reference commits to issues** in the commit body: `Refs: ISSUE-12` or `Closes: ISSUE-12`.
- **Never edit a file another agent has reserved.** Run `get_work_context(include=["resource_reservations"])` first if unsure.
- **End every session with `finish_attempt`** — no exceptions, no "I'll do it next time."
- **If you discover out-of-scope work**, create a separate Rhizome issue and link it (`blocks`/`related_to`), don't expand the current one.
- **Pre-merge gate**: lint + tests + Rhizome-linked commits. The CI run-script is `bash scripts/run-all-checks.sh`.

