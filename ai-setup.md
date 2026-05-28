Analyze this repository and transform it into a production-grade AI-assisted engineering environment with structured agents, rules, tools, workflows, validation systems, and long-term memory.

The attached Agent Prompts.md file is the foundational governance system for this repository.

Do NOT blindly replace it.

Your job is to:
- analyze it
- identify weaknesses
- reduce redundancy
- improve specialization
- improve workflow reliability
- improve skepticism and validation
- improve maintainability
- improve scalability
- improve tool architecture
- improve PRD enforcement
- improve engineering discipline

The goal is NOT autonomous AI theater.

The goal is a practical, production-grade multi-agent engineering system.

---

PRIMARY OBJECTIVES

This system must:
- improve implementation quality
- reduce hallucinations
- reduce fake completeness
- reduce regression risk
- enforce PRD alignment
- enforce architecture consistency
- enforce validation discipline
- support scalable development workflows
- support long-term maintainability

The system must prioritize:
- explicitness
- determinism
- modularity
- traceability
- validation
- adversarial review

Avoid:
- prompt bloat
- vague responsibilities
- overlapping agents
- unnecessary abstractions
- recursive complexity
- autonomous AGI behavior
- overengineered frameworks

Favor:
- simple explicit systems
- composable tools
- constrained workflows
- isolated responsibilities

---

PHASE 1 — REPOSITORY ANALYSIS

First:
- analyze the repository structure
- analyze the existing Agent Prompts.md
- analyze current workflows
- analyze architecture
- analyze stack and dependencies
- identify missing engineering controls
- identify weak review processes
- identify workflow gaps
- identify hallucination risks
- identify missing validation systems
- identify scalability risks

Then generate:
- architecture assessment
- workflow assessment
- prompt architecture assessment
- risk assessment
- recommended improvements

Store findings in:
/docs/ai-system-analysis.md

---

PHASE 2 — AGENT SYSTEM DESIGN

Design a modular multi-agent system.

Create these agents:

1. Orchestrator Agent
Responsibilities:
- task decomposition
- workflow sequencing
- delegation
- scope control
- dependency coordination
- preventing uncontrolled implementation

2. Architect Agent
Responsibilities:
- system design
- architecture review
- schema review
- API contract review
- scalability review
- infrastructure consistency
- dependency evaluation

3. Builder Agent
Responsibilities:
- feature implementation
- refactoring
- migrations
- API implementation
- UI implementation
- infrastructure implementation

4. Code Skeptic Agent
Responsibilities:
- challenge assumptions
- detect hallucinations
- compare implementation against PRD
- detect missing edge cases
- detect fake completeness
- detect broken abstractions
- verify actual implementation quality
- verify rollback safety
- reject weak implementations

This is a critical agent.
It must behave adversarially toward implementation claims.

5. Security Agent
Responsibilities:
- authentication review
- authorization review
- OWASP checks
- secrets handling
- environment security
- permission boundary validation
- API exposure analysis

6. Testing Agent
Responsibilities:
- test generation
- regression validation
- edge case validation
- integration testing review
- missing coverage detection
- flaky test detection

7. Documentation Agent
Responsibilities:
- architecture documentation
- changelog generation
- ADR maintenance
- implementation summaries
- workflow documentation
- onboarding docs

8. DevOps Agent
Responsibilities:
- CI/CD validation
- environment validation
- deployment safety
- migration safety
- infrastructure consistency
- observability recommendations

---

AGENT REQUIREMENTS

Each agent must contain:
- explicit responsibilities
- explicit forbidden behaviors
- scope boundaries
- required validations
- escalation conditions
- workflow position
- output expectations
- review requirements
- failure conditions

No agent may self-approve its own work.

---

PHASE 3 — RULE SYSTEM

Create a modular rule system.

Do NOT create one massive prompt file.

Create modular files:

/.claude/core/
/.claude/agents/
/.claude/rules/
/.claude/workflows/
/.claude/memory/

Rules must be separated by category.

Required rule categories:

- architecture-rules.md
- backend-rules.md
- frontend-rules.md
- database-rules.md
- api-rules.md
- testing-rules.md
- security-rules.md
- migration-rules.md
- documentation-rules.md
- prd-rules.md
- observability-rules.md
- ai-agent-rules.md

Rules must enforce:
- no fake implementations
- no placeholder logic
- no silent assumptions
- mandatory validation
- mandatory error handling
- API consistency
- migration safety
- logging requirements
- test requirements
- PRD alignment
- rollback awareness
- dependency hygiene

---

PHASE 4 — TOOLING SYSTEM

Create reusable local tools/scripts for:

- PRD validation
- route auditing
- schema consistency checks
- dead code detection
- dependency analysis
- API contract validation
- environment validation
- migration review
- security auditing
- unused env detection
- logging verification
- test coverage analysis

Preferred languages:
- Python
- TypeScript
- shell scripts

Create:
/tools/
/evaluations/
/scripts/

All tools must:
- have clear purpose
- have explicit inputs/outputs
- be composable
- avoid unnecessary complexity

---

PHASE 5 — MEMORY SYSTEM

Create structured project memory.

Generate:
/.claude/memory/

Include:
- architecture decisions
- implementation lessons
- known pitfalls
- recurring bug patterns
- anti-patterns
- coding standards
- workflow lessons
- incident learnings

This memory must improve future agent performance.

Avoid generic documentation.

Make memory operational and actionable.

---

PHASE 6 — WORKFLOW DESIGN

Create explicit workflows.

Required workflows:
- feature workflow
- bugfix workflow
- migration workflow
- release workflow
- hotfix workflow
- PR review workflow
- security review workflow

All workflows must define:
- execution order
- validation gates
- required reviews
- escalation paths
- rollback requirements
- approval conditions

Mandatory workflow:

Architect Review
→ Builder Implementation
→ Skeptic Review
→ Security Review
→ Testing Validation
→ Final Approval

No bypassing validation stages.

---

PHASE 7 — EVALUATION SYSTEM

Create evaluation checklists and quality gates.

Required:
- hallucination-checklist.md
- prd-drift-checklist.md
- migration-risk-checklist.md
- deployment-checklist.md
- architecture-review-checklist.md
- security-review-checklist.md
- implementation-quality-checklist.md

The system must actively detect:
- fake completion
- shallow implementations
- hidden assumptions
- missing validations
- architectural inconsistency
- regression risks

---

PHASE 8 — REPOSITORY RESTRUCTURING

Create a clean AI system structure:

/.claude
  /core
  /agents
  /rules
  /workflows
  /memory

/tools

/scripts

/evaluations

/docs

/plans

Preserve compatibility with the existing repository structure.

Do NOT destructively reorganize application code.

---

PHASE 9 — IMPROVEMENT STRATEGY

Generate:
/docs/ai-system-roadmap.md

Include:
- weaknesses in current system
- highest leverage improvements
- long-term scaling recommendations
- prompt optimization recommendations
- context management recommendations
- hallucination reduction strategies
- workflow hardening recommendations

---

IMPORTANT CONSTRAINTS

Do NOT:
- create fake enterprise abstractions
- create unnecessary frameworks
- generate meaningless boilerplate
- create recursive agent systems
- invent AGI behavior
- create autonomous deployment systems
- create uncontrolled self-modification systems

Prioritize:
- reliability
- clarity
- modularity
- maintainability
- observability
- engineering discipline

---

FINAL OUTPUT REQUIREMENTS

Generate:
- modular agent files
- modular rule files
- workflow files
- evaluation checklists
- local tooling
- architecture docs
- governance docs
- memory structures
- repository recommendations

Before modifying major project structures:
- explain reasoning
- identify tradeoffs
- identify risks

If existing project patterns conflict with best practices:
- document the conflict
- explain the tradeoff
- avoid silently propagating bad patterns

The final system should feel like:
- a disciplined engineering operating system
- not a chaotic collection of prompts.