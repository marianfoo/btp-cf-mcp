# Documentation Conventions

This repo keeps docs in git because auth, BTP roles, and MCP tool behavior are part of the product. Future agents must
follow this structure instead of adding new Markdown files directly under `docs/`.

## Basis

The structure borrows from:

- [Diátaxis](https://diataxis.fr/): separate docs by user need — how-to guides, reference, explanation, and tutorials.
- [Architecture Decision Records](https://github.com/architecture-decision-record/architecture-decision-record): record
  important architecture decisions with context and consequences.
- [Martin Fowler on ADRs](https://martinfowler.com/bliki/ArchitectureDecisionRecord.html): keep ADRs short, numbered, in
  the repo, and supersede rather than rewrite accepted decisions.
- [Google developer documentation style guide](https://developers.google.com/style): prefer project-specific style first,
  then general style guidance; optimize for clarity and consistency.

## Directory Layout

| Directory | Purpose | Examples |
|---|---|---|
| `docs/agent/` | LLM/agent onboarding, project history, working context | `onboarding.md`, `creation-history.md` |
| `docs/architecture/` | Architecture explanations, implementation plans, protocol designs | `implementation-plan.md`, `ias-oauth-proxy-plan.md` |
| `docs/architecture/adr/` | Accepted architecture decision records | `0001-ias-first-inbound.md` |
| `docs/guides/` | Task-oriented how-to docs for setup, deployment, admin work | `admin-deployment.md`, `per-user-ias-auth-setup.md` |
| `docs/operations/` | Runbooks, spike status, live-test procedures | `live-chain-runbook.md`, `per-user-spike-notes.md` |
| `docs/research/` | Dated research dossiers and external comparisons | `YYYY-MM-DD-topic.md` |
| `docs/README.md` | Navigation index only | keep concise |
| `docs/docs-conventions.md` | This file | update when the structure changes |

Do not create new flat files under `docs/` unless they are navigation or documentation-governance files.

## Naming Rules

- Use lowercase kebab-case Markdown filenames: `per-user-ias-auth-setup.md`.
- Use dates only for research dossiers: `2026-06-30-per-user-outbound-auth.md`.
- Use numbered ADR names in `docs/architecture/adr/`: `0001-ias-first-inbound.md`.
- Prefer descriptive nouns for explanations: `ias-oauth-proxy-plan.md`.
- Prefer task names for guides/runbooks: `admin-deployment.md`, `live-chain-runbook.md`.
- Avoid ambiguous words like `notes.md`, `misc.md`, `new.md`, or `draft.md`.
- Rename broad docs once their purpose is clear; update all links in the same change.

## Choosing A Location

Ask this before creating a doc:

| Question | Put it in |
|---|---|
| "What should an AI agent know before editing?" | `docs/agent/` |
| "How do I perform this setup or operational task?" | `docs/guides/` or `docs/operations/` |
| "Why is the system designed this way?" | `docs/architecture/` |
| "What decision did we accept?" | `docs/architecture/adr/` |
| "What did research discover on a date?" | `docs/research/` |
| "Where do I find docs?" | `docs/README.md` |

## Document Shape

Every substantial doc should start with:

```markdown
# Short Title

Status: Draft | Current | Accepted | Superseded
Audience: agents | operators | maintainers | administrators
Read when: one sentence
```

Existing docs may not all have this banner yet; add it when you materially edit them.

## Link Rules

- Prefer relative Markdown links that work from the document location.
- After moving docs, run `rg` for old filenames and update every internal reference.
- Keep `docs/README.md` and `AGENTS.md` synchronized with structure changes.
- Avoid absolute local filesystem paths in docs unless the path is intentionally machine-specific.

## ADR Rules

- One accepted decision per ADR file.
- Use `Status`, `Date`, `Context`, `Decision`, `Consequences`, and `Supersedes/Superseded by` when relevant.
- Do not rewrite accepted ADRs to change history. Create a new ADR that supersedes the old one.
- Keep research and long evidence in `docs/research/`; link it from the ADR.

## Agent Rules

Agents changing docs must:

1. Put new docs in the right directory.
2. Use the naming rules above.
3. Update `docs/README.md`.
4. Update `AGENTS.md` if the change affects future agent behavior.
5. Avoid copying secrets from chats, logs, or deployment output.
