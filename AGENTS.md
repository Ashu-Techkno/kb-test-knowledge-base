# Instructions for AI agents (Codex)

This repository is the company's central knowledge base. Use it to answer questions about our projects.

## Where to look

- Project list and metadata: `projects/*/project.yaml`
- Current facts generated from the repos (dependencies, last commit, contributors): `projects/*/facts.yaml`; recent changes: `CHANGELOG.md`
- What a project is and how to run it: `projects/<name>/README.md`
- Why a project exists: `projects/<name>/context.md`
- Why a specific technical choice was made: `projects/<name>/decisions/` (ADRs)
- Decisions that apply to all projects: `decisions/`

## How to answer

1. For any "why" question, read the relevant ADRs first. Answer from the recorded reasoning and cite the file path (e.g. `projects/payment-service/decisions/0001-postgres-over-mongo.md`).
2. If no ADR covers the question, say so clearly. Do not invent a reason. Suggest that a decision record be written.
3. Only treat ADRs with `Status: Accepted` as current. If an ADR is `Superseded`, follow its link to the newer one and answer from that. If the only ADR is `Draft` or `Proposed`, you may use it, but say clearly that it is not yet confirmed.
4. Reasons tagged `[Inferred]` are unconfirmed readings of the evidence. Never present them as fact; say they are inferred. Reasons tagged `[README]` or `[Code]` are backed by the source repo.
5. Before suggesting a change to a project, check its ADRs. If your suggestion goes against an accepted decision, mention that decision and the trade-off it recorded.
6. Prefer `project.yaml` for facts like owner, stack, repo URL and status. For anything that changes often (dependencies, last activity, contributors), `facts.yaml` is newer; if the two disagree, say so.

## What to ignore

- `.obsidian/` (editor settings, not knowledge)
- `templates/` (empty templates, not real data)

## When writing or editing docs

- Follow the templates in `templates/`.
- Use standard Markdown links `[text](relative/path.md)`, not `[[wikilinks]]`.
- Never delete an ADR. To change a decision, write a new ADR and mark the old one `Superseded by NNNN`.
