# Issue tracker: Jira

Issues and specs for this repo live in the Jira project `CDA` at
<https://datn-fit-hcmus.atlassian.net/jira/software/projects/CDA/boards/34/backlog>.
Use the connected Atlassian integration for Jira operations.

## Conventions

- Jira issue keys use the format `CDA-<number>`, such as `CDA-12`.
- Create, read, comment on, label, and transition issues in Jira using the available Jira integration or UI.
- When a skill says “publish to the issue tracker”, create or update the relevant Jira issue in project `CDA`.
- When a skill says “fetch the relevant ticket”, use the supplied Jira issue key, such as `CDA-12`.
- Branches use `<TICKET>-<short-english-description>`, such as `CDA-12-add-login`.
- Pull request titles start with the Jira ticket key.

## Status workflow

The Jira workflow uses these statuses:

- `To Do`
- `In Progress`
- `Blocked`
- `In Review`
- `Done`
- `Cancelled`

The workflow permits transitions from any status where configured by Jira.

## Wayfinding operations

Used by `/wayfinder`. The **map** is an Epic with Task children as decision tickets.

- **Map**: create an Epic labelled `wayfinder:map`. Its description contains the Destination,
  Notes, Decisions-so-far, Not-yet-specified, and Out-of-scope sections.
- **Child ticket**: create a Task whose parent is the map Epic. Apply exactly one
  `wayfinder:<type>` label: `research`, `prototype`, `grilling`, or `task`.
- **Blocking**: use Jira's native `Blocks` issue link. The blocker is the outward issue and the
  blocked ticket is the inward issue. Transition tickets with unresolved blockers to `Blocked`;
  return them to `To Do` after every blocker reaches `Done` or `Cancelled`.
- **Frontier query**: query open, unassigned children with
  `project = CDA AND parent = <map-key> AND statusCategory != Done AND assignee IS EMPTY ORDER BY created ASC`,
  then exclude any ticket with an open inward `Blocks` link.
- **Claim**: assign the ticket to the authenticated Jira user before doing any work, then
  transition it to `In Progress`.
- **Resolve**: post the answer as a resolution comment, transition the ticket to `Done`, and
  append a one-line gist with a link to the ticket under the map's Decisions-so-far section.
- **Rule out of scope**: post the reason, transition the ticket to `Cancelled`, and link it from
  the map's Out-of-scope section instead of Decisions-so-far.
