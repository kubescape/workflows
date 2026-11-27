'use strict';

const config = require('./config.json');
const DAY = 86_400_000;
const BOT = 'github-actions[bot]';
const CHECK = 'Contribution policy';
const sameUser = (a, b) => a?.toLowerCase() === b?.toLowerCase();
const hasLabel = (item, name) => item.labels.some(label => (label.name ?? label) === name);
const assignedTo = (issue, user) => issue.assignees.some(a => sameUser(a.login, user));
const time = value => Date.parse(value) || 0;

// Only explicit references to this repository count. Ignore template examples,
// comments, code fences and quoted text, including shell commands in PR bodies.
function issueLinks(body, repository) {
  const visible = (body ?? '').replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
    .replace(/`[^`\n]*`/g, '').replace(/^(?: {4}|\t|\s*>).*$/gm, '');
  const pattern = /\b(fix(?:es|ed)?|close[sd]?|resolve[sd]?|refs):?\s+<?(?:#([1-9]\d*)|(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:\/issues\/|#)([1-9]\d*))(?=$|[\s,.;)>])/gi;
  const links = new Map();
  for (const match of visible.matchAll(pattern)) {
    if (match[3] && match[3].toLowerCase() !== repository.toLowerCase()) continue;
    const number = Number(match[2] ?? match[4]);
    if (!Number.isSafeInteger(number)) continue;
    const closes = match[1].toLowerCase() !== 'refs';
    links.set(number, { number, closes: closes || links.get(number)?.closes || false });
  }
  return [...links.values()];
}

function assignmentProblem(issue, user, assignments, policy = config) {
  if (issue.state !== 'open') return 'This issue is closed.';
  if (hasLabel(issue, policy.needsTriageLabel)) return 'Please wait for a maintainer to triage this issue.';
  if (issue.assignees.length) return 'This issue already has an assignee. Please coordinate with them first.';
  const active = assignments.filter(i => !i.pull_request && i.state === 'open' && assignedTo(i, user));
  if (active.length >= policy.maxAssignments) return `You already have ${policy.maxAssignments} active issue assignments. Finish or release one first.`;
  for (const label of policy.beginnerLabels) {
    if (hasLabel(issue, label) && active.filter(i => hasLabel(i, label)).length >= policy.maxBeginnerAssignmentsPerLabel) {
      return `Please finish or release an existing "${label}" assignment first (limit: ${policy.maxBeginnerAssignmentsPerLabel}).`;
    }
  }
  return '';
}

function changesRequested(reviews) {
  const latest = new Map();
  for (const review of [...reviews].sort((a, b) => a.id - b.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) {
      latest.set(review.user.login.toLowerCase(), review);
    }
  }
  return [...latest.values()].filter(r => r.state === 'CHANGES_REQUESTED');
}

function assignmentActivity(events, comments, user) {
  const assignments = events.filter(e => e.event === 'assigned' && sameUser(e.assignee?.login, user));
  const assignedAt = Math.max(0, ...assignments.map(e => time(e.created_at)));
  // Do not expire assignments whose starting time could not be established.
  if (!assignedAt) return 0;
  return Math.max(assignedAt, ...comments.filter(c => sameUser(c.user.login, user) && c.user.type !== 'Bot')
    .map(c => time(c.updated_at ?? c.created_at)));
}

async function run({ github, context, core, start, now = Date.now() }) {
  const startsAt = time(start);
  if (!startsAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(start) ||
    new Date(startsAt).toISOString() !== start.replace(/(?<!\.\d{3})Z$/, '.000Z')) {
    throw new Error('POLICY_START must be a valid ISO UTC timestamp, e.g. 2026-12-01T00:00:00Z');
  }
  if (now < startsAt) return;
  const repo = context.repo;
  const repository = `${repo.owner}/${repo.repo}`;
  const url = `https://github.com/${repository}`;
  const api = github.rest;
  const issuesEnabled = context.payload.repository?.has_issues !== false;
  const list = (endpoint, args) => github.paginate(endpoint, { ...repo, per_page: 100, ...args });
  const getIssue = async number => (await api.issues.get({ ...repo, issue_number: number })).data;
  const getPR = async number => (await api.pulls.get({ ...repo, pull_number: number })).data;
  const comments = number => list(api.issues.listComments, { issue_number: number });
  const events = number => list(api.issues.listEventsForTimeline, { issue_number: number });
  let openPRSnapshot;
  const openPRs = async (refresh = false) => {
    if (refresh || !openPRSnapshot) {
      openPRSnapshot = await list(api.pulls.list, { state: 'open', sort: 'created', direction: 'asc' });
    }
    return openPRSnapshot;
  };
  const latestAssignment = async (number, user) => (await events(number))
    .filter(e => ['assigned', 'unassigned'].includes(e.event) && sameUser(e.assignee?.login, user))
    .sort((a, b) => b.id - a.id)[0];
  const errors = [];
  async function attempt(description, work) {
    try { await work(); } catch (error) { errors.push(new Error(`${description}: ${error.message}`, { cause: error })); }
  }
  const permissionCache = new Map();
  async function maintainer(login) {
    if (!permissionCache.has(login)) {
      const { data } = await api.repos.getCollaboratorPermissionLevel({ ...repo, username: login });
      permissionCache.set(login, ['admin', 'maintain', 'write'].includes(data.permission));
    }
    return permissionCache.get(login);
  }
  const botComment = (comment, marker) => comment.user.login === BOT && comment.user.type === 'Bot' && comment.body?.startsWith(marker);
  async function say(number, key, text) {
    const marker = `<!-- kubescape-policy:${key} -->`;
    const previous = (await comments(number)).find(c => botComment(c, marker));
    const body = `${marker}\n${text}`;
    if (previous) {
      if (previous.body !== body) await api.issues.updateComment({ ...repo, comment_id: previous.id, body });
    } else {
      await api.issues.createComment({ ...repo, issue_number: number, body });
    }
  }
  async function addLabel(number, label) {
    if (!hasLabel(await getIssue(number), label)) await api.issues.addLabels({ ...repo, issue_number: number, labels: [label] });
  }
  async function removeLabel(number, label) {
    if (!hasLabel(await getIssue(number), label)) return;
    try { await api.issues.removeLabel({ ...repo, issue_number: number, name: label }); } catch (error) {
      if (error.status !== 404) throw error; // Already removed by someone else.
    }
  }
  // The Assigned label mirrors the live assignee list. Always read the issue:
  // an event payload may describe an assignment that has since changed.
  async function syncAssignedLabel(number) {
    const current = await getIssue(number);
    if (current.pull_request) return;
    if (current.assignees.length) await addLabel(number, config.assignedLabel);
    else await removeLabel(number, config.assignedLabel);
  }
  async function ensureTriage(number) {
    const issue = await getIssue(number);
    // Templates may already have added the label. Maintainer-authored issues
    // are triaged by their author, including when another event arrives first.
    if (!issue.pull_request && issue.state === 'open' && time(issue.created_at) >= startsAt && await maintainer(issue.user.login)) {
      await removeLabel(number, config.needsTriageLabel);
      return getIssue(number);
    }
    if (issue.pull_request || issue.state !== 'open' || time(issue.created_at) < startsAt || hasLabel(issue, config.needsTriageLabel)) return issue;
    // Label absence alone is not triage: the opened event may still be queued.
    if (!(await events(number)).some(e => e.event === 'unlabeled' && e.label?.name === config.needsTriageLabel)) {
      await addLabel(number, config.needsTriageLabel);
    }
    return getIssue(number);
  }
  async function unassign(number, user, guard = async () => true, finalGuard = async () => true) {
    if (!await guard()) return false;
    const issue = await getIssue(number);
    if (!await finalGuard(issue)) return false;
    if (assignedTo(issue, user)) await api.issues.removeAssignees({ ...repo, issue_number: number, assignees: [user] });
    // The release already happened. A label failure is reported at the end of the
    // run and repaired by the scheduled reconciliation; it must not hide the release.
    await attempt(`Assigned label sync for #${number}`, () => syncAssignedLabel(number));
    return true;
  }
  async function handleCommand(payload) {
    if (payload.issue.pull_request || payload.comment.user.type === 'Bot') return;
    // Read the current comment: queued runs must not execute an edited-away command.
    let comment;
    try { ({ data: comment } = await api.issues.getComment({ ...repo, comment_id: payload.comment.id })); } catch (error) {
      if (error.status === 404) return; // The author deleted a queued command.
      throw error;
    }
    const match = comment.body.trim().match(/^\/(assign-me|unassign-me|assign\s+@([\w-]+)|unassign\s+@([\w-]+))$/);
    if (!match) return;
    const number = payload.issue.number;
    const key = `command-${comment.id}`;
    if ((await comments(number)).some(c => botComment(c, `<!-- kubescape-policy:${key} -->`))) {
      // A rerun after a partial failure must still repair the label for a release
      // that was already confirmed.
      if (match[1].startsWith('unassign')) await syncAssignedLabel(number);
      return;
    }
    const actor = comment.user.login;
    const manual = Boolean(match[2] || match[3]);
    if (manual && !await maintainer(actor)) {
      await say(number, key, 'Only maintainers can assign or unassign other contributors.');
      return;
    }
    const user = match[2] ?? match[3] ?? actor;
    if (match[1] === 'assign-me' || (match[2] && sameUser(user, actor))) {
      await say(number, key, 'Self-assignment is not allowed. Please ask another maintainer to assign you after triage.');
      return;
    }
    if (match[1].startsWith('unassign')) {
      const wasAssigned = assignedTo(await getIssue(number), user);
      if (wasAssigned) await unassign(number, user);
      else await attempt(`Assigned label sync for #${number}`, () => syncAssignedLabel(number));
      // Never claim a release (or ping the user) when there was nothing to release.
      await say(number, key, wasAssigned ? `@${user}, your assignment has been released.`
        : `@${actor}, ${sameUser(user, actor) ? 'you are' : `${user} is`} not assigned to this issue.`);
      return;
    }
    const issue = await ensureTriage(number);
    if (assignedTo(issue, user)) {
      await addLabel(number, config.assignedLabel);
      await say(number, key, `@${user}, you are already assigned.`);
      return;
    }
    const problem = assignmentProblem(issue, user, await list(api.issues.listForRepo, { state: 'open', assignee: user }));
    if (problem) {
      await say(number, key, `@${actor}, ${problem}`);
      return;
    }
    await api.issues.addAssignees({ ...repo, issue_number: number, assignees: [user] });
    await addLabel(number, config.assignedLabel);
    await say(number, key, `@${user}, assigned. Please share progress or open a linked draft PR. Without progress you will get a reminder after ${config.inactivityReminderDays} days, and the assignment may be released after ${config.inactivityExpiryDays} days, at least ${config.reminderToActionDays} days after that reminder. Use /unassign-me if you cannot continue.`);
  }
  async function releaseClosedPR(pr) {
    if (pr.state !== 'closed' || pr.merged || time(pr.created_at) < startsAt || pr.user.type === 'Bot' || await maintainer(pr.user.login)) return;
    const others = await openPRs();
    for (const { number, closes } of issueLinks(pr.body, repository)) {
      if (!closes || others.some(p => sameUser(p.user.login, pr.user.login) && issueLinks(p.body, repository).some(l => l.number === number))) continue;
      let issue;
      try { issue = await getIssue(number); } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }
      if (issue.pull_request || issue.state !== 'open') continue;
      if (!assignedTo(issue, pr.user.login)) {
        if (!issue.assignees.length) await removeLabel(number, config.assignedLabel);
        continue;
      }
      const assignment = await latestAssignment(number, pr.user.login);
      if (!assignment || assignment.event !== 'assigned' || time(assignment.created_at) < startsAt || time(assignment.created_at) > time(pr.closed_at)) continue;
      if (!await unassign(number, pr.user.login, async () => (await latestAssignment(number, pr.user.login))?.id === assignment.id)) continue;
      await say(number, `closed-${pr.number}`, `@${pr.user.login}, your assignment was released because #${pr.number} closed without merging. Ask a maintainer if you want to resume.`);
    }
  }
  // A bot-written record of one inactivity closure. It is what later proves that
  // the bot, not a person, closed the PR and which fixing issues were assigned to
  // its author at that moment. Contributors cannot write or edit bot comments.
  const recordPrefix = '<!-- kubescape-policy:stale-closure-';
  const recordText = data => `<!-- policy-data ${JSON.stringify(data)} -->\nRecord for @${data.user}: this PR was closed by the policy bot for inactivity. If you reopen it while the linked issue is still open, triaged, unassigned and nobody else has an eligible PR for it, the assignment can be restored automatically.`;
  async function closePR(pr, reason, stillValid = async () => true, recordKey = '') {
    const canClose = async () => {
      const current = await getPR(pr.number);
      return current.state === 'open' && current.head.sha === pr.head.sha && current.body === pr.body && !hasLabel(current, config.pinnedLabel) && await stillValid(current);
    };
    if (!await canClose()) return;
    // Durable retry marker: token-authored closes do not start another run.
    await addLabel(pr.number, config.cleanupLabel);
    await say(pr.number, 'closure', `${reason}\n\nSee the [contribution guide](https://github.com/kubescape/project-governance/blob/main/CONTRIBUTING.md).`);
    if (!await canClose()) { await removeLabel(pr.number, config.cleanupLabel); return; }
    let record;
    if (recordKey) {
      record = { user: pr.user.login, issues: [], closed: null };
      for (const { number, closes } of issueLinks(pr.body, repository)) {
        if (!closes) continue;
        try { if (assignedTo(await getIssue(number), pr.user.login)) record.issues.push(number); } catch (error) { if (error.status !== 404) throw error; }
      }
      await say(pr.number, recordKey, recordText(record)); // Pending: not yet tied to a closure.
    }
    const { data: closed } = await api.pulls.update({ ...repo, pull_number: pr.number, state: 'closed' });
    // Tie the record to this exact closure. If this write fails the record stays
    // pending and recovery is simply unavailable: reported, never unsafe.
    if (record) await attempt(`Closure record for #${pr.number}`, () => say(pr.number, recordKey, recordText({ ...record, closed: closed.closed_at })));
    // Keep the cached list consistent before checking duplicates or releasing
    // assignments. Do not paginate the entire repository after each closure.
    if (openPRSnapshot) openPRSnapshot = openPRSnapshot.filter(p => p.number !== pr.number);
    await releaseClosedPR(await getPR(pr.number));
    await removeLabel(pr.number, config.cleanupLabel);
  }
  // Everything about one linked issue except duplicate detection, so a PR's
  // eligibility never depends on other PRs. `fetchIssue` decides whether triage
  // may be completed (the PR under validation) or the issue is only read.
  async function assessLink(pr, link, fetchIssue) {
    const result = { failures: [], closures: [], issue: null, available: false, unassigned: false };
    let issue;
    try { issue = await fetchIssue(link.number); } catch (error) {
      if (error.status !== 404) throw error;
      result.failures.push(`Issue #${link.number} does not exist in this repository.`);
      return result;
    }
    result.issue = issue;
    if (issue.pull_request) { result.failures.push(`#${link.number} is a PR, not an issue.`); return result; }
    if (issue.state !== 'open') result.failures.push(`Issue #${link.number} is closed.`);
    if (hasLabel(issue, config.needsTriageLabel)) {
      result.failures.push(`Issue #${link.number} needs maintainer triage.`);
      if (link.closes) result.closures.push(`Issue #${link.number} needs maintainer triage before a fixing PR can be reviewed. Please wait for triage and assignment, then reopen this PR.`);
    }
    if (!assignedTo(issue, pr.user.login)) {
      const reason = `You are not assigned to issue #${link.number}. Please ask a maintainer to assign you before this check can pass. Reopening does not assign you by itself: only a PR that the bot closed for inactivity can have its assignment restored automatically, and only when the issue is still free. Otherwise ask a maintainer to assign you.`;
      result.failures.push(reason);
      if (link.closes) { result.closures.push(reason); result.unassigned = true; }
    } else if (issue.state === 'open' && !hasLabel(issue, config.needsTriageLabel)) {
      result.available = true;
    }
    return result;
  }
  // A PR may block a later PR only if it would pass every non-duplicate check.
  async function eligible(pr) {
    if (pr.state !== 'open') return false;
    const links = issueLinks(pr.body, repository);
    if (!links.length) return false;
    for (const link of links) {
      if ((await assessLink(pr, link, getIssue)).failures.length) return false;
    }
    return true;
  }
  async function assessLinks(pr) {
    const failures = [];
    const closures = [];
    const unassigned = [];
    const links = issueLinks(pr.body, repository);
    if (!links.length) failures.push('Link the issue with `Fixes #number` (or `Refs #number` for partial work).');
    let candidates;
    for (const link of links) {
      const assessment = await assessLink(pr, link, ensureTriage);
      failures.push(...assessment.failures);
      closures.push(...assessment.closures);
      if (assessment.unassigned) unassigned.push(link.number);
      if (!assessment.available) continue;
      candidates ??= await openPRs();
      // Earlier open PRs by current assignees are only candidates. A candidate
      // blocks this PR when it is itself eligible; ordering by number keeps the
      // surviving PR deterministic whatever order events are processed in.
      const possibleDuplicates = candidates.filter(other => other.number < pr.number &&
        assignedTo(assessment.issue, other.user.login) &&
        issueLinks(other.body, repository).some(l => l.number === link.number))
        .sort((a, b) => a.number - b.number);
      let duplicate;
      for (const snapshot of possibleDuplicates) {
        const current = await getPR(snapshot.number);
        if (current.state === 'open' && assignedTo(assessment.issue, current.user.login) &&
            issueLinks(current.body, repository).some(l => l.number === link.number) && await eligible(current)) {
          duplicate = current;
          break;
        }
      }
      if (duplicate) {
        const reason = `Issue #${link.number} already has an open PR from a current assignee: #${duplicate.number}. Please continue there instead of opening a duplicate.`;
        failures.push(reason);
        closures.push(reason);
      }
    }
    return { failures, closures, unassigned };
  }
  // Controlled recovery for a PR the bot closed for inactivity and its author reopened.
  // Everything is decided from bot-written records and the live issue state, never
  // from contributor-controlled text. Returns true only when the assignment was restored.
  async function recoverAssignment(pr, targets) {
    const user = pr.user.login;
    const timeline = await events(pr.number);
    const byTime = (a, b) => time(a.created_at) - time(b.created_at) || (a.id ?? 0) - (b.id ?? 0);
    const closedEvent = timeline.filter(e => e.event === 'closed').sort(byTime).at(-1);
    // The latest closure must be the bot's own, and the author must have reopened it afterwards.
    if (!closedEvent || closedEvent.actor?.login !== BOT) return false;
    const reopened = timeline.filter(e => e.event === 'reopened' && time(e.created_at) >= time(closedEvent.created_at)).sort(byTime).at(-1);
    if (!reopened || !sameUser(reopened.actor?.login, user)) return false;
    const discussion = await comments(pr.number);
    const records = discussion.filter(c => c.user.login === BOT && c.user.type === 'Bot' && c.body?.startsWith(recordPrefix)).map(c => {
      try { return JSON.parse(c.body.match(/<!-- policy-data (\{.*\}) -->/)?.[1]); } catch { return null; }
    });
    // The record must name this author and this very closure (not an earlier cycle's).
    const record = records.find(r => r && sameUser(r.user, user) && Array.isArray(r.issues) && time(r.closed) > 0 && Math.abs(time(r.closed) - time(closedEvent.created_at)) <= 5000);
    if (!record) return false;
    const key = `stale-recovery-${time(closedEvent.created_at)}`;
    // One attempt per closure: a repeated event, or a later unassignment by a maintainer, is never overridden.
    if (discussion.some(c => botComment(c, `<!-- kubescape-policy:${key} -->`))) return false;
    const refuse = async reason => {
      await say(pr.number, key, `@${user}, your assignment could not be restored automatically: ${reason} Once that is resolved, ask a maintainer to assign you, then reopen this PR.`);
      return false;
    };
    const unrecorded = targets.find(n => !record.issues.includes(n));
    if (unrecorded) return refuse(`you were not assigned to #${unrecorded} when this PR was closed.`);
    // Every condition is evaluated on the live state, and again immediately before each write.
    async function problem(number) {
      const assignments = await list(api.issues.listForRepo, { state: 'open', assignee: user });
      const current = await getPR(pr.number);
      if (current.state !== 'open' || current.head.sha !== pr.head.sha || current.body !== pr.body) return 'this PR changed while it was being checked.';
      for (const other of await openPRs(true)) {
        if (other.number === pr.number || !issueLinks(other.body, repository).some(l => l.number === number)) continue;
        if (await eligible(await getPR(other.number))) return `#${other.number} is already an eligible PR for #${number}.`;
      }
      // The issue itself is read last, so the decision uses the freshest possible state.
      let issue;
      try { issue = await getIssue(number); } catch (error) {
        if (error.status === 404) return `#${number} does not exist.`;
        throw error;
      }
      if (issue.pull_request) return `#${number} is a PR, not an issue.`;
      const blocked = assignmentProblem(issue, user, assignments.filter(i => i.number !== number));
      return blocked ? `#${number}: ${blocked}` : '';
    }
    // The PR must satisfy every other requirement once the assignment exists.
    const hypothetical = async n => {
      const issue = await getIssue(n);
      return targets.includes(n) ? { ...issue, assignees: [...issue.assignees, { login: user }] } : issue;
    };
    const links = issueLinks(pr.body, repository);
    if (!links.length) return refuse('this PR does not link an issue.');
    for (const link of links) {
      const result = await assessLink(pr, link, hypothetical);
      if (result.failures.length) return refuse(result.failures[0]);
    }
    for (const number of targets) {
      const blocked = await problem(number);
      if (blocked) return refuse(blocked);
    }
    const restored = [];
    // All or nothing: whatever fails part-way (a refusal, a dropped assignee or an API error),
    // every issue restored so far is released again. Each release is attempted independently,
    // so one failing call cannot stop the others; failures are reported at the end of the run.
    const rollback = async () => {
      for (const earlier of restored.splice(0)) {
        await attempt(`Rollback of the assignment to #${earlier}`, () => api.issues.removeAssignees({ ...repo, issue_number: earlier, assignees: [user] }));
        await attempt(`Assigned label sync for #${earlier}`, () => syncAssignedLabel(earlier));
      }
    };
    let failure = '';
    try {
      for (const number of targets) {
        const blocked = await problem(number); // immediately before the write
        if (blocked) { failure = blocked; break; }
        const { data } = await api.issues.addAssignees({ ...repo, issue_number: number, assignees: [user] });
        // GitHub silently drops assignees it will not accept.
        if (!assignedTo(data, user)) { failure = `GitHub did not assign you to #${number}.`; break; }
        restored.push(number);
      }
    } catch (error) {
      await rollback();
      throw error; // No outcome is recorded, so the next run retries from a clean or converging state.
    }
    if (failure) {
      await rollback();
      return refuse(failure);
    }
    for (const number of restored) await attempt(`Assigned label sync for #${number}`, () => syncAssignedLabel(number));
    await say(pr.number, key, `@${user}, your assignment to ${restored.map(n => `#${n}`).join(', ')} has been restored because the bot closed this PR for inactivity and you reopened it. Your response window starts again now (reminder after ${config.inactivityReminderDays} days, closure after ${config.inactivityExpiryDays}). All other policy checks, including duplicate PR detection, still apply.`);
    return true;
  }
  const checkedHeads = new Set();
  async function checkPR(number) {
    const pr = await getPR(number);
    if (pr.state !== 'open') {
      if (pr.merged || time(pr.created_at) < startsAt || pr.user.type === 'Bot' || await maintainer(pr.user.login)) return;
      await addLabel(pr.number, config.cleanupLabel);
      await releaseClosedPR(pr);
      await removeLabel(pr.number, config.cleanupLabel);
      return;
    }
    if (checkedHeads.has(pr.head.sha)) return;
    checkedHeads.add(pr.head.sha);
    // Checks are commit-scoped too. Aggregate every open PR sharing this head;
    // an exempt or valid sibling must never overwrite an invalid PR's result.
    const externalId = 'kubescape-contribution-policy-v2';
    const runs = await list(api.checks.listForRef, { ref: pr.head.sha, check_name: CHECK, filter: 'all' });
    const existing = runs.filter(c => c.external_id === externalId && c.app?.slug === 'github-actions').sort((a, b) => b.id - a.id)[0];
    const pending = { status: 'completed', conclusion: 'failure', output: { title: 'Policy revalidation incomplete', summary: 'Checking every open PR sharing this commit. API failures leave this check failing.' } };
    const check = existing
      ? (await api.checks.update({ ...repo, check_run_id: existing.id, ...pending })).data
      : (await api.checks.create({ ...repo, name: CHECK, head_sha: pr.head.sha, external_id: externalId, details_url: `${url}/pull/${pr.number}`, ...pending })).data;
    const results = [];
    for (const snapshot of await openPRs()) {
      if (snapshot.head.sha !== pr.head.sha) continue;
      const current = await getPR(snapshot.number);
      if (current.state !== 'open' || current.head.sha !== pr.head.sha) continue;
      const exempt = !issuesEnabled || time(current.created_at) < startsAt || current.user.type === 'Bot' || await maintainer(current.user.login);
      let assessment = exempt ? { failures: [], closures: [], unassigned: [] } : await assessLinks(current);
      // About to close for a missing assignment: a PR the bot closed for inactivity may qualify for recovery.
      // An API failure here aborts the check (the PR stays open and failing) rather than closing it.
      if (assessment.unassigned.length && await recoverAssignment(current, assessment.unassigned)) assessment = await assessLinks(current);
      results.push({ pr: current, ...assessment });
    }
    const failed = results.some(r => r.failures.length);
    await api.checks.update({ ...repo, check_run_id: check.id, status: 'completed', conclusion: failed ? 'failure' : 'success',
      output: { title: failed ? 'Contribution policy needs attention' : 'Contribution policy passed',
        summary: results.map(r => `#${r.pr.number}: ${r.failures.length ? r.failures.join(' ') : 'Passed or exempt.'}`).join('\n\n').slice(0, 65000) || 'No open PRs remain on this commit.' } });
    for (const { pr: current, failures, closures } of results) {
      await attempt(`PR #${current.number} follow-up`, async () => {
        if (failures.length) await say(current.number, 'check', failures.join('\n\n'));
        else if ((await comments(current.number)).some(c => botComment(c, '<!-- kubescape-policy:check -->'))) await say(current.number, 'check', 'The issue triage, assignment and duplicate PR checks now pass.');
        if (closures.length) {
          const reason = closures[0];
          await closePR(current, reason, async fresh => (await assessLinks(fresh)).closures.includes(reason));
        }
      });
    }
  }
  // Keep the Assigned label equal to "has at least one assignee" for open issues.
  async function reconcileAssignedLabels() {
    const listed = [...await list(api.issues.listForRepo, { state: 'open', labels: config.assignedLabel }),
      ...await list(api.issues.listForRepo, { state: 'open', assignee: '*' })];
    // The listings only select candidates; syncAssignedLabel decides from live state.
    const wrong = new Set(listed.filter(i => !i.pull_request && (i.assignees.length > 0) !== hasLabel(i, config.assignedLabel)).map(i => i.number));
    for (const number of wrong) await attempt(`Assigned label sync for #${number}`, () => syncAssignedLabel(number));
  }
  const reminderGate = (reminder, notBefore) => {
    // A reminder only counts when GitHub's own timestamp for it is valid and not
    // earlier than the cycle it belongs to. Anything else is unknown state.
    const sentAt = time(reminder?.created_at);
    return sentAt > 0 && sentAt >= notBefore ? sentAt : 0;
  };
  // A destructive action needs both the inactivity period and a full gap after
  // the reminder. A late reminder therefore postpones the action.
  const actionDue = (since, reminderAt) => now - since >= config.inactivityExpiryDays * DAY &&
    now - reminderAt >= config.reminderToActionDays * DAY;
  async function expireAssignments(prs) {
    const issues = await list(api.issues.listForRepo, { state: 'open', labels: config.assignedLabel });
    for (const snapshot of issues.filter(i => !i.pull_request)) {
      const issue = await getIssue(snapshot.number);
      if (hasLabel(issue, config.pinnedLabel)) continue;
      const timeline = await events(issue.number);
      const discussion = await comments(issue.number);
      for (const assignee of issue.assignees) {
        if (await maintainer(assignee.login)) continue;
        const hasLinkedPR = open => open.some(p => sameUser(p.user.login, assignee.login) &&
          issueLinks(p.body, repository).some(l => l.number === issue.number));
        if (hasLinkedPR(prs)) continue;
        const assignedAt = Math.max(0, ...timeline.filter(e => e.event === 'assigned' && sameUser(e.assignee?.login, assignee.login)).map(e => time(e.created_at)));
        if (assignedAt < startsAt) continue;
        const activity = assignmentActivity(timeline, discussion, assignee.login);
        if (!activity || activity < startsAt) continue;
        // The activity time identifies the cycle: qualifying activity starts a new
        // cycle with no reminder, so one cycle never produces two reminders.
        const key = `assignment-reminder-${assignee.login}-${activity}`;
        const reminder = discussion.find(c => botComment(c, `<!-- kubescape-policy:${key} -->`));
        if (!reminder) {
          if (now - activity >= config.inactivityReminderDays * DAY) {
            await say(issue.number, key, `@${assignee.login}, please share an update or open a linked draft PR. Without progress, this assignment may be released after ${config.inactivityExpiryDays} days of inactivity, at least ${config.reminderToActionDays} days after this reminder. Ask a maintainer to pin this issue if you need more time.`);
          }
          continue;
        }
        const reminderAt = reminderGate(reminder, activity);
        if (!reminderAt || !actionDue(activity, reminderAt)) continue;
        const stillIdle = async latest => latest.state === 'open' && !hasLabel(latest, config.pinnedLabel) && assignedTo(latest, assignee.login) &&
          assignmentActivity(await events(issue.number), await comments(issue.number), assignee.login) === activity;
        // Read the issue, its activity and the open PRs again immediately before
        // releasing: new progress, a pin or a linked PR may have arrived since the
        // run's snapshots were taken.
        const released = await unassign(issue.number, assignee.login, undefined,
          async latest => await stillIdle(latest) && !hasLinkedPR(await openPRs(true)));
        if (!released) continue;
        await say(issue.number, `expired-${assignee.login}-${activity}`, `@${assignee.login}, this assignment was released after ${config.inactivityExpiryDays} days of inactivity. If the issue is still open and unassigned, ask a maintainer to assign you again if you want to continue.`);
      }
    }
  }
  // Who must act next on a PR with an outstanding change request: the contributor
  // (inside a response window) or the reviewer (waiting for review). Only the most
  // recent valid request matters; earlier ones do not extend or shorten its window.
  async function reviewState(pr) {
    const reviews = await list(api.pulls.listReviews, { pull_number: pr.number });
    const requests = [];
    for (const review of changesRequested(reviews)) {
      if (review.user.type !== 'Bot' && await maintainer(review.user.login)) requests.push(review);
    }
    if (!requests.length) return null;
    const request = requests.reduce((a, b) => (time(b.submitted_at) - time(a.submitted_at) || b.id - a.id) > 0 ? b : a);
    const requestedAt = time(request.submitted_at);
    const discussion = await comments(pr.number);
    const inline = await list(api.pulls.listReviewComments, { pull_number: pr.number });
    // Only the author's own comments, inline replies and reviews count. Bots, other
    // users, label changes and edits to PR metadata never answer a request.
    const wrote = [...discussion, ...inline].some(c => sameUser(c.user?.login, pr.user.login) && time(c.created_at) > requestedAt) ||
      reviews.some(r => sameUser(r.user?.login, pr.user.login) && time(r.submitted_at) > requestedAt);
    // A push shows as a head commit different from the one that was reviewed.
    const pushed = Boolean(request.commit_id) && request.commit_id !== pr.head.sha;
    const reopenedAt = Math.max(0, ...(await events(pr.number)).filter(e => e.event === 'reopened').map(e => time(e.created_at)));
    return { request, requestedAt, discussion, responded: wrote || pushed, known: Boolean(requestedAt && request.commit_id),
      windowStart: Math.max(requestedAt, reopenedAt) };
  }
  async function expirePR(snapshot) {
    const pr = await getPR(snapshot.number);
    if (pr.state !== 'open' || time(pr.created_at) < startsAt || pr.user.type === 'Bot' || await maintainer(pr.user.login) || hasLabel(pr, config.pinnedLabel)) return;
    const state = await reviewState(pr);
    // No outstanding request, or the contributor has responded and the next move
    // is the reviewer's: nothing here may close the PR for contributor inactivity.
    if (!state || state.responded || !state.requestedAt) { await removeLabel(pr.number, config.staleLabel); return; }
    const key = `pr-reminder-${state.request.id}-${state.windowStart}`;
    const reminder = state.discussion.find(c => botComment(c, `<!-- kubescape-policy:${key} -->`));
    if (!reminder) {
      if (now - state.windowStart < config.inactivityReminderDays * DAY) {
        await removeLabel(pr.number, config.staleLabel); // Left over from an earlier cycle.
        return;
      }
      // The reminder must exist before the label or any later closure.
      await say(pr.number, key, `The requested changes have had no response for ${config.inactivityReminderDays} days. Please push an update or reply. Without a response this PR may be closed after ${config.inactivityExpiryDays} days of inactivity, at least ${config.reminderToActionDays} days after this reminder. A PR waiting for maintainer review is not closed.`);
      await addLabel(pr.number, config.staleLabel);
      return;
    }
    const reminderAt = reminderGate(reminder, state.windowStart);
    // Without a verifiable reviewed commit a push cannot be ruled out: do not close.
    if (!reminderAt || !state.known || !actionDue(state.windowStart, reminderAt)) return;
    await closePR(pr, `Closing because the requested changes received no response for ${config.inactivityExpiryDays} days, including ${config.reminderToActionDays} days after the reminder.\n\nTo continue, reopen this PR. If the linked issue is still open, triaged and unassigned, you are under the assignment limit and no other eligible PR exists for it, your assignment is restored automatically and a new response window starts (reminder after ${config.inactivityReminderDays} days, closure after ${config.inactivityExpiryDays}). Otherwise you will be told why; ask a maintainer to assign you, or coordinate with the current assignee.`, async current => {
      const latest = await reviewState(current);
      return Boolean(latest && !latest.responded && latest.known && latest.request.id === state.request.id &&
        latest.windowStart === state.windowStart && actionDue(latest.windowStart, reminderAt) &&
        latest.discussion.some(c => botComment(c, `<!-- kubescape-policy:${key} -->`)));
    }, `stale-closure-${state.request.id}-${state.windowStart}`);
  }

  const { payload, eventName } = context;
  if (eventName === 'issues' && payload.action === 'opened') {
    if (time(payload.issue.created_at) >= startsAt) {
      await ensureTriage(payload.issue.number);
    }
  }
  if (eventName === 'issue_comment') await handleCommand(payload);
  if (eventName === 'issues' && (payload.action === 'unassigned' ||
    (['labeled', 'unlabeled'].includes(payload.action) && payload.label?.name === config.assignedLabel))) {
    // UI unassignments and manual label edits must not leave the label wrong.
    // The live issue decides: a newer assignment keeps the label.
    await attempt(`Assigned label sync for #${payload.issue.number}`, () => syncAssignedLabel(payload.issue.number));
  }
  if (eventName === 'issues' && payload.action === 'assigned') {
    const number = payload.issue.number;
    const target = payload.assignee?.login;
    const current = await ensureTriage(number);
    if (target && assignedTo(current, target)) {
      const timeline = await events(number);
      const latest = timeline.filter(e => ['assigned', 'unassigned'].includes(e.event) && sameUser(e.assignee?.login, target))
        .sort((a, b) => b.id - a.id)[0];
      // A queued event must not undo a newer assignment by another maintainer.
      if (latest?.event === 'assigned' && time(latest.created_at) >= startsAt && sameUser(latest.actor?.login, payload.sender?.login)) {
        const actor = latest.actor.login;
        let problem = '';
        if (sameUser(actor, target)) problem = 'Self-assignment is not allowed. Please ask another maintainer to assign you.';
        else if (actor !== BOT && !await maintainer(actor)) problem = 'Only maintainers can assign contributors.';
        else if (actor !== BOT) {
          const assignments = await list(api.issues.listForRepo, { state: 'open', assignee: target });
          problem = assignmentProblem({ ...current, assignees: [] }, target, assignments.filter(i => i.number !== number));
        }
        if (problem) {
          if (await unassign(number, target, async () => (await latestAssignment(number, target))?.id === latest.id)) {
            await say(number, `assignment-${latest.id}`, `@${target}, ${problem}`);
          }
        }
      }
      await syncAssignedLabel(number);
    }
  }
  if (eventName === 'pull_request_target') {
    // Reopening an inactive PR starts a new warning window. A queued event
    // must not edit a PR that has since been closed again.
    if (payload.action === 'reopened' && (await getPR(payload.pull_request.number)).state === 'open') {
      await removeLabel(payload.pull_request.number, config.staleLabel);
    }
    await checkPR(payload.pull_request.number);
    if (['opened', 'reopened', 'edited', 'closed'].includes(payload.action)) {
      // These events can change which PR is the eligible earliest one for an
      // issue, so every other open PR sharing a linked issue is validated again.
      const subject = await getPR(payload.pull_request.number);
      const linked = new Set([subject.body, payload.changes?.body?.from].flatMap(body => issueLinks(body, repository).map(l => l.number)));
      for (const other of await openPRs(true)) {
        if (other.number !== subject.number && issueLinks(other.body, repository).some(l => linked.has(l.number))) {
          await attempt(`PR #${other.number} duplicate revalidation`, () => checkPR(other.number));
        }
      }
    }
    if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('\n'));
    return;
  }
  const prs = await openPRs();
  const affectedIssue = payload.issue?.number;
  const linksOf = pr => issueLinks(pr.body, repository).map(l => l.number);
  // An issue event changes the eligibility of the PRs that link it, and eligibility
  // decides whether those PRs block others on their other issues. Revalidate PRs
  // sharing an issue with a directly affected PR as well.
  const direct = affectedIssue ? prs.filter(pr => linksOf(pr).includes(affectedIssue)) : prs;
  const related = new Set(direct.flatMap(linksOf));
  for (const pr of prs) {
    if (affectedIssue && !direct.includes(pr) && !linksOf(pr).some(number => related.has(number))) continue;
    await attempt(`PR #${pr.number}`, () => checkPR(pr.number));
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // Refresh once before expiry to include PRs opened during a long check run.
    // All checks share one listing; all expiry operations share this second one.
    const remaining = await openPRs(true);
    if (issuesEnabled) {
      await attempt('Assigned label reconciliation', reconcileAssignedLabels);
      await attempt('Assignment expiry', () => expireAssignments(remaining));
    }
    for (const pr of remaining) await attempt(`PR #${pr.number} expiry`, () => expirePR(pr));
    const cleanup = await list(api.issues.listForRepo, { state: 'all', labels: config.cleanupLabel });
    for (const item of cleanup.filter(i => i.pull_request)) {
      await attempt(`PR #${item.number} assignment cleanup`, async () => {
        await releaseClosedPR(await getPR(item.number));
        await removeLabel(item.number, config.cleanupLabel);
      });
    }
  }
  if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('\n'));
  core.info('Contribution policy processing completed.');
}

module.exports = { run, issueLinks, assignmentProblem, assignmentActivity, changesRequested };
