# plugin-git-manager

## Overview
Manage Git repositories with PAT authentication and run workflow-based AI reviews on
merge requests, commits, branches, and folders. Git Manager owns repository access,
request admission, project reservations, and review history; `plugin-workflow-git-review`
provides the workflow nodes and templates.

## Repository prerequisites

The repository features are available independently of the optional review workflow.

- Set each self-hosted GitLab account's **Base URL** to its HTTPS origin. A blank Base URL means
  `https://gitlab.com` for GitLab and `https://github.com` for GitHub. Repository and account origins
  must match, including the port. GitHub Enterprise API endpoints are not implemented.
- Use the final repository URL. Authenticated Git and provider API requests reject redirects.
- Use Git 2.31 or newer for process-scoped credential configuration. PATs are no longer written into
  remote URLs or Git configuration. The plugin clears inherited Git command/config/trace overrides
  for its Git subprocesses. `GIT_SSL_CAINFO` and `GIT_SSL_CAPATH` remain available for private CAs.
- Repository paths must resolve strictly below `GIT_REPOS_BASE_PATH`. The base directory itself,
  traversal paths, and symlinks/junctions escaping the base are rejected, including clone destinations
  below a linked parent. Keep that storage directory writable only by trusted service operators.
- Call mutation actions with **POST**, including `subtreeOptions` and `subtreePreview`, which fetch
  remote refs. GET and HEAD return 405 before executing these actions. The bundled clients already use POST.
- Poller timers, in-flight guards and status belong to each application. Stopping one application
  does not stop another application's poller. A running cycle retains its guard until it finishes.
- Standard Git screens can load without the AI module. Git-specific review actions submit to the
  workflow review queue.

For review workflows, install and enable the compatible Workflow, Workflow Manual, AI and
`plugin-workflow-git-review` plugins. The integration plugin requires NocoBase 2.2.40 or newer in the 2.x series.

## Features

### Repository management
- **Clone, fetch, pull, push** to external Git providers (GitHub, GitLab, etc.).
- **PAT authentication** — Personal Access Tokens are held in Git accounts and redacted
  from API responses. Git operations receive credentials through the child process environment.
- **File & diff browser** — view commits, changed files, and inline diffs from the
  NocoBase UI.
- **Merge Request integration** — list, filter, and inspect GitLab MRs (overview,
  changes, comments).

### AI code review
- **Review Flows** — configurable per repository or global (apply to all repos).
  A flow defines admission and posting policy and binds a native Workflow. The workflow
  owns its LLM configuration, review instructions and manual approval node.
- **Trigger modes**:
  - `manual` — submit a review from Git Manager.
  - `onMergeRequestCreated` — auto-trigger when a new MR is detected by the poller.
  - `both` — manual + auto.
- **Post modes**:
  - `auto` — review is posted to the MR as soon as it completes.
  - `manual` — an MR/PR review waits for an assigned user's manual decision before posting.
  - `disabled` — review is generated and stored but never posted.
- **Re-review on new commits** — every review tracks `headSha` (the SHA that was
  reviewed) and `latestSha` (the latest known SHA on the MR). The Merge Requests
  tab flags MRs whose `latestSha !== headSha` so reviewers can re-run the flow.
- **Review history** — each manual re-run is a separate queued request and history entry.

### Background poller
- **5-minute interval** — polls open MRs for repos with `autoReview` enabled.
- **Per-repo opt-in** — toggle `Auto Review` on the repository row to enable polling
  for that repo. Disabled repos are never queried.
- **Full pagination** — scans all pages of open MRs and retries unsuccessful scans.
- **New commits** — the default reviews the MR once; enable `Review new commits automatically`
  on a flow to queue a review for each new head SHA.
- **Status panel** — the Polling tab shows poller state (running/stopped), last tick,
  last error, and provides `Poll Now` / `Poll Now (All)` actions.

## Collections
| Name | Purpose |
|---|---|
| `gitRepositories` | Connected repos, PAT, default branch, `autoReview` flag, `lastPolledAt`. |
| `gitReviewFlows` | Workflow bindings and admission policy (trigger mode, post mode, branch filter). |
| `gitCodeReviews` | Review records — one per submitted run — with status, markdown output, metadata, post status. |

## Permissions
The plugin registers two ACL snippets:
- `pm.plugin-git-manager.read` — list/get on repos, flows, reviews + read-only Git
  operations (status, log, diff, MR queries, poller status).
- `pm.plugin-git-manager.write` — manage repository and flow configuration + write Git
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
   - **AI Employee** and model — initial settings used to provision the workflow's LLM nodes.
   - **Trigger Mode** — `Manual`, `On Merge Request Created`, or `Both`.
   - **Post Mode** — `Auto post to MR`, `Manual approval before posting`, or
     `Do not post`.
   - **Branch Filter** — optional regex; only MRs whose source branch matches will
     be picked up.
   - **Additional Instructions** — extra prompt text appended to every review run.
3. Configure the associated workflow under **Git Review Workflows**. Choose Quick or Full and assign
   approvers with repository access when manual posting is required. The setup page reports missing
   employee, model, repository or approver bindings. Create a disabled revision before editing its graph;
   enabled revisions are frozen and the integration validates them before use.

### 3. Run a review
- **Manual** — use a Git Manager review action for an MR/PR, commit, branch, or folder.
- **Automatic** — enable **Auto Review** on the repo and create a flow with
  trigger mode `On Merge Request Created` or `Both`. Within ~5 minutes the poller
  will detect new MRs and trigger reviews.

### 4. Approve or reject
If the flow uses `manual` post mode, an assigned user decides in the native Workflow
manual task. Approval applies to the exact stored review and fingerprint; rejection
does not publish a comment. Assigned users with repository access use **Git review approvals**
in the modern Workflow task center. Commit, branch and folder results are stored without posting.
Review History links to the workflow execution and tasks.

### 5. Re-review on new commits
When new commits are pushed to an already-reviewed MR, the Merge Requests tab shows
a **New commits** badge. Click **Re-run** to queue a separate review for the latest
`headSha`, or enable automatic new-head reviews on the flow.

## Notes & limits
- The poller follows all pages of open MRs; provider availability and rate limits affect each scan.
- Review and publication support GitHub.com and GitLab HTTPS repositories. GitHub Enterprise is not supported.
- Each process runs a poller. PostgreSQL and MySQL/MariaDB use a shared advisory lock when available;
  automatic request deduplication and project reservations are enforced in the database.

# Workflow-based AI review migration (1.3)

AI reviews use the Workflow integration in `plugin-workflow-git-review`, with individual Git review LLM nodes and a native manual node for required approvals. The LLM nodes use the native AI provider/model and structured-output contract, and persist the pending job before the provider call. They accept text messages for the diff review. Configure a workflow for each review flow and enable the bound revision before submitting a review. Git Manager keeps repository permissions, the review queue and review history; the workflow owns AI execution and approval. The old in-process review worker is not started by this version.

For an existing installation, stop **all** application and worker processes running the old Git Manager version and verify that all old review AI work, including work whose database row timed out or failed, has stopped or settled before confirming cutover in the workflow setup page. A fresh installation with no review history is ready automatically. The root-only cutover status shows legacy pending and running reviews and failed reviews with uncertain old execution history. Confirmation records the operator's acknowledgement; it does not itself stop an AI call and does not clear legacy running reviews. Pending legacy reviews migrate only when their original source commit, repository, actor and workflow can be established. A pending review with a missing or changed source, missing flow, or ambiguous actor is shown with its reason; a root user can explicitly cancel it with an audit record and submit a new review. Unresolved legacy reviews block their canonical project, including repository aliases. If project identity cannot be determined, dispatch remains blocked until the issue is resolved.

For historical merge-request reviews, the original reviewed base may not have been recorded and cannot be reconstructed reliably. Before approving one, compare the review with the current merge request and explicitly acknowledge this limitation. The current base is recorded for subsequent checks; it is not evidence of the original reviewed base. For a legacy publication in `posting`, `post_unknown` or `post_failed`, use Review History to check for an existing provider comment. A retry requires confirmation that the prior outbound call has stopped and settled, and keeps the approved content unchanged. An unmarked matching comment cannot be proven to belong to the same attempt and is not automatically reposted. Root administrators can release an abandoned publication hold after the same stop confirmation; this does not claim the remote outcome is known.

Requests are persisted separately from their workflow execution. A queued request uses the current enabled and validated workflow revision when it is dispatched, then pins that revision for its execution. One reservation per provider project is held across the entire workflow, including human approval. Reservations never expire on a timer. A failed, aborted or timed-out execution is quarantined when the underlying AI call might still be active; a settled failure or validated manual rejection may release it after the recorded job evidence is checked. Unclaimed or orphaned requests and missing execution records can also be recovered after the same verification. A root user may recover only after stopping and verifying the responsible worker or AI call; the setup page records the confirmation. Recovery fences late claims and results but cannot stop a still-running external call. Do not run old and new plugin binaries together during cutover: old binaries do not honor the new reservation.

Each run pins the project and commit identities at submission. GitHub.com and GitLab merge requests use provider comparison data; local commit, branch and folder reviews require the admitted commit objects to be present in the configured checkout. Missing or oversized context fails the review, and coverage limitations are reported to the workflow. The project and merge request head are checked again before publication. Publication uses an identifier in the remote comment to reconcile an uncertain response. No database transaction can make the remote head check and comment creation atomic, so provider-side head changes immediately after the check remain possible.

Automatic polling scans all open merge request pages and retries unsuccessful scans. Existing flows retain the original behavior of reviewing an MR once; enable **Review new commits automatically** to admit a review for each new head. Manual submissions are separate queued runs. Review history links to the workflow execution and workflow tasks; workflow-managed reviews must be approved in the workflow task instead of the legacy approval action.

When publication has an unknown outcome, Review History can check for the original comment without running AI again, even if the merge request head has since changed. A resend requires confirmation that the previous outbound post has stopped and settled, and the head must still match the reviewed commit. A root operator can release a publication hold after the same verification, including when no retry claim exists; the approved result is retained. The check matches the complete comment body and the authenticated Git account, and a different active review blocks the retry.

Version 1.3.1 also supports recovery of completed legacy reviews in `posting`, `post_unknown` and `post_failed`. Legacy records did not retain the reviewed base SHA: before a new post the reviewer must compare the saved review with the current merge request and explicitly acknowledge that the original base is unverified. The acknowledged current base and head are then pinned for subsequent attempts; this acknowledgement is not proof of the historical base. A matching historical comment without a marker is reported as observed rather than attributed to a specific attempt, and is not reposted. If an earlier outbound request may still be running, recovery or release of its project hold requires explicit confirmation that it has stopped and settled.

The publication retry action is a separate repository-scoped write permission. Existing roles with explicitly configured repository permissions must have their write scope saved again in Repository Permissions to grant this new action; it is not granted automatically during upgrade. Existing review submission permissions are unchanged.
