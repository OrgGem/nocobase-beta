# plugin-git-manager

## Overview
Manage Git repositories with PAT authentication and run AI-powered code reviews on
merge requests. Combines repository operations (clone/pull/push/diff) with a configurable
review pipeline backed by AI Employees.

## Features

### Repository management
- **Clone, fetch, pull, push** to external Git providers (GitHub, GitLab, etc.).
- **PAT authentication** — Personal Access Tokens are stored encrypted and redacted
  from API responses.
- **File & diff browser** — view commits, changed files, and inline diffs from the
  NocoBase UI.
- **Merge Request integration** — list, filter, and inspect GitLab MRs (overview,
  changes, comments).

### AI code review
- **Review Flows** — configurable per repository or global (apply to all repos).
  Each flow binds an AI Employee, an optional LLM service / model override,
  trigger mode, post mode, branch filter (regex), and extra prompt instructions.
- **Trigger modes**:
  - `manual` — run from the Merge Requests tab.
  - `onMergeRequestCreated` — auto-trigger when a new MR is detected by the poller.
  - `both` — manual + auto.
- **Post modes**:
  - `auto` — review is posted to the MR as soon as it completes.
  - `manual` — review is held in the Review History tab pending approval.
  - `disabled` — review is generated and stored but never posted.
- **Re-review on new commits** — every review tracks `headSha` (the SHA that was
  reviewed) and `latestSha` (the latest known SHA on the MR). The Merge Requests
  tab flags MRs whose `latestSha !== headSha` so reviewers can re-run the flow.
- **One review per MR** — re-running a review UPSERTs the existing record, preserving
  history through `metadata` while keeping the row count bounded.

### Background poller
- **5-minute interval** — polls open MRs for repos with `autoReview` enabled.
- **Per-repo opt-in** — toggle `Auto Review` on the repository row to enable polling
  for that repo. Disabled repos are never queried.
- **Smart re-poll** — uses GitLab `updated_after` (with a 1-second safety buffer) so
  each tick only fetches MRs that have changed since the last poll.
- **No auto re-trigger** — auto-poll only triggers a review the **first time** an MR
  is seen. When new commits arrive on an already-reviewed MR, the poller refreshes
  `latestSha` only; re-review must be initiated manually.
- **Status panel** — the Polling tab shows poller state (running/stopped), last tick,
  last error, and provides `Poll Now` / `Poll Now (All)` actions.

## Collections
| Name | Purpose |
|---|---|
| `gitRepositories` | Connected repos, PAT, default branch, `autoReview` flag, `lastPolledAt`. |
| `gitReviewFlows` | Review pipeline definitions (AI employee, trigger mode, post mode, branch filter). |
| `gitCodeReviews` | Review records — one per MR target — with status, markdown output, metadata, post status. |

## Permissions
The plugin registers two ACL snippets:
- `pm.plugin-git-manager.read` — list/get on repos, flows, reviews + read-only Git
  operations (status, log, diff, MR queries, poller status).
- `pm.plugin-git-manager.write` — create/update/destroy on collections + write Git
  operations (clone, pull, push, checkout) + review actions
  (`triggerReview`, `reviewApprovePost`, `reviewReject`, `pollNow`).

## Usage

### 1. Connect a repository
1. Open **Settings → Git Manager → Repositories**.
2. Click **Add Repository** and provide the clone URL, username, and PAT.
3. (Optional) Toggle **Auto Review** to enable background polling for this repo.

### 2. Configure a Review Flow
1. Open the **Review Flows** tab.
2. Click **Add Review Flow** and set:
   - **Repository** — leave empty for a global flow.
   - **AI Employee** — username of the AI Employee that will run the review.
   - **Trigger Mode** — `Manual`, `On Merge Request Created`, or `Both`.
   - **Post Mode** — `Auto post to MR`, `Manual approval before posting`, or
     `Do not post`.
   - **Branch Filter** — optional regex; only MRs whose source branch matches will
     be picked up.
   - **Additional Instructions** — extra prompt text appended to every review run.

### 3. Run a review
- **Manual** — from the **Merge Requests** tab, click **Run Review** on any open MR.
- **Automatic** — enable **Auto Review** on the repo and create a flow with
  trigger mode `On Merge Request Created` or `Both`. Within ~5 minutes the poller
  will detect new MRs and trigger reviews.

### 4. Approve or reject
If the flow uses `manual` post mode, completed reviews land in the **Review History**
tab with status **Pending Approval**. From there:
- **Approve & Post** — posts the review as a note on the MR.
- **Reject** — marks the review as rejected; nothing is posted.
- **Edit before posting** — tweak the markdown before approving.

### 5. Re-review on new commits
When new commits are pushed to an already-reviewed MR, the Merge Requests tab shows
a **New commits** badge. Click **Re-run** to overwrite the existing review with a
fresh one for the latest `headSha`.

## Notes & limits
- The poller fetches at most 50 MRs per repo per tick (`per_page=50`). Repos with
  more than 50 open MRs may need manual `Poll Now` runs to catch up.
- GitLab is the only fully-supported MR provider for the review pipeline; basic
  Git operations work against any provider.
- The poller is in-process. In multi-instance deployments it runs on every node;
  the `isPolling` flag prevents overlap within a single process but not across
  nodes. Co-ordinate via a single primary node if needed.
