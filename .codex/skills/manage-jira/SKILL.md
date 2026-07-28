---
name: manage-jira
description: Full Jira Server/Data Center or self-hosted Jira REST operations through jira.js, using a configured base URL and Bearer PAT. Use when the user asks to inspect, search, create, update, transition, comment on, administer, or otherwise automate Jira data.
---

# Manage self-hosted Jira

Use the bundled `scripts/jira.mjs` runner for repeatable calls. It exposes every method on jira.js clients (Jira v3, v2, Agile, and Service Desk), not only the examples below.

## Configure

Require Node.js 20+ and run `npm install` once in this skill directory, then set:

```powershell
$env:JIRA_BASE_URL = 'https://jira.example.local'
$env:JIRA_PAT = '<token>'
```

`JIRA_BASE_URL` is normalized without a trailing slash. Never print or persist `JIRA_PAT`. jira.js has no first-class PAT option, so the runner deliberately sends `Authorization: Bearer <PAT>` through `baseRequestConfig`; do not substitute Basic auth or email/API-token credentials.

## Operate

```powershell
node .codex/skills/manage-jira/scripts/jira.mjs list
node .codex/skills/manage-jira/scripts/jira.mjs list version3 issues
node .codex/skills/manage-jira/scripts/jira.mjs call version3 issueSearch searchForIssuesUsingJql '{"jql":"project = DEMO ORDER BY created DESC","maxResults":20}'
node .codex/skills/manage-jira/scripts/jira.mjs call version3 issues createIssue '{"fields":{"project":{"key":"DEMO"},"summary":"Example","issuetype":{"name":"Task"}}}'
```

The first argument after `call` is the client (`version3`, `version2`, `agile`, or `serviceDesk`), followed by the property and method names. JSON arguments are parsed as one object; use `-` to read JSON from stdin. Inspect `list` before guessing names. Confirm destructive or bulk writes with the user, respect Jira permissions, and surface HTTP status/body without exposing credentials.

For detailed method groups and parameter shapes, read `references/api.md` and verify against the installed package typings when versions differ. After each write, fetch the affected resource to verify the resulting state.
