# Documentation Guidelines & Governance

This is the binding policy for creating, updating, and retiring documentation
under `docs/`. Operational enforcement directives additionally live in the local
agent rules (`.agents/rules/docs-governance.md`) and take precedence during
execution sessions.

---

## 1. Single Source of Truth Rule

**The source code and its tests are the sole authority.** When any document
contradicts the code, the document is wrong by definition and must be corrected
— never the reverse. Every factual claim in a living document must be traceable
to a source file, route, migration, or test.

---

## 2. Directory Layout & Nested Subdirectories

| Folder | Content & Scope | Lifecycle & Modification Bounds |
| :--- | :--- | :--- |
| `docs/` (root) | `README.md` (master index), `DOCUMENTATION_GUIDELINES.md`, `CHANGELOG.md`, `TECHNICAL_DEBT_REGISTER.md` | Living root registers — must track repository structural state |
| `architecture/` | Authoritative system specifications, subsystem designs, and Architectural Decision Records (ADRs) | **LIVING SPEC & ADR REGISTRY:** Mandatory updates when module architectures, data flows, or foundational ADRs co-evolve with the codebase |
| `reference/` | Living API references, client hooks, and testing isolation contracts (`sync-api.md`, `ui-streaming-readiness.md`, `test-database-isolation.md`) | **LIVING CONTRACT:** Mandatory updates on endpoint, schema, status code, or isolation rule changes |
| `specs/` | Design blueprints and technical requirement specifications (`ai-key-rotation-and-resilience.md`, `offline-sync-blueprint.md`, `ui-streaming-requirements.md`) | **DESIGN BLUEPRINT:** Updated ahead of major redesigns; never used for post-implementation logs |
| `guides/` | Operational developer guides organized by domain (`billing/`, `editor/`, `ai/`) | **LIVING GUIDE:** Updated to keep developer onboarding and operational steps reproducible |
| `Plans/` | **Tracked Execution Plans (English):** Official roadmaps and technical execution plans tracked in Git for active milestones | **TRACKED PLANS:** Living during execution, moved to `records/plans/` once closed |
| `.Plans/` | **Internal Planning Incubator (Arabic):** Untracked in Git (`.gitignore`); workspace for drafting, evaluating, and incubating future candidate roadmaps in Arabic before adoption | **INTERNAL INCUBATOR:** Freely mutable draft workspace; untracked in Git |
| `records/` | Engineering records, incident post-mortems, and official milestone closures | **PERMANENT HISTORY (Append-Only):** Never rewritten retroactively |
| `records/incidents/` | Post-mortem root-cause analyses and remediation designs (`test-database-safety.md`) | Permanent incident record |
| `records/audits/` | Architectural verification audit closure records (`W10-Final-Closure-Round.md`) | Permanent audit record |
| `records/closures/` | Phase closure dossiers organized by milestone bundles | Historical milestone closures |
| `records/plans/` | Completed historical execution plans moved after milestone closure | Completed historical plans |
| `records/archive/` | Retired historical designs, superseded specs, legacy baselines, and deprecated snapshots preserved read-only with archival banners | **IMMUTABLE ARCHIVE:** Strictly read-only historical preservation |

---

## 3. Permissible Modification Boundaries Matrix

| Directory / Target | Classification | Permitted Modifications | Strict Prohibitions |
| :--- | :--- | :--- | :--- |
| `docs/architecture/` | `LIVING SPEC & ADR REGISTRY` | Updating architectural specifications, sequence flows, component interactions, state machines, and ADRs to co-evolve directly with active code. | Allowing architectural documentation or ADRs to drift from or contradict active code. |
| `docs/reference/` | `LIVING CONTRACT` | Updating endpoint schemas, status codes, query parameters, hook interfaces, and isolation guards. | Dumping milestone closure reports or historical logs (which belong in `records/closures/`). |
| `docs/guides/` | `LIVING GUIDE` | Updating setup sequences, configuration steps, and operational workflows. | Documenting unverified, non-reproducible manual instructions. |
| `docs/specs/` | `DESIGN BLUEPRINT` | Updating technical requirements prior to major implementation work. | Treating specs as operational work logs. |
| `docs/Plans/` (or `docs/plans/`) | `ACTIVE PLANS EXCLUSIVE` | Hosting and maintaining the active milestone execution roadmap currently undergoing implementation. | Accumulating completed historical plans (must move to `records/plans/`), or storing abandoned drafts. |
| `docs/.Plans/` | `INTERNAL INCUBATOR` | Drafting, incubating, and evaluating future candidate plans in Arabic. | Tracking in Git (must remain in `.gitignore`), or treating as approved plans. |
| `docs/records/` | `PERMANENT HISTORY` | Appending new incident reports, audits, phase closures, completed plans, or archiving deprecated files with banners. | Editing past test figures, rewriting historical session narratives, or deleting past records. |
| `docs/records/plans/` | `COMPLETED PLANS HISTORY` | Archiving fully executed, verified plans after milestone closure. Preserving historical execution roadmaps. | Storing active execution plans currently undergoing implementation, or storing abandoned drafts. |
| `docs/records/archive/` | `DEPRECATED & ABANDONED ARCHIVE` | Archiving retired historical baselines, abandoned specs, and superseded designs read-only with point-in-time archival banners. | Modifying archived historical contents or storing active execution plans. |
| `src/**` | `CODE EXCLUSIVE` | TypeScript source and test files only. | **Strictly prohibited:** Creating or keeping any `README.md` or markdown files in `src/`. |

---

## 4. Operational Trigger-Action Guide (When to Do What)

```mermaid
graph TD
    Trigger["Engineering Event"] --> Branch{"Event Classification"}
    Branch -- "Code / API / Architecture Change" --> A1["Update LIVING docs:<br/>architecture/, reference/, or guides/"]
    Branch -- "Architectural Decision / ADR Update" --> A2["Record or supersede ADR in<br/>docs/architecture/"]
    Branch -- "Milestone / Phase Closed" --> A3["Append closure dossier to records/closures/<bundle>/<br/>Move completed plan to records/plans/"]
    Branch -- "Component / Baseline Retired or Replaced" --> A6["Move retired doc/baseline to records/archive/ with banner"]
    Branch -- "Incident / Security Failure" --> A4["Append post-mortem to records/incidents/"]
    Branch -- "Architectural Audit Completed" --> A5["Append closure report to records/audits/"]
    Branch -- "Candidate Feature Proposal" --> A7["Draft proposal in Arabic inside docs/.Plans/"]
    Branch -- "Candidate Plan Adopted" --> A8["Promote to docs/Plans/ in rigorous English"]
```

### Operational Scenarios:
1. **Source Code, Architecture, or Interface Modification:**
   - Immediately trace and update the corresponding living document in `architecture/` (for structural, data-flow, or ADR changes), `reference/` (for API, hook, or schema contracts), or `guides/` (for setup or developer usage).
2. **Architectural Decision or ADR Evolution:**
   - Record or update the corresponding Architectural Decision Record (ADR) and trade-off matrix inside `docs/architecture/` so that architectural specifications co-evolve directly with the active codebase.
3. **Milestone or Phase Completion:**
   - Compile a closure dossier and save it in the appropriate bundle under `docs/records/closures/<bundle>/`. Move the completed execution plan from `docs/Plans/` to `docs/records/plans/`.
4. **Production Incident or Concurrency Failure:**
   - Author a root-cause forensic report and remediation design in `docs/records/incidents/`.
5. **Architectural Verification Audit:**
   - Document the comprehensive audit results in `docs/records/audits/`.
6. **Component or Historical Baseline Retirement:**
   - Move obsolete, abandoned, or superseded documents and historical baselines to `docs/records/archive/` and prepend a point-in-time archival banner directing readers to the active replacement in `docs/architecture/`. Preserve historical records read-only rather than deleting them.
7. **Future Feature Incubation:**
   - Create and iterate on candidate proposals in Arabic inside `docs/.Plans/`. Keep the directory untracked in `.gitignore`.
8. **Plan Adoption for Execution:**
   - Translate, synthesize, and promote the plan into a formal English execution plan in `docs/Plans/`.

---

## 5. Architectural Decisions, Trade-offs & Migration Triggers

Any architectural choice involving trade-offs, alternative libraries, or deferred complexity must be formally documented within one of three designated tiers:

```mermaid
graph TD
    Trigger["Documenting an Architectural Decision / Trade-off"] --> Scope{"Scope & Context"}
    Scope -- "System ADR or subsystem design with migration condition" --> L1["docs/architecture/<br/>Authoritative Living Spec & ADR Registry"]
    Scope -- "Conscious technical debt or deferred infra" --> L2["docs/TECHNICAL_DEBT_REGISTER.md<br/>Registered TD item with Revisit Trigger"]
    Scope -- "Preliminary exploratory research" --> L3["docs/specs/ (English spec)<br/>or docs/.Plans/ (Arabic incubator)"]
```

### Three-Tier Trade-off Classification Matrix

| Tier | Decision Classification | Target Location | Required Content & Invariants | Codebase Precedents |
| :--- | :--- | :--- | :--- | :--- |
| **Tier 1: Living Architecture & ADR Registry** | Selecting or replacing a core architecture, library, protocol, or state machine, and specifying the boundary condition for migrating away from it. | `docs/architecture/` | Must include:<br>• Formal ADR entry or `## Architectural Decisions & Trade-offs`<br>• `## Alternative Architectures & Migration Triggers`<br>Specifying the chosen architecture, discarded options, trade-off matrix, and the explicit **Migration Trigger**. | • Choosing **Diff3** over **CRDTs (Yjs)**: Diff3 is optimal for single-user multi-device sync; trigger to migrate to CRDTs is multi-user simultaneous real-time collaboration.<br>• Choosing **CodeMirror 6** over **Monaco/TipTap**.<br>• Consolidating storage in **Neon PostgreSQL + IndexedDB** to support zero-knowledge encryption. |
| **Tier 2: Accepted Debt & Deferred Decisions** | Pragmatic compromises accepting performance constraints, operational limitations, or deferred infrastructure to optimize delivery velocity. | `docs/TECHNICAL_DEBT_REGISTER.md` | Register a new `TD-XX` item with:<br>• `Original Debt / Trade-off`<br>• `Decision Owner & Rationale`<br>• `Conditions to Revisit / Reverse` | • Using **Upstash Redis REST** over persistent WebSockets/TCP to prevent resource leaks in stateless serverless runtimes.<br>• Declining **files_audit** trigger tables to conserve Neon write IOPS (TD-03). |
| **Tier 3: Pre-implementation Exploration** | Comparative analysis evaluating candidate libraries, algorithms, or protocols prior to implementation. | `docs/specs/` (English)<br>or `docs/.Plans/` (Arabic) | Full evaluation matrix comparing complexity, latency, memory footprint, and security posture. | • Cryptographic benchmark evaluation between **PBKDF2 via Web Worker** vs. **WASM Argon2id**. |

### Standard Trade-off Documentation Template

When documenting a trade-off within any living architectural document in `docs/architecture/`, adhere to this template:

```markdown
## Architectural Decisions & Trade-offs

### Decision: [Title of Decision — e.g., Choosing Diff3 over CRDTs for Offline Sync]

- **Context:** [Problem definition and operational constraints]
- **Chosen Architecture:** [Selected library, pattern, or protocol]
- **Rejected Alternatives:** [Discarded libraries or approaches]
- **Trade-off Analysis:**
  | Evaluation Criteria | Chosen Solution ([Choice]) | Alternative ([Discarded]) |
  | :--- | :--- | :--- |
  | Implementation Complexity | Low / Deterministic | High |
  | Memory / Storage Overhead | Minimal | High (tombstones / history) |
  | Conflict Resolution Model | Operational LWW + 3-Way Merge | Continuous Convergence |

- **Migration Trigger (When to Switch):**
  [Exact quantitative, technical, or product condition that mandates migrating to the alternative].
```

---

## 6. Decision Policy: Create vs. Update vs. Merge

### Creating a NEW documentation file is FORBIDDEN unless ALL of the following hold:
1. A **major change** occurred in a software module.
2. That change is **not directly related to any existing documentation file**
   in the current sections.
In every other case, the relevant existing file MUST be edited exclusively —
no new files.

### Creating a NEW folder or main section is FORBIDDEN unless BOTH hold:
1. An entirely new infrastructure or technical system is being established
   whose tasks do not fall under any existing folder.
2. **Explicit prior approval from the user** has been obtained before the
   folder or section is adopted.

### Structure synchronization (mandatory):
- The approved design standards and the exact current organizational structure
   are documented in [`README.md`](./README.md).
- Whenever any folder is renamed or a new section is created, `README.md`
  MUST be updated **immediately** to reflect the latest structure.
- After any code change, all affected files MUST be traced and inspected to
  update any numbers, references, or technical documentation impacted by the
  change — fully synchronized within the same change.

### MERGE / RETIRE when:
1. Two files cover >60% overlapping scope — merge into the stronger one and
   leave a redirect note in `records/` if the merged content had historical value.
2. A documented component was deleted from the codebase: move the file to
   `records/archive/` with a "Superseded/Removed" banner rather than deleting it outright,
   unless it contains no historical value.

---

## 7. Evidence Discipline (Mandatory)

Any published metric must be reproducible:

- Test counts / pass rates require: **date + branch or commit SHA + the exact
  command run** (e.g., `npx vitest run`), and ideally the raw output.
- Performance figures require methodology (dataset size, environment, iterations)
  or must be labeled *"historical observation — unbenchmarked"*.
- Never publish bare totals ("225 tests passing") as current truth; prefer
  "as of `<date>`" phrasing plus a verification command.
- Static counts (`grep`) are approximations; runtime output wins.

Historical documents that cannot be re-verified receive a point-in-time banner:

```markdown
> **Point-in-time record (<date>).** Metrics below reflect the repository state
> at that date; re-run `<command>` for current numbers.
```

---

## 8. Linking Rules

- **Relative links only.** Absolute paths (`file:///`, `/Users/...`, `D:\...`)
  are forbidden inside `docs/`.
- Link between related documents using their post-restructure locations, e.g.
  from this folder: [`SYNC_API`](./reference/sync-api.md); from a subfolder
  such as `architecture/` the same target is `../reference/sync-api.md`
  (paths inside link parentheses must start with `./` or `../`).
- Prefer linking to symbols/functions over line numbers; line references rot silently.
- References into `src/` use relative paths such as `../../src/lib/sync/sync-manager.ts`.

---

## 9. Document Template (Clean Markdown Standards)

```markdown
# <Title>

<One-paragraph scope statement>

---
## 1. Overview & Objectives
## 2. Architecture / Contract                  <!-- tables + mermaid preferred -->
## 3. Implementation Details                   <!-- anchored to src/ files -->
## 4. Architectural Decisions & Trade-offs     <!-- comparison matrix + rationales -->
## 5. Alternative Architectures & Triggers     <!-- explicit migration thresholds -->
## 6. Verification & Test Evidence             <!-- evidence-discipline rules apply -->
## 7. Related Documentation                    <!-- relative links -->
```

Conventions: English only; one H1 per file; fenced code blocks with language
tags; tables for matrices; mermaid for flows/state machines; no orphan sections.

---

## 10. Review Cadence

1. **With every code PR:** docs describing touched modules must be updated or
   the PR explains why no update is needed.
2. **With every release:** bump `CHANGELOG.md`; re-check `TECHNICAL_DEBT_REGISTER.md`
   entries; verify all index links in `README.md` resolve.
3. **Quarterly audit:** spot-check `reference/` contracts against routes
   (response shapes, status codes, rate limits) and `architecture/` diagrams
   against implementations.

---

## 11. Prohibitions & Core Invariants

- **Living Architecture Co-Evolution & Immutability of Records:** `docs/architecture/` is the authoritative `LIVING SPEC & ADR REGISTRY` and must co-evolve directly with the active codebase. Conversely, do not modify `docs/records/` (including retired historical designs and baselines preserved under `docs/records/archive/`) retroactively beyond prepending point-in-time archival banners.
- **Code Directory Purity:** Do not create or retain any `README.md` or markdown documentation files inside source directories (`src/**`). All platform documentation must reside within `docs/`.
- Do not delete documentation sections without demonstrating they no longer map to existing code.
- Do not document planned behavior as if implemented — label it *planned* and link the tracking item.
- Do not copy test counts between documents; cite the owning record instead.

---

## 12. Standardized Test Metrics Representation (Living Documentation)

To eliminate documentation drift and regex fragility across living documentation (`README.md`, `docs/README.md`, `docs/reference/`, `docs/architecture/`, `docs/TECHNICAL_DEBT_REGISTER.md`):

1. **Mandatory Canonical Delimiters:** In living files, test figures must never be written as arbitrary, free-form prose. They must strictly use standard HTML comment-delimited blocks or canonical tokens managed programmatically by `scripts/sync-doc-metrics.mjs`:
   - **Canonical Table Block (`<!-- BEGIN:SSOT_TEST_METRICS_TABLE --> ... <!-- END:SSOT_TEST_METRICS_TABLE -->`):** For structured tabular displays of unit, live, and E2E metrics.
   - **Canonical Inline Baseline (`<!-- BEGIN:SSOT_TEST_METRICS_INLINE --> ... <!-- END:SSOT_TEST_METRICS_INLINE -->`):** For inline verification summaries.
   - **Canonical Command Comments:** Unified comment format following verification commands.
   - **Canonical Badges & Alt Attributes:** Synchronized badge links and `alt="..."` text.
2. **Prohibition of Ad-Hoc Phrasing:** Introducing un-delimited prose expressing repository test counts in living files is strictly prohibited.
3. **Automated Verification:** All living documents containing test metrics must be verifiable via `node scripts/sync-doc-metrics.mjs --check` and synchronizable via `--update-docs`.
