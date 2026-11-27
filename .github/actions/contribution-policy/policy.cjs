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
    if (hasLabel(await getIssue(number), label)) await api.issues.removeLabel({ ...repo, issue_number: number, name: label });
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
  async function unassign(number, user, guard = async () => true, protectPinned = false) {
    if (!await guard()) return false;
    const issue = await getIssue(number);
    if (protectPinned && (issue.state !== 'open' || hasLabel(issue, config.pinnedLabel))) return false;
    if (assignedTo(issue, user)) await api.issues.removeAssignees({ ...repo, issue_number: number, assignees: [user] });
    if (!(await getIssue(number)).assignees.length) await removeLabel(number, config.assignedLabel);
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
    if ((await comments(number)).some(c => botComment(c, `<!-- kubescape-policy:${key} -->`))) return;
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
      await unassign(number, user);
      await say(number, key, `@${user}, your assignment has been released.`);
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
    await say(number, key, `@${user}, assigned. Please share progress or open a linked draft PR. Inactive assignments receive a reminder after ${config.assignmentReminderDays} days and may be released after ${config.assignmentExpiryDays} days. Use /unassign-me if you cannot continue.`);
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
  async function closePR(pr, reason, eligible = async () => true) {
    const canClose = async () => {
      const current = await getPR(pr.number);
      return current.state === 'open' && current.head.sha === pr.head.sha && current.body === pr.body && !hasLabel(current, config.pinnedLabel) && await eligible(current);
    };
    if (!await canClose()) return;
    // Durable retry marker: token-authored closes do not start another run.
    await addLabel(pr.number, config.cleanupLabel);
    await say(pr.number, 'closure', `${reason}\n\nSee the [contribution guide](https://github.com/kubescape/project-governance/blob/main/CONTRIBUTING.md).`);
    if (!await canClose()) { await removeLabel(pr.number, config.cleanupLabel); return; }
    await api.pulls.update({ ...repo, pull_number: pr.number, state: 'closed' });
    // Keep the cached list consistent before checking duplicates or releasing
    // assignments. Do not paginate the entire repository after each closure.
    if (openPRSnapshot) openPRSnapshot = openPRSnapshot.filter(p => p.number !== pr.number);
    await releaseClosedPR(await getPR(pr.number));
    await removeLabel(pr.number, config.cleanupLabel);
  }
  async function assessLinks(pr) {
    const failures = [];
    const closures = [];
    const links = issueLinks(pr.body, repository);
    if (!links.length) failures.push('Link the issue with `Fixes #number` (or `Refs #number` for partial work).');
    let candidates;
    for (const link of links) {
      let issue;
      try { issue = await ensureTriage(link.number); } catch (error) {
        if (error.status !== 404) throw error;
        failures.push(`Issue #${link.number} does not exist in this repository.`);
        continue;
      }
      if (issue.pull_request) { failures.push(`#${link.number} is a PR, not an issue.`); continue; }
      if (issue.state !== 'open') failures.push(`Issue #${link.number} is closed.`);
      if (hasLabel(issue, config.needsTriageLabel)) {
        failures.push(`Issue #${link.number} needs maintainer triage.`);
        if (link.closes) closures.push(`Issue #${link.number} needs maintainer triage before a fixing PR can be reviewed. Please wait for triage and assignment, then reopen this PR.`);
      }
      if (!assignedTo(issue, pr.user.login)) {
        const reason = `You are not assigned to issue #${link.number}. Please ask a maintainer to assign you before this check can pass.`;
        failures.push(reason);
        if (link.closes) closures.push(reason);
      } else if (issue.state === 'open' && !hasLabel(issue, config.needsTriageLabel)) {
        candidates ??= await openPRs();
        // Keep the earliest open PR from a current assignee. An older PR by
        // someone without the assignment must not reserve the issue.
        const possibleDuplicates = candidates.filter(other => other.number < pr.number &&
          assignedTo(issue, other.user.login) &&
          issueLinks(other.body, repository).some(l => l.number === link.number))
          .sort((a, b) => a.number - b.number);
        let duplicate;
        for (const snapshot of possibleDuplicates) {
          const current = await getPR(snapshot.number);
          if (current.state === 'open' && assignedTo(issue, current.user.login) &&
              issueLinks(current.body, repository).some(l => l.number === link.number)) {
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
    }
    return { failures, closures };
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
      results.push({ pr: current, ...(exempt ? { failures: [], closures: [] } : await assessLinks(current)) });
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
  async function expireAssignments(prs) {
    const issues = await list(api.issues.listForRepo, { state: 'open', labels: config.assignedLabel });
    for (const snapshot of issues.filter(i => !i.pull_request)) {
      const issue = await getIssue(snapshot.number);
      if (hasLabel(issue, config.pinnedLabel)) continue;
      const timeline = await events(issue.number);
      const discussion = await comments(issue.number);
      for (const assignee of issue.assignees) {
        if (await maintainer(assignee.login)) continue;
        if (prs.some(p => sameUser(p.user.login, assignee.login) && issueLinks(p.body, repository).some(l => l.number === issue.number))) continue;
        const assignedAt = Math.max(0, ...timeline.filter(e => e.event === 'assigned' && sameUser(e.assignee?.login, assignee.login)).map(e => time(e.created_at)));
        if (assignedAt < startsAt) continue;
        const activity = assignmentActivity(timeline, discussion, assignee.login);
        if (!activity || activity < startsAt) continue;
        const age = (now - activity) / DAY;
        const key = `assignment-reminder-${assignee.login}-${activity}`;
        const warning = discussion.find(c => botComment(c, `<!-- kubescape-policy:${key} -->`));
        // A missed scheduled run must not release an assignment without a warning.
        if (age >= config.assignmentExpiryDays && warning && now - time(warning.created_at) >= DAY) {
          const current = await getIssue(issue.number);
          if (current.state !== 'open' || hasLabel(current, config.pinnedLabel) || !assignedTo(current, assignee.login)) continue;
          const currentActivity = assignmentActivity(await events(issue.number), await comments(issue.number), assignee.login);
          if (currentActivity !== activity) continue;
          if ((await openPRs()).some(p => sameUser(p.user.login, assignee.login) && issueLinks(p.body, repository).some(l => l.number === issue.number))) continue;
          if (!await unassign(issue.number, assignee.login, async () =>
            assignmentActivity(await events(issue.number), await comments(issue.number), assignee.login) === activity, true)) continue;
          await say(issue.number, `expired-${assignee.login}-${activity}`, `@${assignee.login}, this assignment was released after inactivity. Ask a maintainer to reassign you if you want to continue.`);
        } else if (age >= config.assignmentReminderDays && !warning) {
          await say(issue.number, key, `@${assignee.login}, please share an update or open a linked draft PR. Assignments may be released after ${config.assignmentExpiryDays} days without progress. Ask a maintainer to pin this issue if you need more time.`);
        }
      }
    }
  }
  async function requestedChangesActivity(pr) {
    const reviews = await list(api.pulls.listReviews, { pull_number: pr.number });
    const requests = [];
    for (const review of changesRequested(reviews)) {
      if (review.user.type !== 'Bot' && await maintainer(review.user.login)) requests.push(review);
    }
    if (!requests.length) return null;
    const discussion = await comments(pr.number);
    const inline = await list(api.pulls.listReviewComments, { pull_number: pr.number });
    const authorActivity = Math.max(0, ...[...discussion, ...inline].filter(c => sameUser(c.user.login, pr.user.login)).map(c => time(c.updated_at ?? c.created_at)),
      ...reviews.filter(r => sameUser(r.user.login, pr.user.login)).map(r => time(r.submitted_at)));
    const requestedAt = Math.max(...requests.map(r => time(r.submitted_at)));
    return { discussion, authorActivity, requestedAt };
  }
  async function expirePR(snapshot) {
    const pr = await getPR(snapshot.number);
    if (pr.state !== 'open' || time(pr.created_at) < startsAt || pr.user.type === 'Bot' || await maintainer(pr.user.login) || hasLabel(pr, config.pinnedLabel)) return;
    const activityState = await requestedChangesActivity(pr);
    if (!activityState) { await removeLabel(pr.number, config.staleLabel); return; }
    const { discussion, authorActivity, requestedAt } = activityState;
    const warningPrefix = `<!-- kubescape-policy:stale-${pr.head.sha}-`;
    const warning = discussion.filter(c => c.user.login === BOT && c.user.type === 'Bot' && c.body?.startsWith(warningPrefix)).sort((a, b) => b.id - a.id)[0];
    if (hasLabel(pr, config.staleLabel) && warning && authorActivity <= time(warning.created_at) && requestedAt <= time(warning.created_at)) {
      if (now - time(warning.created_at) >= config.stalePRCloseDays * DAY) {
        await closePR(pr, `Closing because the requested changes remained inactive for ${config.stalePRCloseDays} days after the reminder. You can reopen this PR when ready to continue.`, async current => {
          const latest = await requestedChangesActivity(current);
          return latest && latest.authorActivity <= time(warning.created_at) && latest.requestedAt <= time(warning.created_at);
        });
      }
      return;
    }
    if (hasLabel(pr, config.staleLabel)) {
      await removeLabel(pr.number, config.staleLabel);
      return; // Give resumed work a fresh inactivity window.
    }
    const activity = Math.max(time(pr.updated_at), authorActivity, requestedAt);
    if (now - activity < config.requestedChangesStaleDays * DAY) return;
    await say(pr.number, `stale-${pr.head.sha}-${activity}`, `The requested changes have been inactive for ${config.requestedChangesStaleDays} days. Please push an update or reply within ${config.stalePRCloseDays} days to keep this PR open.`);
    await addLabel(pr.number, config.staleLabel);
  }

  const { payload, eventName } = context;
  if (eventName === 'issues' && payload.action === 'opened') {
    if (time(payload.issue.created_at) >= startsAt) {
      await ensureTriage(payload.issue.number);
    }
  }
  if (eventName === 'issue_comment') await handleCommand(payload);
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
      if ((await getIssue(number)).assignees.length) await addLabel(number, config.assignedLabel);
    }
  }
  if (eventName === 'pull_request_target') {
    // Reopening an inactive PR starts a new warning window. A queued event
    // must not edit a PR that has since been closed again.
    if (payload.action === 'reopened' && (await getPR(payload.pull_request.number)).state === 'open') {
      await removeLabel(payload.pull_request.number, config.staleLabel);
    }
    await checkPR(payload.pull_request.number);
    if (errors.length) throw new AggregateError(errors, errors.map(e => e.message).join('\n'));
    return;
  }
  const prs = await openPRs();
  const affectedIssue = payload.issue?.number;
  for (const pr of prs) {
    if (affectedIssue && !issueLinks(pr.body, repository).some(l => l.number === affectedIssue)) continue;
    await attempt(`PR #${pr.number}`, () => checkPR(pr.number));
  }
  if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
    // Refresh once before expiry to include PRs opened during a long check run.
    // All checks share one listing; all expiry operations share this second one.
    const remaining = await openPRs(true);
    if (issuesEnabled) await attempt('Assignment expiry', () => expireAssignments(remaining));
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
