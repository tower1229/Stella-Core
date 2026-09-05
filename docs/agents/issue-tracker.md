# Issue tracker: GitHub

Issues and PRDs for this repo live as GitHub issues in `tower1229/Stella-Core`. Use the `gh` CLI for all operations.

Current product requirements and contracts follow [the design baseline](../10-DESIGN-BASELINE.md). A ticket defines work within its stated version and scope; closed proposals and old acceptance counts are historical evidence. Cite the current contract in new work, and record a conflict rather than treating an old ticket as authority over newer settled requirements. Historical publication or activation permission does not authorize a new task.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`.
- **Read an issue**: `gh issue view <number> --comments`.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments` with appropriate label and state filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`.
- **Apply or remove labels**: `gh issue edit <number> --add-label "..."` or `--remove-label "..."`.
- **Close an issue**: `gh issue close <number> --comment "..."`.

Infer the repository from the current Git remote. When a skill says "publish to the issue tracker", create a GitHub issue. When a skill says "fetch the relevant ticket", read the issue and its comments.

GitHub Issues and pull requests share one number space. Resolve ambiguous references before acting.

## Pull requests as a triage surface

**PRs as a request surface: no.**

External pull requests do not automatically enter the issue triage workflow.

## Wayfinding operations

- A wayfinding map is one issue labelled `wayfinder:map`.
- Decision tickets are child issues, using native GitHub sub-issues where available.
- Use native issue dependencies for blocking edges where available.
- Fall back to explicit task lists and `Blocked by:` references only when native relationships are unavailable.
- Claiming a ticket assigns it to the current user.
- Resolve a ticket by recording the decision, closing it, and linking the result from the map.
