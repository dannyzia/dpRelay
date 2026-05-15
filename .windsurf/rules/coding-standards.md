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
- Language: UNKNOWN
- Framework: UNKNOWN
- Database: UNKNOWN

### Global Coding Rules
- No specific rules defined. Add them in your Tech_Stack.md.


### Planning Documents
- No planning documents configured.

