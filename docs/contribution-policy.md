# Issue triage and contribution policy

This shared policy is implemented for active repositories in the Kubescape organization. Automation remains disabled
until maintainers set the `CONTRIBUTION_POLICY_START` repository variable to an
ISO UTC timestamp. PRs opened before that timestamp are exempt. The rules below
apply after activation, including to draft PRs.

## Picking up work

1. New issues receive `status: needs-triage`, except issues opened by a maintainer
   with write, maintain or admin permission. For other issues, a maintainer
   removes the label when it is ready for work.
2. Read the issue and its prerequisites, then ask a maintainer to assign you.
   **Self-assignment is not allowed**, including `/assign-me` and a maintainer
   assigning themselves. Wait for another maintainer to assign you before
   starting. Creating an issue does not grant assignment rights; a maintainer
   may assign its author after triage. `/unassign-me` remains available to release
   your own assignment.
3. A contributor can hold at most **three open issue assignments per repository**, including
   manually assigned issues. There is no open-PR limit. At most two of those
   assignments can carry any one of `good first issue` or `good second issue`.
4. Maintainers with write, maintain or admin permission can use `/assign @user`
   and `/unassign @user`. Assignment requires completed triage and available
   capacity. Issues already assigned to someone else require coordination.
5. The issue-assigned event also checks assignments made through GitHub's UI or
   API. Self-assignment is reversed with an explanation. A queued event does not
   undo a later valid assignment by another maintainer. GitHub administrators
   retain control of repository settings; this workflow enforces the process
   while enabled, rather than removing their platform permissions.

An inactive assignment receives a reminder after four days and becomes eligible
for release after 14 days without progress. The bot waits at least one day after
a reminder before releasing it. A progress comment by the assignee resets the timer; bot
comments do not. An open linked PR, including a draft, protects that author's
assignment. Maintainers can apply `📌 Pinned` for longer work. Assignments begun
before rollout, assignments with unknown start times, and maintainer assignments
are not expired automatically.

## Opening and updating a PR

Link each issue with `Fixes #number`, `Closes #number`, `Resolves #number` or
`Refs #number` for partial work. Colon forms such as `Fixes: #number` and
same-repository issue URLs also work. Examples
inside HTML comments, code blocks or quotations do not count. Links to other
repositories or PR numbers do not satisfy this check.

The **Contribution policy** check verifies that every referenced issue is open,
triaged and assigned to the author. A missing link fails the check. A PR linked
with a closing link to an issue that is not assigned to its author is automatically
closed with an explanation. A non-assignee `Refs` link fails the check but does
not trigger assignment-based closure. Opening a PR does not automatically assign
its author to an issue.

A fixing PR for an issue still labelled `status: needs-triage` is automatically
closed with an explanation. `Refs` alone does not cause closure for missing
triage or assignment, but these failures remain visible in the check. An assigned
`Refs` PR must not duplicate another PR.

Only one open linked PR per issue is allowed. The earliest open PR from a current
assignee is kept; later PRs referencing the same issue are closed with a link to
it. Both `Fixes` and `Refs` count, including draft PRs. An earlier PR from someone
who is not assigned does not block the assignee. Split independent work into
separate issues. Assignment and duplicate state are checked again before closing.

A pinned PR is protected from automatic closure but must still pass the check to
merge. After triage and assignment, reopen the same PR if no earlier linked PR
is already covering the issue. Event checks run when GitHub dispatches the
workflow; closure is not synchronous with submitting a PR.

Closing an unmerged PR releases its author's linked fixing-issue assignments,
unless another open linked PR by that author still uses the issue or the issue
was reassigned after closure. Pre-rollout assignments and assignments with unknown
start times are also preserved. Interrupted cleanup is retried using the
`status: policy-release-pending` label. Other contributors' assignments are preserved.

PRs by bots and maintainers are exempt from the contribution checks and automatic
closure. Exemption uses GitHub account type and current repository permission,
not an editable title prefix or branch name.

## Requested changes and inactivity

A PR with an outstanding change request from a human maintainer is marked
`status: stale` after three inactive days. A warning gives the author seven more
days to push changes or reply before automatic closure. PRs simply waiting for a
review are not closed. New commits, author replies, approval or dismissal of the
request, and `📌 Pinned` protect against closure. These checks run daily, so
labels may take until the next scheduled run to update. Inline replies count.
Reopening a PR starts a new inactivity warning window.

Only reviewers with repository write, maintain or admin permission can trigger
this lifecycle. Bot reviews and outside contributors' reviews do not.

## Organization rollout

Automatic reviews remain part of the normal maintainer routine. Address review
findings with code changes and reproducible evidence, and retain unresolved
findings until their prerequisites are met. Do not disable reviewers or add
repository/path exclusions to avoid review.

1. First merge the organization-wide policy proposal in
   `kubescape/project-governance#41`. Next review the shared workflow in
   `kubescape/workflows#110` and merge it after maintainer approval. Then
   validate the implementation in `kubescape/kubevuln#1270` before wider adoption.
   This changes the existing allowance for small issue-free PRs. The assignment
   cap is three **per repository**. Start with a pilot in `kubescape/kubevuln`;
   keep every other repository disabled until the pilot is reviewed.
2. Inventory every organization repository, including the `private` flag and
   current write permissions. Generate caller workflows with
   `scripts/contribution-policy-rollout.py --inventory INVENTORY.jsonl --sha FULL_SHA --output LOCAL_DIRECTORY`.
   Review the manifest locally: it may name private repositories and must not be
   attached to a public PR. The generator never modifies GitHub.
3. Open a PR adding the generated `.github/workflows/contribution-policy.yaml`
   to each active repository. Preserve existing workflows, local instructions,
   issue templates and repository-specific documentation. Archived, disabled,
   and non-writable repositories are reported as skipped, not silently enabled.
   Repositories without issues still get stale-PR handling; issue requirements
   are skipped there so every PR is not blocked on an impossible issue link.
4. Each caller pins the shared action to a full reviewed commit SHA. Before
   merging the rollout callers or activating the pilot, verify that commit is
   present on `kubescape/workflows` `main` and contains the action. The current
   rollout depends on `kubescape/workflows#110`; its PR-branch SHA is not a
   substitute for this check. Squash or rebase merging can change commit SHAs:
   select a commit from `main` after merge and update every caller if necessary,
   including the disabled caller bundled with the shared action itself.
   The action executes from its downloaded directory and never checks out the PR.
   No personal access token or cross-repository write token is required.
5. Create `status: needs-triage`, `📍 Assigned`, `📌 Pinned`, `status: stale`,
   and `status: policy-release-pending`
   in each target repository. Use an agreed rollout timestamp after installation
   so the existing backlog is exempt. Initially set the variable only for the
   `kubescape/kubevuln` pilot. Creating labels alone does not enable enforcement.
   After the pilot is accepted, an organization owner can distribute
   `CONTRIBUTION_POLICY_START` as an organization variable to the selected
   repositories, or repository maintainers can configure it individually.
6. Allow the caller workflow to use `pull_request_target` in the organization
   Actions event policy. Public-repository default blocking is scheduled to be
   enforced December 2, 2026. Scope the allowance to this workflow file.
7. After a pilot run verifies the status and permissions, an organization owner
   can require **Contribution policy** from GitHub Actions using an organization
   ruleset targeting the default branches of the selected repositories. Do not
   require the status before those repositories have the caller workflow.
   Merge queues require additional `merge_group` support before using this status.
8. Re-run the inventory and rollout for new repositories. A shared action or
   `.github` repository does **not** automatically install event workflows in
   existing or future repositories. Workflow templates are onboarding aids,
   not organization-wide enforcement.

To disable automation, remove `CONTRIBUTION_POLICY_START` and remove the required
status from the ruleset together, so PRs are not left waiting for a disabled check.
Keep the original rollout timestamp when re-enabling to preserve exemptions.

Values live in `.github/actions/contribution-policy/config.json` in `kubescape/workflows`. Commands are serialized across
the repository using a concurrency queue, and current state is fetched before
assignment. GitHub queues at most 100 pending runs; a command dropped because the
queue is full needs to be posted again. Scheduled runs reconcile PR checks, but
do not replay dropped assignment commands. Independent PRs continue to be processed
after an API error, and the workflow reports the errors at the end. A check being
revalidated fails until validation finishes, so an API error cannot preserve an
obsolete success after the check has been reset. If GitHub refuses the check write
itself, the workflow fails and maintainers must inspect the failed run.

The caller needs `checks: write`. It updates one check per head commit instead of
appending commit statuses, which have a per-context limit. GitHub checks are also
commit-scoped: all open PRs sharing a head must pass before that commit receives
success. A valid or maintainer-authored PR can therefore be blocked by an invalid
sibling until it is fixed or closed and the policy rechecks. This conservative
behavior prevents a sibling PR from overwriting a failure. During the Kubevuln
pilot, verify the required check on two PRs sharing one head, including a fork PR,
before enabling the ruleset. No merge-queue support is implied.

The automation deliberately does not infer AI authorship, maintain contributor
blacklists or incident counters, or automatically approve/merge PRs. Those are
separate moderation and review decisions.

## Validation

Run `node --test .github/actions/contribution-policy/tests/policy.test.cjs` and
`python3 -m unittest discover -s tests -p 'test_contribution_policy_rollout.py' -v`. The node tests use an in-memory GitHub API;
real token permissions, event delivery and rulesets must be verified during
activation. Normal unprivileged PR CI runs these tests. The privileged automation
runs the pinned shared action only and does not run a PR's tests or build scripts.

GitHub references:

- [Actions event policies and pull_request_target](https://docs.github.com/en/actions/reference/security/securely-using-pull_request_target)
- [Concurrency queues](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)
- [Required status checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets)

Tooling note: actionlint v1.7.12 does not recognize GitHub's documented
`concurrency.queue` property. When using that version, exclude only its
`unexpected key "queue" for "concurrency" section` diagnostic. Keep the queue;
removing it causes pending assignment commands to replace each other.

## Reproducible review evidence

Run from the workflows checkout with Node.js and Git available:

```sh
node scripts/contribution-policy-proof.cjs df625673d52f8eac4a4619069e83b8b19cd61c8b
node scripts/contribution-policy-proof.cjs b65263209ccb370f0cb508f776cde7850ebfb6ee
node --test .github/actions/contribution-policy/tests/policy.test.cjs
python3 -m unittest discover -s tests -p 'test_contribution_policy_rollout.py' -v
```

The first two commands feed identical events through an in-memory GitHub API
fixture. The base revision has no policy action, so the baseline is explicitly
no policy execution. The second revision is the action currently pinned by the
caller PRs. No network requests or real issue/PR mutations occur.

| Same fixture input | Base: no policy | Pinned implementation |
| --- | --- | --- |
| Assigned, triaged PR | Open; no check | Open; success |
| Non-assignee PR | Open; no check | Closed; failure |
| `Fixes: #1` from non-assignee | Open; no check | Closed; failure |
| Invalid PR sharing a head with an exempt maintainer PR | Both open; no check | Both open; aggregate failure |

Repeating the same event updates one check run rather than creating additional
runs. The shared suite passes 67 tests; the rollout generator passes four tests.
The proof script asserts the results and is also run in policy CI against HEAD.

This is offline behavior evidence, not a Kubevuln pilot. GitHub token permissions,
fork behavior, event delivery and required-check rules must still be validated
on Kubevuln after the proposal and workflow reviews. The same-head aggregate can
block a valid sibling PR; maintainer acceptance of that tradeoff remains required.

### API usage during scheduled checks

PR checks share one paginated open-PR snapshot per run. Successful closures remove
the PR from that snapshot before duplicate checks and assignment cleanup. A single
refresh before expiry includes PRs opened during checking; expiry operations share
that refreshed list. Current PR, issue, assignment and pin state are still checked
before a destructive update.
