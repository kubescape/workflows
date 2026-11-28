'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, issueLinks, assignmentProblem, assignmentActivity, changesRequested } = require('../policy.cjs');
const config = require('../config.json');
const { fixture, DAY, epoch, date, user, label, issue, pr } = require('./fixture.cjs');

test('links accept closing variants and local URLs, excluding foreign repositories and examples', () => {
  const body = 'Resolved #1\nRefs #1\nCloses https://github.com/kubescape/kubescape/issues/2\nFixes kubescape/kubescape#3\nFixes other/repo#4\n<!-- Fixes #5 -->\n```sh\nFixes #6\n```\n> Fixes #7\n`Fixes #8`';
  assert.deepEqual(issueLinks(body, 'kubescape/kubescape'), [{ number: 1, closes: true }, { number: 2, closes: true }, { number: 3, closes: true }]);
  assert.deepEqual(issueLinks('Fixes #9abc; Refs #10', 'kubescape/kubescape'), [{ number: 10, closes: false }]);
});

test('third assignment is allowed, fourth is refused; closed issues and PRs do not consume slots', () => {
  const assigned = [1, 2, 3].map(n => issue(n, { assignees: [user('alice')] }));
  assert.equal(assignmentProblem(issue(9), 'alice', assigned.slice(0, 2)), '');
  assert.match(assignmentProblem(issue(9), 'alice', assigned), /3 active/);
  assigned[2].state = 'closed';
  assigned.push({ ...issue(4, { assignees: [user('alice')] }), pull_request: {} });
  assert.equal(assignmentProblem(issue(9), 'alice', assigned), '');
});

test('maintainer assignment still rejects untriaged or occupied issues', () => {
  for (const target of [issue(1, { labels: [label(config.needsTriageLabel)] }), issue(1, { assignees: [user('bob')] })]) {
    assert.notEqual(assignmentProblem(target, 'alice', []), '');
  }
  assert.equal(assignmentProblem(issue(1, { user: user('alice') }), 'alice', []), '');
});

test('beginner limits count open assignments with the same label', () => {
  const target = issue(9, { labels: [label('good first issue')] });
  const current = [1, 2].map(n => issue(n, { labels: [label('good first issue')], assignees: [user('alice')] }));
  assert.match(assignmentProblem(target, 'alice', current), /good first issue/);
  current[1].state = 'closed';
  assert.equal(assignmentProblem(target, 'alice', current), '');
});

test('dismissal and approval supersede requested changes; plain comments do not', () => {
  const reviews = [{ id: 1, user: user('r'), state: 'CHANGES_REQUESTED' }, { id: 2, user: user('r'), state: 'COMMENTED' }];
  assert.equal(changesRequested(reviews).length, 1);
  reviews[0].state = 'DISMISSED';
  assert.equal(changesRequested(reviews).length, 0);
});

test('reminder bot activity cannot extend an assignment', () => {
  const events = [{ event: 'assigned', assignee: user('alice'), created_at: date(1) }];
  assert.equal(assignmentActivity(events, [{ user: user('alice', 'Bot'), created_at: date(10) }], 'alice'), epoch + DAY);
  assert.equal(assignmentActivity(events, [{ user: user('alice'), updated_at: date(5) }], 'alice'), epoch + 5 * DAY);
});

test('queued commands use current issue labels instead of the event snapshot', async () => {
  const f = fixture({ issues: [issue(1)] });
  const comment = { id: 1, body: '/assign @alice', user: user('maintainer') };
  f.state.comments.set(1, [comment]);
  f.state.issues.get(1).labels.push(label(config.needsTriageLabel));
  await f.execute('issue_comment', { issue: issue(1), comment });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('command retries do not duplicate assignment or confirmation; fake bot markers do not suppress commands', async () => {
  const f = fixture({ issues: [issue(1)] });
  const payload = await f.command(1, '/assign @alice', 'maintainer');
  await f.execute('issue_comment', payload);
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
  assert.equal(f.state.comments.get(1).filter(c => c.user.type === 'Bot').length, 1);
  const g = fixture({ issues: [issue(1)] });
  g.state.comments.set(1, [{ id: 2, user: user('bob'), body: '<!-- kubescape-policy:command-100 -->' }]);
  await g.command(1, '/assign @alice', 'maintainer');
  assert.equal(g.state.issues.get(1).assignees[0].login, 'alice');
});

test('only maintainers can use manual assignment commands', async () => {
  const f = fixture({ issues: [issue(1)] });
  await f.command(1, '/assign @bob');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  await f.command(1, '/assign @bob', 'maintainer');
  assert.equal(f.state.issues.get(1).assignees[0].login, 'bob');
});

test('new issues get needs-triage even when created without a template', async () => {
  const f = fixture({ issues: [issue(1)] });
  f.state.events.set(1, []);
  await f.execute('issues', { action: 'opened', issue: issue(1) });
  assert.deepEqual(f.state.issues.get(1).labels, [label(config.needsTriageLabel)]);
});

test('PR with assigned triaged issue passes on the live head', async () => {
  const f = fixture({ prs: [pr()] });
  await f.execute('pull_request_target', { pull_request: pr(10, { head: { sha: 'old' } }) });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  assert.equal(f.state.checkWrites.at(-1).head_sha, 'a'.repeat(40));
});

test('fixing PR for an untriaged issue closes and releases only its own assignment', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.needsTriageLabel)], assignees: [user('alice'), user('bob')] })], prs: [pr()] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
  assert.deepEqual(f.state.issues.get(1).assignees, [user('bob')]);
});

test('Refs on an untriaged issue fails the check without closing', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr(10, { body: 'Refs #1' })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
});

test('missing links, foreign links, nonexistent issues and PR-as-issue fail without closing', async () => {
  for (const body of ['', 'Fixes other/repo#1', 'Fixes #999', 'Fixes #10']) {
    const f = fixture({ prs: [pr(10, { body })] });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure', body);
    assert.equal(f.state.prs.get(10).state, 'open');
  }
});

test('assignment refreshes a pinned failed PR check in the same run', async () => {
  const f = fixture({ issues: [issue(1)], prs: [pr(10, { labels: [label(config.pinnedLabel)] })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
  await f.command(1, '/assign @alice', 'maintainer');
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
});

test('bot, maintainer and pre-rollout PRs remain exempt', async () => {
  for (const override of [{ user: user('dependabot[bot]', 'Bot') }, { user: user('maintainer') }, { created_at: date(-1) }]) {
    const f = fixture({ prs: [pr(10, { body: '', ...override })] });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  }
});

test('closing one of two linked PRs does not release the active assignment', async () => {
  const f = fixture({ prs: [pr(10, { state: 'closed', closed_at: date(11) }), pr(11)] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
});

test('old closure events cannot release a later reassignment', async () => {
  const f = fixture({ prs: [pr(10, { state: 'closed', closed_at: date(10) })] });
  f.state.events.set(1, [{ event: 'assigned', assignee: user('alice'), created_at: date(11) }]);
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});

test('inactivity gives a reminder at day 7, then releases after day 14 and a full week of warning, ignoring bot activity', async () => {
  const f = fixture({ day: 8, issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
  f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  await f.execute('schedule');
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  assert.match(f.state.comments.get(1)[0].body, /reminder|share an update/);
  await f.execute('schedule', {}, { now: epoch + 14 * DAY });
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await f.execute('schedule', {}, { now: epoch + 15 * DAY });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('a linked draft PR or pinned issue protects its assignment from expiry', async () => {
  for (const pinned of [false, true]) {
    const f = fixture({ day: 30, issues: [issue(1, { labels: [label(config.assignedLabel), ...(pinned ? [label(config.pinnedLabel)] : [])], assignees: [user('alice')] })], prs: pinned ? [] : [pr(10, { draft: true })] });
    f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
    await f.execute('schedule');
    assert.equal(f.state.issues.get(1).assignees.length, 1);
    assert.equal(f.state.comments.get(1)?.length ?? 0, 0);
  }
});

// A change request on day 2 against the PR head, a reminder on day 9 for that
// request, and no contributor response: closable from day 16.
function staleFixture() {
  const f = fixture({ day: 16, prs: [pr(10, { labels: [label(config.staleLabel)] })] });
  f.state.reviews.set(10, [{ id: 1, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(2), commit_id: 'a'.repeat(40) }]);
  f.state.comments.set(10, [{ id: 50, user: user('github-actions[bot]', 'Bot'), created_at: date(9), body: `<!-- kubescape-policy:pr-reminder-1-${epoch + 2 * DAY} -->\nReminder` }]);
  return f;
}

test('stale requested changes close after fourteen days and a full week after the reminder, and release the issue', async () => {
  const f = staleFixture();
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('author reply, new head, dismissed request, or pin prevents stale closure', async () => {
  for (const change of ['reply', 'push', 'dismiss', 'pin']) {
    const f = staleFixture();
    if (change === 'reply') f.state.inline.set(10, [{ user: user('alice'), created_at: date(10) }]);
    if (change === 'push') f.state.prs.get(10).head.sha = 'b'.repeat(40);
    if (change === 'dismiss') f.state.reviews.get(10)[0].state = 'DISMISSED';
    if (change === 'pin') f.state.prs.get(10).labels.push(label(config.pinnedLabel));
    await f.execute('schedule');
    assert.equal(f.state.prs.get(10).state, 'open', change);
  }
});

test('outsider or bot requests cannot cause automatic closure', async () => {
  for (const reviewer of [user('outsider'), user('review-bot', 'Bot')]) {
    const f = staleFixture();
    f.state.reviews.get(10)[0].user = reviewer;
    await f.execute('schedule');
    assert.equal(f.state.prs.get(10).state, 'open');
  }
});

test('API failure cannot turn an unknown issue into an automatic closure', async () => {
  const f = fixture({ prs: [pr()] });
  f.github.rest.issues.get = async () => { throw Object.assign(new Error('unavailable'), { status: 503 }); };
  await assert.rejects(f.execute('pull_request_target', { pull_request: pr() }), /unavailable/);
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('invalid rollout timestamp stops before writes', async () => {
  const f = fixture({ prs: [pr()] });
  await assert.rejects(f.execute('schedule', {}, { start: 'yesterday' }), /ISO UTC/);
  assert.deepEqual(f.state.mutations, []);
  assert.deepEqual(f.state.checkWrites, []);
});


test('API failure replaces a previous passing check with failure', async () => {
  const f = fixture({ prs: [pr()] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  f.github.rest.issues.get = async () => { throw new Error('outage'); };
  await assert.rejects(f.execute('pull_request_target', { pull_request: pr() }), /outage/);
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
});

test('queued opened event does not undo completed triage', async () => {
  const f = fixture({ issues: [issue(1)] });
  f.state.events.set(1, [{ event: 'unlabeled', label: label(config.needsTriageLabel), created_at: date(2) }]);
  await f.execute('issues', { action: 'opened', issue: issue(1) });
  assert.deepEqual(f.state.issues.get(1).labels, []);
});

test('triage completed during a check prevents automatic closure', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr()] });
  const writeStatus = f.github.rest.checks.update;
  f.github.rest.checks.update = async a => {
    const result = await writeStatus(a);
    if (a.conclusion === 'failure' && a.output.title !== 'Policy revalidation incomplete') f.state.issues.get(1).labels = [];
    return result;
  };
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'open');
});


test('a new round of requested changes cannot reuse an older stale warning', async () => {
  const f = staleFixture();
  f.state.reviews.get(10).push({ id: 2, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(11), commit_id: 'a'.repeat(40) });
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.ok(!f.state.prs.get(10).labels.some(l => l.name === config.staleLabel));
});

test('an author review reply counts as activity', async () => {
  const f = staleFixture();
  f.state.reviews.get(10).push({ id: 2, user: user('alice'), state: 'COMMENTED', submitted_at: date(11) });
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('pre-rollout assignments remain exempt even after a new progress comment', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
  f.state.events.set(1, [{ event: 'assigned', assignee: user('alice'), created_at: date(-1) }]);
  f.state.comments.set(1, [{ user: user('alice'), created_at: date(1) }]);
  await f.execute('schedule');
  assert.equal(f.state.comments.get(1).length, 1);
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});


test('angle-bracketed same-repository issue URLs are accepted', () => {
  assert.deepEqual(issueLinks('Fixes <https://github.com/kubescape/kubescape/issues/12>', 'kubescape/kubescape'), [{ number: 12, closes: true }]);
});

test('requested changes get a reminder at day 7; waiting for review does not', async () => {
  const request = [{ id: 1, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(1), commit_id: 'a'.repeat(40) }];
  const early = fixture({ prs: [pr()], day: 7 }); // six days after the request
  early.state.reviews.set(10, request);
  await early.execute('schedule');
  assert.equal(early.state.comments.get(10)?.length ?? 0, 0);
  const f = fixture({ prs: [pr()], day: 8 });
  f.state.reviews.set(10, request);
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.ok(f.state.prs.get(10).labels.some(l => l.name === config.staleLabel));
  assert.match(f.state.comments.get(10).at(-1).body, /no response for 7 days/);
  const g = fixture({ prs: [pr()], day: 100 });
  await g.execute('schedule');
  assert.equal(g.state.prs.get(10).state, 'open');
  assert.equal(g.state.comments.get(10)?.length ?? 0, 0);
});


test('reply or approval arriving during stale processing prevents closure', async () => {
  for (const change of ['reply', 'approval']) {
    const f = staleFixture();
    const get = f.github.rest.pulls.get;
    let reads = 0;
    f.github.rest.pulls.get = async args => {
      reads++;
      if (reads === 3) { // The final close guard, after expiry read the old state.
        if (change === 'reply') f.state.comments.get(10).push({ id: 51, user: user('alice'), created_at: date(12), body: 'Working on this.' });
        else f.state.reviews.get(10).push({ id: 2, user: user('maintainer'), state: 'APPROVED', submitted_at: date(12) });
      }
      return get(args);
    };
    await f.execute('schedule');
    assert.equal(f.state.prs.get(10).state, 'open', change);
  }
});

test('progress or a pin arriving during assignment expiry prevents unassignment', async () => {
  for (const change of ['progress', 'pin']) {
    const f = fixture({ day: 15, issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
    f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
    f.state.comments.set(1, [{ id: 1, user: user('github-actions[bot]', 'Bot'), created_at: date(5), body: `<!-- kubescape-policy:assignment-reminder-alice-${epoch + DAY} -->` }]);
    const getComments = f.github.rest.issues.listComments;
    let injected = false;
    f.github.rest.issues.listComments = async args => {
      const result = await getComments(args);
      if (!injected) {
        injected = true;
        if (change === 'pin') f.state.issues.get(1).labels.push(label(config.pinnedLabel));
        else f.state.comments.get(1).push({ id: 2, user: user('alice'), created_at: date(15), body: 'Progress update' });
      }
      return result;
    };
    await f.execute('schedule');
    assert.equal(f.state.issues.get(1).assignees.length, 1, change);
  }
});

test('deleted queued commands are ignored', async () => {
  const f = fixture({ issues: [issue(1)] });
  f.github.rest.issues.getComment = async () => { throw Object.assign(new Error('deleted'), { status: 404 }); };
  await f.execute('issue_comment', { issue: issue(1), comment: { id: 1, user: user('alice') } });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('reopening an inactive PR starts a new warning window', async () => {
  const f = staleFixture();
  f.state.events.set(10, [{ id: 1, event: 'reopened', created_at: date(15) }]);
  await f.execute('pull_request_target', { action: 'reopened', pull_request: pr() });
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.ok(!f.state.prs.get(10).labels.some(l => l.name === config.staleLabel));
});


test('all self-assignment commands are rejected, including maintainer aliases', async () => {
  for (const [login, command] of [['alice', '/assign-me'], ['maintainer', '/assign-me'], ['maintainer', '/assign @maintainer']]) {
    const f = fixture({ issues: [issue(1)] });
    await f.command(1, command, login);
    assert.equal(f.state.issues.get(1).assignees.length, 0);
    assert.match(f.state.comments.get(1).at(-1).body, /Self-assignment is not allowed/);
  }
});

test('maintainer assignment cannot exceed three active assignments', async () => {
  const f = fixture({ issues: [issue(1), ...[2, 3, 4].map(n => issue(n, { assignees: [user('alice')] }))] });
  await f.command(1, '/assign @alice', 'maintainer');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  assert.match(f.state.comments.get(1).at(-1).body, /3 active issue assignments/);
});

test('self-assignment through GitHub UI is reversed; later maintainer assignment is preserved', async () => {
  for (const laterAssignment of [false, true]) {
    const f = fixture();
    f.state.events.set(1, [{ id: 1, event: 'assigned', assignee: user('alice'), actor: user('alice'), created_at: date(11) }]);
    if (laterAssignment) f.state.events.get(1).push({ id: 2, event: 'assigned', assignee: user('alice'), actor: user('maintainer'), created_at: date(12) });
    await f.execute('issues', { action: 'assigned', issue: issue(1), assignee: user('alice'), sender: user('alice') });
    assert.equal(f.state.issues.get(1).assignees.length, laterAssignment ? 1 : 0);
  }
});

test('contributors may still release their own assignment', async () => {
  const f = fixture();
  await f.command(1, '/unassign-me');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});


test('the same policy works in another Kubescape repository', async () => {
  const f = fixture({ repository: 'kubescape/operator', prs: [pr(10, { body: 'Fixes https://github.com/kubescape/operator/issues/1' })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  assert.equal(f.state.checkWrites.at(-1).repo, 'operator');
  assert.equal(f.state.checkWrites.at(-1).details_url, 'https://github.com/kubescape/operator/pull/10');
});

test('repositories without issues skip issue requirements but retain stale review protection', async () => {
  const f = fixture({ repository: 'kubescape/example-fork', issues: [], prs: [pr(10, { body: '' })] });
  await f.execute('schedule', { repository: { has_issues: false } });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  assert.equal(f.state.prs.get(10).state, 'open');
});


test('only fixing non-assignee PRs close; Refs still reports the assignment failure', async () => {
  for (const body of ['Fixes #1', 'Refs #1']) {
    const f = fixture({ prs: [pr(10, { user: user('bob'), body })] });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.prs.get(10).state, body.startsWith('Fixes') ? 'closed' : 'open');
    assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
    assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
    assert.match(f.state.comments.get(10).at(-1).body, /not assigned to issue #1/);
  }
});

test('a maintainer assignment arriving during validation prevents non-assignee closure', async () => {
  const f = fixture({ issues: [issue(1)], prs: [pr()] });
  const writeStatus = f.github.rest.checks.update;
  f.github.rest.checks.update = async args => {
    const result = await writeStatus(args);
    if (args.conclusion === 'failure' && args.output.title !== 'Policy revalidation incomplete') f.state.issues.get(1).assignees.push(user('alice'));
    return result;
  };
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('later duplicate PR closes and retains assignment protected by an earlier Fixes or Refs PR', async () => {
  for (const body of ['Fixes #1', 'Refs #1']) {
    const f = fixture({ prs: [pr(11), pr(10, { body, draft: true })] });
    await f.execute('pull_request_target', { pull_request: pr(11) });
    assert.equal(f.state.prs.get(11).state, 'closed');
    assert.equal(f.state.prs.get(10).state, 'open');
    assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
    assert.match(f.state.comments.get(11).at(-1).body, /open PR from a current assignee: #10/);
  }
});

test('duplicate selection keeps the earliest assignee PR regardless of API ordering', async () => {
  const f = fixture({ prs: [pr(12), pr(11), pr(10)] });
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.prs.get(11).state, 'closed');
  assert.equal(f.state.prs.get(12).state, 'closed');
  assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
});

test('closed, unrelated or non-assignee PRs do not block the assigned contributor', async () => {
  for (const older of [pr(9, { state: 'closed' }), pr(9, { body: 'Fixes #2' }), pr(9, { user: user('bob') })]) {
    const f = fixture({ prs: [older, pr()] });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.prs.get(10).state, 'open');
    assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  }
});

test('closing the earlier PR during validation prevents duplicate closure', async () => {
  const f = fixture({ prs: [pr(9), pr()] });
  const writeStatus = f.github.rest.checks.update;
  f.github.rest.checks.update = async args => {
    const result = await writeStatus(args);
    if (args.conclusion === 'failure' && args.output.title !== 'Policy revalidation incomplete') f.state.prs.get(9).state = 'closed';
    return result;
  };
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('pinned duplicates fail the check but stay open for maintainer coordination', async () => {
  const f = fixture({ prs: [pr(9), pr(10, { labels: [label(config.pinnedLabel)] })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
});

test('assignment expires at 14 inactive days, not at 13 days', async () => {
  const f = fixture({ day: 14, issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
  f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  f.state.comments.set(1, [{ id: 1, user: user('github-actions[bot]', 'Bot'), created_at: date(5), body: `<!-- kubescape-policy:assignment-reminder-alice-${epoch + DAY} -->` }]);
  await f.execute('schedule');
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await f.execute('schedule', {}, { now: epoch + 15 * DAY });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('issue author cannot self-assign but can be assigned by a maintainer after triage', async () => {
  const f = fixture({ issues: [issue(1, { user: user('alice') })] });
  await f.command(1, '/assign-me');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  await f.command(1, '/assign @alice', 'maintainer');
  assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
});


test('duplicate lookup failure leaves the check failing without closing either PR', async () => {
  const f = fixture({ prs: [pr(9), pr()] });
  f.github.rest.pulls.list = async () => { throw new Error('unavailable'); };
  await assert.rejects(f.execute('pull_request_target', { pull_request: pr() }), /unavailable/);
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
  assert.equal(f.state.prs.get(9).state, 'open');
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('duplicate from another current assignee closes without releasing the earlier author', async () => {
  const f = fixture({ issues: [issue(1, { assignees: [user('alice'), user('bob')] })], prs: [pr(9), pr(10, { user: user('bob') })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.prs.get(9).state, 'open');
  assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
});

test('colon-form links are validated alongside ordinary links; indented examples are ignored', async () => {
  assert.deepEqual(issueLinks('    Fixes #99\n\tRefs #98\nFixes: #1\nRefs: #2', 'kubescape/kubescape'), [{ number: 1, closes: true }, { number: 2, closes: false }]);
  const f = fixture({ issues: [issue(1, { assignees: [user('alice')] }), issue(2)], prs: [pr(10, { body: 'Fixes #1\nFixes: #2' })] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.match(f.state.checkWrites.at(-1).output.summary, /not assigned to issue #2/);
});

test('rollout dates reject impossible calendar values and accept leap days', async () => {
  for (const start of ['2027-02-29T00:00:00Z', '2026-04-31T00:00:00Z', '2026-12-01T24:00:00Z', '2026-12-01T00:00Z']) {
    const f = fixture({ prs: [pr()] });
    await assert.rejects(f.execute('schedule', {}, { start }), /ISO UTC/);
    assert.deepEqual(f.state.mutations, []);
    assert.deepEqual(f.state.checkWrites, []);
  }
  await fixture().execute('schedule', {}, { start: '2028-02-29T00:00:00Z' });
  await fixture().execute('schedule', {}, { start: '2028-02-29T00:00:00.123Z' });
});

test('assignment and release retries repair labels without repeating the assignment write', async () => {
  const f = fixture({ issues: [issue(1)] });
  const add = f.github.rest.issues.addLabels;
  f.github.rest.issues.addLabels = async () => { throw new Error('label outage'); };
  await assert.rejects(f.command(1, '/assign @alice', 'maintainer'), /label outage/);
  f.github.rest.issues.addLabels = add;
  await f.execute('issue_comment', { issue: issue(1), comment: f.state.comments.get(1)[0] });
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
  assert.ok(f.state.issues.get(1).labels.some(l => l.name === config.assignedLabel));
  const remove = f.github.rest.issues.removeLabel;
  f.github.rest.issues.removeLabel = async () => { throw new Error('label outage'); };
  await assert.rejects(f.command(1, '/unassign-me'), /label outage/);
  const command = f.state.comments.get(1).find(c => c.body === '/unassign-me');
  f.github.rest.issues.removeLabel = remove;
  await f.execute('issue_comment', { issue: issue(1), comment: command });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  assert.ok(!f.state.issues.get(1).labels.some(l => l.name === config.assignedLabel));
});

test('pre-rollout or unknown assignments survive post-rollout PR closure', async () => {
  for (const timeline of [[], [{ id: 1, event: 'assigned', assignee: user('alice'), created_at: date(-1) }]]) {
    const f = fixture({ prs: [pr(10, { state: 'closed', closed_at: date(11) })] });
    f.state.events.set(1, timeline);
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.issues.get(1).assignees.length, 1);
  }
});

test('pre-rollout queued assignment events do not reverse existing assignments', async () => {
  const f = fixture({ issues: [issue(1, { created_at: date(-2), assignees: [user('alice')] })] });
  f.state.events.set(1, [{ id: 1, event: 'assigned', actor: user('alice'), assignee: user('alice'), created_at: date(-1) }]);
  await f.execute('issues', { action: 'assigned', issue: issue(1), assignee: user('alice'), sender: user('alice') });
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});

test('a maintainer replacement during enforcement is not reversed', async () => {
  const f = fixture();
  f.state.events.get(1).push({ id: 10, event: 'assigned', actor: user('alice'), assignee: user('alice'), created_at: date(11) });
  const events = f.github.rest.issues.listEventsForTimeline;
  let reads = 0;
  f.github.rest.issues.listEventsForTimeline = async args => {
    const response = await events(args);
    // ensureTriage reads first; the enforcement snapshot reads second.
    if (++reads === 2) f.state.events.get(1).push({ id: 11, event: 'assigned', actor: user('maintainer'), assignee: user('alice'), created_at: date(12) });
    return response;
  };
  await f.execute('issues', { action: 'assigned', issue: issue(1), assignee: user('alice'), sender: user('alice') });
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});

test('author reply or pin during the closure comment prevents closure', async () => {
  for (const change of ['reply', 'pin']) {
    const f = staleFixture();
    const comment = f.github.rest.issues.createComment;
    f.github.rest.issues.createComment = async args => {
      const result = await comment(args);
      if (args.body.startsWith('<!-- kubescape-policy:closure -->')) {
        if (change === 'reply') f.state.comments.get(10).push({ id: 999, user: user('alice'), body: 'Working on it', created_at: date(12) });
        else f.state.prs.get(10).labels.push(label(config.pinnedLabel));
      }
      return result;
    };
    await f.execute('schedule');
    assert.equal(f.state.prs.get(10).state, 'open', change);
    assert.equal(f.state.issues.get(1).assignees.length, 1, change);
  }
});

test('the final expiry read honors a new pin; explicit release still works', async () => {
  const f = fixture({ day: 15, issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
  f.state.comments.set(1, [{ id: 1, user: user('github-actions[bot]', 'Bot'), created_at: date(5), body: `<!-- kubescape-policy:assignment-reminder-alice-${epoch + DAY} -->` }]);
  const list = f.github.rest.pulls.list;
  let reads = 0;
  f.github.rest.pulls.list = async args => {
    const response = await list(args);
    if (++reads === 2) f.state.issues.get(1).labels.push(label(config.pinnedLabel));
    return response;
  };
  await f.execute('schedule');
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await f.command(1, '/unassign-me');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('a scheduled run retries cleanup after closing succeeded but release failed', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.needsTriageLabel), label(config.assignedLabel)], assignees: [user('alice')] })], prs: [pr()] });
  const remove = f.github.rest.issues.removeAssignees;
  f.github.rest.issues.removeAssignees = async () => { throw new Error('release outage'); };
  await assert.rejects(f.execute('pull_request_target', { pull_request: pr() }), /release outage/);
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.ok(f.state.prs.get(10).labels.some(l => l.name === config.cleanupLabel));
  f.github.rest.issues.removeAssignees = remove;
  await f.execute('schedule');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  assert.ok(!f.state.prs.get(10).labels.some(l => l.name === config.cleanupLabel));
});

test('a shared head cannot receive success from a valid or exempt sibling', async () => {
  for (const exempt of [false, true]) {
    const f = fixture({ prs: [pr(10, { labels: [label(config.pinnedLabel)], body: 'Refs #2' }), pr(11, { head: { sha: 'a'.repeat(40) }, ...(exempt ? { user: user('maintainer') } : {}) })] });
    await f.execute('pull_request_target', { pull_request: pr(11) });
    assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
    assert.match(f.state.checkWrites.at(-1).output.summary, /#10:.*does not exist/);
    assert.match(f.state.checkWrites.at(-1).output.summary, /#11: Passed/);
  }
});

test('revalidation updates one check across more than 500 unchanged evaluations', async () => {
  const f = fixture({ prs: [pr()] });
  for (let i = 0; i < 501; i++) await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.checks.size, 1);
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
});

test('one failing PR does not prevent another check or assignment reminder', async () => {
  const f = fixture({ prs: [pr(10), pr(11, { user: user('maintainer') })], issues: [issue(1, { assignees: [user('alice')] }), issue(2, { labels: [label(config.assignedLabel)], assignees: [user('bob')] })] });
  const get = f.github.rest.issues.get;
  f.github.rest.issues.get = async args => { if (args.issue_number === 1) throw new Error('issue outage'); return get(args); };
  await assert.rejects(f.execute('schedule'), /issue outage/);
  assert.ok([...f.state.checks.values()].some(c => c.head_sha === pr(11).head.sha && c.conclusion === 'success'));
  assert.match(f.state.comments.get(2)[0].body, /share an update/);
});

test('assignments processed before opened still require explicit triage', async () => {
  const f = fixture({ prs: [pr(10, { labels: [label(config.pinnedLabel)] })] });
  f.state.events.set(1, [{ id: 1, event: 'assigned', actor: user('maintainer'), assignee: user('alice'), created_at: date(11) }]);
  await f.execute('issues', { action: 'assigned', issue: issue(1), assignee: user('alice'), sender: user('maintainer') });
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  assert.ok(f.state.issues.get(1).labels.some(l => l.name === config.needsTriageLabel));
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
  await f.execute('issues', { action: 'opened', issue: issue(1) });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
});

test('maintainer-opened issues skip triage even when a template supplies the label', async () => {
  for (const permission of ['write', 'maintain', 'admin']) {
    for (const labelled of [false, true]) {
      const target = issue(1, { user: user('owner'), labels: labelled ? [label(config.needsTriageLabel)] : [] });
      const f = fixture({ issues: [target] });
      f.state.permissions.set('owner', permission);
      f.state.events.set(1, []);
      await f.execute('issues', { action: 'opened', issue: target });
      assert.ok(!f.state.issues.get(1).labels.some(l => l.name === config.needsTriageLabel));
      await f.command(1, '/assign @alice', 'maintainer');
      assert.deepEqual(f.state.issues.get(1).assignees, [user('alice')]);
    }
  }
});

test('a maintainer opening someone else\'s queued issue event does not bypass triage', async () => {
  const target = issue(1);
  const f = fixture({ issues: [target] });
  f.state.events.set(1, []);
  await f.execute('issues', { action: 'opened', issue: target, sender: user('maintainer') });
  assert.ok(f.state.issues.get(1).labels.some(l => l.name === config.needsTriageLabel));
});

test('scheduled checks paginate PRs a constant number of times for 220 PRs', async () => {
  const issues = Array.from({ length: 220 }, (_, i) => issue(i + 1, { assignees: [user('alice')] }));
  const prs = issues.map(i => pr(i.number + 1000, { body: `Fixes #${i.number}` }));
  const f = fixture({ issues, prs });
  const list = f.github.rest.pulls.list;
  let listings = 0;
  f.github.rest.pulls.list = args => { listings++; return list(args); };
  await f.execute('schedule');
  assert.equal(listings, 2); // one check snapshot, one refresh before expiry
  assert.equal(f.state.checks.size, 220);
  assert.ok([...f.state.checks.values()].every(c => c.conclusion === 'success'));
});

test('a closure updates the snapshot before another PR releases its assignment', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr(10), pr(11)] });
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.prs.get(11).state, 'closed');
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

// ---------------------------------------------------------------------------
// 7-day reminder / 14-day action policy, review turn tracking, reopening,
// duplicate eligibility and Assigned-label synchronisation.
// ---------------------------------------------------------------------------
const SHA = 'a'.repeat(40);
const ms = (day, extra = 0) => epoch + day * DAY + extra;
const isBot = c => c.user.type === 'Bot';
const botTexts = (f, n, pattern) => (f.state.comments.get(n) ?? []).filter(c => isBot(c) && pattern.test(c.body));
const assignmentReminders = (f, n = 1) => botTexts(f, n, /assignment-reminder/);
const prReminders = (f, n = 10) => botTexts(f, n, /pr-reminder/);
const hasLabelNamed = (item, name) => item.labels.some(l => l.name === name);
const runAt = (f, at, event = 'schedule', payload = {}) => { f.at(at); return f.execute(event, payload); };
const assigned = (login = 'alice', extra = {}) => issue(1, { labels: [label(config.assignedLabel)], assignees: [user(login)], ...extra });

// Issue assigned to alice on day 1: reminder from day 8, release from day 15.
function assignmentFixture(extra = {}) {
  const f = fixture({ day: 1, issues: [assigned()], ...extra });
  f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  return f;
}
const request = (f, { id = 1, at = 1, reviewer = 'maintainer', commit = SHA, state = 'CHANGES_REQUESTED', number = 10 } = {}) =>
  f.state.reviews.set(number, [...(f.state.reviews.get(number) ?? []), { id, user: user(reviewer), state, submitted_at: date(at), commit_id: commit }]);
const prFixture = (extra = {}) => {
  const f = fixture({ day: 1, prs: [pr(10)], ...extra });
  f.state.permissions.set('maintainer2', 'write');
  request(f);
  return f;
};

test('assignment timeline: no reminder before day 7, exactly one at day 7, none duplicated, no release before day 14 or without a full week of warning', async () => {
  const f = assignmentFixture();
  for (const at of [ms(7), ms(8, -1)]) { await runAt(f, at); assert.equal(assignmentReminders(f).length, 0, `reminder at ${at}`); }
  await runAt(f, ms(8));
  assert.equal(assignmentReminders(f).length, 1);
  await runAt(f, ms(8));
  await runAt(f, ms(9));
  assert.equal(assignmentReminders(f).length, 1);
  for (const at of [ms(14), ms(15, -1)]) { await runAt(f, at); assert.equal(f.state.issues.get(1).assignees.length, 1, `released at ${at}`); }
  await runAt(f, ms(15));
  assert.equal(f.state.issues.get(1).assignees.length, 0);
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), false);
  assert.equal(assignmentReminders(f).length, 1);
});

test('a late assignment reminder postpones release by a full week after the reminder actually went out', async () => {
  const f = assignmentFixture();
  await runAt(f, ms(20)); // the scheduled runs before this were missed
  assert.equal(assignmentReminders(f).length, 1);
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await runAt(f, ms(27, -1));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await runAt(f, ms(27));
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('an assignment is never released when the reminder could not be sent', async () => {
  const f = assignmentFixture();
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async () => { throw new Error('comment outage'); };
  f.at(ms(30));
  await assert.rejects(f.execute('schedule'), /comment outage/);
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  f.github.rest.issues.createComment = create;
  await runAt(f, ms(31));
  assert.equal(f.state.issues.get(1).assignees.length, 1); // reminder first, nothing destructive in the same run
  await runAt(f, ms(37, -1));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await runAt(f, ms(38));
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('assignee activity after a reminder starts a new cycle with its own single reminder', async () => {
  const f = assignmentFixture();
  await runAt(f, ms(8));
  f.state.comments.get(1).push({ id: 500, user: user('alice'), body: 'Working on it', created_at: date(12), updated_at: date(12) });
  await runAt(f, ms(15));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await runAt(f, ms(18)); // only six days after the activity on day 12
  assert.equal(assignmentReminders(f).length, 1);
  await runAt(f, ms(19));
  assert.equal(assignmentReminders(f).length, 2);
  await runAt(f, ms(25, DAY - 1));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  await runAt(f, ms(26));
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('assignee activity immediately before the release prevents it', async () => {
  const f = assignmentFixture();
  await runAt(f, ms(8));
  f.state.comments.get(1).push({ id: 501, user: user('alice'), body: 'Still here', created_at: new Date(ms(15, -1000)).toISOString(), updated_at: new Date(ms(15, -1000)).toISOString() });
  await runAt(f, ms(15));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});

test('bot, other-user and automated comments never extend an assignment', async () => {
  const f = assignmentFixture();
  await runAt(f, ms(8));
  for (let day = 2; day <= 14; day += 2) {
    f.state.comments.get(1).push({ id: 600 + day, user: user('github-actions[bot]', 'Bot'), body: 'automated status', created_at: date(day), updated_at: date(day) },
      { id: 700 + day, user: user('bob'), body: 'any update?', created_at: date(day), updated_at: date(day) });
  }
  await runAt(f, ms(15));
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('a linked PR opened while the release is being confirmed keeps the assignment', async () => {
  const f = assignmentFixture();
  await runAt(f, ms(8));
  const draft = pr(10, { draft: true, created_at: date(15), updated_at: date(15) });
  const list = f.github.rest.pulls.list;
  let reads = 0;
  f.github.rest.pulls.list = async args => {
    if (++reads === 3) f.state.prs.set(10, draft); // the read immediately before the release
    return list(args);
  };
  await runAt(f, ms(15));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  assert.equal(f.state.issues.get(1).labels.some(l => l.name === config.assignedLabel), true);
});

test('malformed or missing assignment timestamps never cause a release', async () => {
  const noStart = fixture({ day: 40, issues: [assigned()] });
  noStart.state.events.set(1, []);
  await noStart.execute('schedule');
  assert.equal(noStart.state.issues.get(1).assignees.length, 1);
  assert.equal(noStart.state.comments.get(1)?.length ?? 0, 0);
  const f = assignmentFixture();
  await runAt(f, ms(8));
  f.state.comments.get(1).find(isBot).created_at = 'not a date';
  await runAt(f, ms(40));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  const g = assignmentFixture();
  await runAt(g, ms(8));
  g.state.comments.get(1).find(isBot).created_at = undefined;
  await runAt(g, ms(40));
  assert.equal(g.state.issues.get(1).assignees.length, 1);
});

test('PR timeline: no reminder before day 7, one at day 7, no duplicate, no closure before day 14 or a week after the reminder', async () => {
  const f = prFixture();
  for (const at of [ms(7), ms(8, -1)]) { await runAt(f, at); assert.equal(prReminders(f).length, 0, `reminder at ${at}`); }
  await runAt(f, ms(8));
  assert.equal(prReminders(f).length, 1);
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), true);
  await runAt(f, ms(8));
  await runAt(f, ms(9));
  assert.equal(prReminders(f).length, 1);
  for (const at of [ms(14), ms(15, -1)]) { await runAt(f, at); assert.equal(f.state.prs.get(10).state, 'open', `closed at ${at}`); }
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(prReminders(f).length, 1);
  assert.match(botTexts(f, 10, /kubescape-policy:closure -->/).at(-1).body, /reopen this PR\. If the linked issue is still open, triaged and unassigned.*restored automatically.*Otherwise you will be told why/s);
  assert.equal(f.state.issues.get(1).assignees.length, 0);
});

test('a late PR reminder postpones closure by a full week after the reminder', async () => {
  const f = prFixture();
  await runAt(f, ms(20));
  assert.equal(prReminders(f).length, 1);
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(27, -1));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(27));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('a PR is never closed when its reminder could not be sent', async () => {
  const f = prFixture();
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async () => { throw new Error('comment outage'); };
  f.at(ms(30));
  await assert.rejects(f.execute('schedule'), /comment outage/);
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), false);
  f.github.rest.issues.createComment = create;
  await runAt(f, ms(31));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(37, -1));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(38));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('a push or reply moves the PR to waiting-for-review and it stays open for 30+ days', async () => {
  for (const response of ['push', 'comment', 'inline', 'review']) {
    const f = prFixture();
    await runAt(f, ms(8));
    assert.equal(prReminders(f).length, 1);
    if (response === 'push') f.state.prs.get(10).head.sha = 'b'.repeat(40);
    if (response === 'comment') f.state.comments.get(10).push({ id: 800, user: user('alice'), body: 'Addressed', created_at: date(9), updated_at: date(9) });
    if (response === 'inline') f.state.inline.set(10, [{ id: 801, user: user('alice'), created_at: date(9), body: 'Done' }]);
    if (response === 'review') f.state.reviews.get(10).push({ id: 2, user: user('alice'), state: 'COMMENTED', submitted_at: date(9) });
    await runAt(f, ms(40));
    assert.equal(f.state.prs.get(10).state, 'open', response);
    assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), false, response);
    assert.equal(prReminders(f).length, 1, response);
  }
});

test('a push before any reminder also means the reviewer is next, so no reminder is sent', async () => {
  const f = prFixture();
  f.state.prs.get(10).head.sha = 'c'.repeat(40);
  await runAt(f, ms(30));
  assert.equal(prReminders(f).length, 0);
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('contributor response immediately before closure prevents it', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  f.state.comments.get(10).push({ id: 810, user: user('alice'), body: 'On it', created_at: new Date(ms(15, -1000)).toISOString() });
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('a new change request starts a fresh response window with its own reminder', async () => {
  const f = prFixture();
  f.state.prs.get(10).head.sha = 'b'.repeat(40); // contributor pushed: waiting for review
  await runAt(f, ms(8));
  assert.equal(prReminders(f).length, 0);
  request(f, { id: 2, at: 10, commit: 'b'.repeat(40) }); // the reviewer asks again on the new head
  await runAt(f, ms(16));
  assert.equal(prReminders(f).length, 0);
  await runAt(f, ms(17));
  assert.equal(prReminders(f).length, 1);
  await runAt(f, ms(23));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(24));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('with several reviewers only the latest valid request defines the window', async () => {
  const f = prFixture();
  request(f, { id: 2, at: 5, reviewer: 'maintainer2' });
  await runAt(f, ms(11));
  assert.equal(prReminders(f).length, 0); // day 1's request does not shorten day 5's window
  await runAt(f, ms(12));
  assert.equal(prReminders(f).length, 1);
  await runAt(f, ms(18));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(19));
  assert.equal(f.state.prs.get(10).state, 'closed');
  const g = prFixture();
  request(g, { id: 2, at: 5, reviewer: 'maintainer2' });
  g.state.comments.set(10, [{ id: 820, user: user('alice'), body: 'Done', created_at: date(6) }]);
  g.state.reviews.get(10).find(r => r.id === 1).state = 'APPROVED'; // the first reviewer later approves
  await runAt(g, ms(60));
  assert.equal(g.state.prs.get(10).state, 'open');
  assert.equal(prReminders(g).length, 0);
});

test('approval or dismissal clears the stale state', async () => {
  for (const state of ['APPROVED', 'DISMISSED']) {
    const f = prFixture();
    await runAt(f, ms(8));
    assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), true);
    f.state.reviews.get(10)[0].state = state;
    await runAt(f, ms(60));
    assert.equal(f.state.prs.get(10).state, 'open', state);
    assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), false, state);
  }
});

test('unrelated comments, bot comments, label changes and metadata updates never reset or end the response window', async () => {
  const f = prFixture();
  for (let day = 2; day < 15; day += 2) {
    f.state.comments.set(10, [...(f.state.comments.get(10) ?? []), { id: 900 + day, user: user('github-actions[bot]', 'Bot'), body: 'build status', created_at: date(day) },
      { id: 950 + day, user: user('bob'), body: 'ping', created_at: date(day) }]);
  }
  f.state.inline.set(10, [{ id: 990, user: user('maintainer'), created_at: date(13), body: 'nit' }]);
  f.state.reviews.get(10).push({ id: 5, user: user('maintainer'), state: 'COMMENTED', submitted_at: date(13) });
  f.state.prs.get(10).updated_at = date(14);
  f.state.prs.get(10).title = 'renamed';
  await runAt(f, ms(8));
  assert.equal(prReminders(f).length, 1);
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('malformed review state fails safe', async () => {
  const noTime = prFixture();
  delete noTime.state.reviews.get(10)[0].submitted_at;
  await runAt(noTime, ms(60));
  assert.equal(noTime.state.prs.get(10).state, 'open');
  assert.equal(prReminders(noTime).length, 0);
  const noCommit = prFixture();
  delete noCommit.state.reviews.get(10)[0].commit_id;
  await runAt(noCommit, ms(8)); // a reminder is harmless
  await runAt(noCommit, ms(60)); // a push cannot be ruled out, so never close
  assert.equal(noCommit.state.prs.get(10).state, 'open');
  const badReminder = prFixture();
  await runAt(badReminder, ms(8));
  badReminder.state.comments.get(10).find(isBot).created_at = 'garbage';
  await runAt(badReminder, ms(60));
  assert.equal(badReminder.state.prs.get(10).state, 'open');
});

test('closure rechecks the latest state: a reply, new request or pin arriving mid-run prevents it', async () => {
  for (const change of ['reply', 'push', 'request', 'pin']) {
    const f = prFixture();
    await runAt(f, ms(8));
    const update = f.github.rest.pulls.update;
    const create = f.github.rest.issues.createComment;
    f.github.rest.issues.createComment = async args => {
      const result = await create(args);
      if (args.body.startsWith('<!-- kubescape-policy:closure -->')) {
        if (change === 'reply') f.state.comments.get(10).push({ id: 830, user: user('alice'), body: 'back', created_at: date(15) });
        if (change === 'push') f.state.prs.get(10).head.sha = 'd'.repeat(40);
        if (change === 'request') request(f, { id: 3, at: 15 });
        if (change === 'pin') f.state.prs.get(10).labels.push(label(config.pinnedLabel));
      }
      return result;
    };
    f.github.rest.pulls.update = update;
    await runAt(f, ms(15));
    assert.equal(f.state.prs.get(10).state, 'open', change);
  }
});

test('long comment and review histories are read completely', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  const noise = Array.from({ length: 250 }, (_, n) => ({ id: 2000 + n, user: user('github-actions[bot]', 'Bot'), body: 'noise', created_at: date(2) }));
  f.state.comments.set(10, [...noise, ...f.state.comments.get(10), { id: 3000, user: user('alice'), body: 'late reply', created_at: date(14) }]);
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(prReminders(f).length, 1);
});

test('permission lookup failure leaves PRs and assignments untouched', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  f.github.rest.repos.getCollaboratorPermissionLevel = async () => { throw Object.assign(new Error('forbidden'), { status: 403 }); };
  f.at(ms(40));
  await assert.rejects(f.execute('schedule'), /forbidden/);
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.issues.get(1).assignees.length, 1);
});

test('repeated delivery and reruns of the same scheduled run are idempotent', async () => {
  const f = assignmentFixture({ prs: [pr(11, { user: user('carol'), body: 'Fixes #99', head: { sha: 'e'.repeat(40) } })] });
  for (let n = 0; n < 3; n++) await runAt(f, ms(8));
  assert.equal(assignmentReminders(f).length, 1);
  const g = prFixture();
  for (let n = 0; n < 3; n++) await runAt(g, ms(8));
  assert.equal(prReminders(g).length, 1);
  for (let n = 0; n < 2; n++) await runAt(g, ms(15));
  assert.equal(g.state.prs.get(10).state, 'closed');
  assert.equal(botTexts(g, 10, /kubescape-policy:closure -->/).length, 1);
});

test('simultaneously delivered runs never act before the policy allows', async () => {
  const f = assignmentFixture({ prs: [] });
  f.at(ms(8));
  await Promise.all([f.execute('schedule'), f.execute('schedule'), f.execute('schedule')].map(p => p.catch(() => {})));
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  assert.ok(assignmentReminders(f).length >= 1);
  const g = prFixture();
  g.at(ms(8));
  await Promise.all([g.execute('schedule'), g.execute('schedule')].map(p => p.catch(() => {})));
  assert.equal(g.state.prs.get(10).state, 'open');
});

test('a stale PR listing that omits a new author reply cannot cause a closure', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  const getComments = f.github.rest.issues.listComments;
  let stale = true;
  f.github.rest.issues.listComments = async args => {
    const response = await getComments(args);
    if (args.issue_number === 10 && stale) { stale = false; f.state.comments.get(10).push({ id: 840, user: user('alice'), body: 'reply', created_at: date(14) }); }
    return response; // the first read predates the reply
  };
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'open');
});

// -- Reopening ---------------------------------------------------------------

function staleClosedFixture(overrides = {}) {
  const f = prFixture({ issues: [assigned(), issue(2), issue(3), issue(4)], ...overrides });
  f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  return f;
}
async function closeAsStale(f) {
  await runAt(f, ms(8));
  await runAt(f, ms(15));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.issues.get(1).assignees.length, 0, 'closing a PR releases its author');
}
const reopen = async (f, at, number = 10, actor = 'alice') => {
  f.state.prs.get(number).state = 'open';
  f.state.events.set(number, [...(f.state.events.get(number) ?? []), { id: 1000 + (f.state.events.get(number)?.length ?? 0), event: 'reopened', actor: user(actor), created_at: new Date(at).toISOString() }]);
  await runAt(f, at, 'pull_request_target', { action: 'reopened', pull_request: f.state.prs.get(number) });
};

test('an authorized reassignment makes reopening work and starts a fresh response window', async () => {
  const f = staleClosedFixture();
  await closeAsStale(f);
  await f.command(1, '/assign @alice', 'maintainer');
  assert.deepEqual(f.state.issues.get(1).assignees.map(a => a.login), ['alice']);
  await reopen(f, ms(17));
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  await runAt(f, ms(23)); // six days after the reopening
  assert.equal(prReminders(f).length, 1); // only the original reminder
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(24));
  assert.equal(prReminders(f).length, 2);
  await runAt(f, ms(30, -1));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(31));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

// -- Controlled assignment recovery -------------------------------------------

const restoredNotes = f => botTexts(f, 10, /has been restored/);
const refusals = f => botTexts(f, 10, /could not be restored automatically/);
const assigneeNames = (f, n = 1) => f.state.issues.get(n).assignees.map(a => a.login);
const assignEvents = (f, login = 'alice') => f.state.events.get(1).filter(e => e.event === 'assigned' && e.assignee.login === login);
async function staleClosedAt(overrides) { const f = staleClosedFixture(overrides); await closeAsStale(f); return f; }

test('recovery: a stale-closed PR reopened by its author restores the assignment, label and a fresh window', async () => {
  const f = await staleClosedAt();
  assert.ok(botTexts(f, 10, /kubescape-policy:stale-closure-/).length === 1, 'the bot wrote a closure record');
  await reopen(f, ms(17, 9 * 3600e3));
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.deepEqual(assigneeNames(f), ['alice']);
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), true);
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  assert.equal(restoredNotes(f).length, 1);
  assert.match(restoredNotes(f)[0].body, /@alice, your assignment to #1 has been restored.*duplicate PR detection, still apply/s);
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
  assert.equal(Date.parse(assignEvents(f).at(-1).created_at), ms(17, 9 * 3600e3), 'assignment timer restarts at the restoration');
  // The reminder from before the closure is ignored and the window restarts from the reopening.
  const stage = f.state.comments.get(10).filter(isBot).length;
  for (const day of [18, 23]) { await runAt(f, ms(day, 7 * 3600e3)); assert.equal(f.state.prs.get(10).state, 'open', `day ${day}`); }
  assert.equal(prReminders(f).length, 1, 'no new reminder inside the first seven days');
  await runAt(f, ms(24, 10 * 3600e3));
  assert.equal(prReminders(f).length, 2);
  await runAt(f, ms(30, 12 * 3600e3));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(31, 12 * 3600e3));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.ok(stage > 0);
});

test('recovery: repeated or redelivered reopen events restore once and never override a later maintainer decision', async () => {
  const f = await staleClosedAt();
  await reopen(f, ms(17));
  for (let n = 0; n < 3; n++) await f.execute('pull_request_target', { action: 'reopened', pull_request: f.state.prs.get(10) });
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
  assert.equal(restoredNotes(f).length, 1);
  // A maintainer later removes the assignment; a redelivered event must not undo that.
  f.state.issues.get(1).assignees = [];
  await f.execute('pull_request_target', { action: 'reopened', pull_request: f.state.prs.get(10) });
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
});

test('recovery is refused, with the reason and next step, when its conditions fail', async () => {
  const cases = {
    'another contributor holds the issue': { mutate: f => { f.state.issues.get(1).assignees = [user('bob')]; }, reason: /already has an assignee/, keeps: ['bob'] },
    'the issue is closed': { mutate: f => { f.state.issues.get(1).state = 'closed'; }, reason: /closed/, keeps: [] },
    'the issue needs triage again': { mutate: f => { f.state.issues.get(1).labels.push(label(config.needsTriageLabel)); }, reason: /triage/, keeps: [] },
    'the contributor is at the assignment limit': { mutate: f => { for (const n of [2, 3, 4]) { f.state.issues.get(n).assignees.push(user('alice')); f.state.issues.get(n).labels.push(label(config.pinnedLabel)); } }, reason: /3 active issue assignments/, keeps: [] },
    'the beginner-label limit is reached': { mutate: f => { const good = label('good first issue'); f.state.issues.get(1).labels.push(good); for (const n of [2, 3]) { f.state.issues.get(n).assignees.push(user('alice')); f.state.issues.get(n).labels.push(good, label(config.pinnedLabel)); } }, reason: /good first issue/, keeps: [] },
    'the PR also links a nonexistent issue': { mutate: f => { f.state.prs.get(10).body = 'Fixes #1\nRefs #99'; }, reason: /#99 does not exist/, keeps: [] },
  };
  for (const [name, c] of Object.entries(cases)) {
    const f = await staleClosedAt();
    c.mutate(f);
    await reopen(f, ms(17));
    assert.equal(f.state.prs.get(10).state, 'closed', name);
    assert.deepEqual(assigneeNames(f), c.keeps, `${name}: nobody is assigned or displaced`);
    assert.equal(refusals(f).length, 1, name);
    assert.match(refusals(f)[0].body, c.reason, name);
    assert.match(refusals(f)[0].body, /ask a maintainer to assign you, then reopen this PR/, name);
    assert.equal(restoredNotes(f).length, 0, name);
    assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 0, name);
  }
});

test('recovery never bypasses duplicate validation: an eligible competing PR appearing mid-recovery blocks it', async () => {
  const f = await staleClosedAt();
  const list = f.github.rest.issues.listForRepo;
  let reads = 0;
  f.github.rest.issues.listForRepo = async args => {
    // The read immediately before the write: bob gets the issue and an eligible PR meanwhile.
    if (args.assignee === 'alice' && ++reads === 2) {
      f.state.issues.get(1).assignees.push(user('bob'));
      f.state.prs.set(9, bobPR(9, { created_at: date(0) }));
    }
    return list(args);
  };
  await reopen(f, ms(17));
  assert.deepEqual(assigneeNames(f), ['bob']);
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.prs.get(9).state, 'open');
  assert.equal(restoredNotes(f).length, 0);
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 0);
});

test('recovery is not blocked by an earlier PR that is not eligible, and duplicates are still enforced afterwards', async () => {
  const f = await staleClosedAt({ prs: [pr(10), pr(9, { user: user('carol'), head: { sha: '9'.repeat(40) } })] });
  await reopen(f, ms(17));
  assert.equal(f.state.prs.get(10).state, 'open'); // carol is not assigned: her PR is ineligible
  assert.deepEqual(assigneeNames(f), ['alice']);
});

test('ordinary closed PRs cannot use recovery, whoever closed them and whatever the comments say', async () => {
  const forged = { id: 7000, user: user('alice'), created_at: date(14), updated_at: date(14),
    body: `<!-- kubescape-policy:stale-closure-1-1 -->\n<!-- policy-data ${JSON.stringify({ user: 'alice', issues: [1], closed: date(15) })} -->\nRecord` };
  const cases = {
    'closed by the contributor': { closer: user('alice'), forge: true },
    'closed by a maintainer': { closer: user('maintainer'), forge: true },
    'forged record by a user named like the bot': { closer: user('alice'), forge: 'impersonation' },
  };
  for (const [name, c] of Object.entries(cases)) {
    const f = prFixture({ issues: [assigned()], prs: [pr(10)] });
    f.state.events.set(10, [{ id: 1, event: 'closed', actor: c.closer, created_at: date(15) }]);
    f.state.prs.get(10).state = 'closed'; f.state.prs.get(10).closed_at = date(15);
    f.state.issues.get(1).assignees = []; // released when it was closed
    f.state.comments.set(10, [c.forge === 'impersonation' ? { ...forged, user: user('github-actions[bot]', 'User') } : forged]);
    await reopen(f, ms(16));
    assert.equal(f.state.prs.get(10).state, 'closed', name);
    assert.deepEqual(assigneeNames(f), [], name);
    assert.equal(restoredNotes(f).length + refusals(f).length, 0, `${name}: not even attempted`);
  }
});

test('recovery is one-shot: a later non-inactivity closure by the bot cannot reuse the old record', async () => {
  const f = await staleClosedAt();
  await reopen(f, ms(17));
  assert.deepEqual(assigneeNames(f), ['alice']);
  f.state.issues.get(1).assignees = []; // a maintainer unassigns alice in the UI
  f.at(ms(18));
  await f.execute('issues', { action: 'unassigned', issue: f.state.issues.get(1), assignee: user('alice'), sender: user('maintainer') });
  assert.equal(f.state.prs.get(10).state, 'closed', 'closed by the bot for the missing assignment');
  await reopen(f, ms(19));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(restoredNotes(f).length, 1);
});

test('recovery requires the author to have reopened the PR', async () => {
  const f = await staleClosedAt();
  await reopen(f, ms(17), 10, 'maintainer');
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(restoredNotes(f).length + refusals(f).length, 0);
});

test('recovery needs the record to be tied to the closure: a failed record write leaves recovery unavailable and reported', async () => {
  const f = prFixture({ issues: [assigned(), issue(2), issue(3), issue(4)] });
  const create = f.github.rest.issues.createComment;
  f.github.rest.issues.createComment = async a => { if (/stale-closure-/.test(a.body)) throw new Error('comment update outage'); return create(a); };
  await runAt(f, ms(8));
  f.at(ms(15));
  await assert.rejects(f.execute('schedule'), /comment update outage/);
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.deepEqual(assigneeNames(f), []); // the release still happened
  f.github.rest.issues.createComment = create;
  await reopen(f, ms(17));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(restoredNotes(f).length, 0);
});

test('recovery API failures never close the PR, assign twice or leave a half-restored state; a retry completes it', async () => {
  const f = await staleClosedAt();
  const add = f.github.rest.issues.addAssignees;
  f.github.rest.issues.addAssignees = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  f.state.prs.get(10).state = 'open';
  f.state.events.set(10, [...f.state.events.get(10), { id: 4000, event: 'reopened', actor: user('alice'), created_at: date(17) }]);
  f.at(ms(17));
  await assert.rejects(f.execute('pull_request_target', { action: 'reopened', pull_request: f.state.prs.get(10) }), /Service Unavailable/);
  assert.equal(f.state.prs.get(10).state, 'open', 'a failed recovery does not close the PR');
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
  assert.equal(refusals(f).length + restoredNotes(f).length, 0, 'no outcome recorded, so a retry is allowed');
  f.github.rest.issues.addAssignees = add;
  await runAt(f, ms(18)); // the next scheduled run retries
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.deepEqual(assigneeNames(f), ['alice']);
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 1);
  assert.equal(restoredNotes(f).length, 1);
});

test('recovery does not claim an assignment GitHub silently dropped', async () => {
  const f = await staleClosedAt();
  f.github.rest.issues.addAssignees = async a => ({ data: structuredClone(f.state.issues.get(a.issue_number)) });
  await reopen(f, ms(17));
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), false);
  assert.equal(restoredNotes(f).length, 0);
  assert.match(refusals(f)[0].body, /GitHub did not assign you to #1/);
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('recovery that cannot restore every linked issue restores none', async () => {
  const f = prFixture({ issues: [assigned(), assigned('alice', { number: 2 }), issue(3), issue(4)], prs: [pr(10, { body: 'Fixes #1\nFixes #2' })] });
  f.state.events.get(2).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  await closeAsStale(f);
  assert.deepEqual([assigneeNames(f, 1), assigneeNames(f, 2)], [[], []]);
  f.state.issues.get(2).assignees = [user('bob')]; // #2 goes to someone else
  await reopen(f, ms(17));
  assert.deepEqual([assigneeNames(f, 1), assigneeNames(f, 2)], [[], ['bob']]);
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(f.state.mutations.filter(m => m[0] === 'assign').length, 0);
});

// Multi-issue recovery is all-or-nothing, whichever operation fails part-way.
async function threeIssueClosure() {
  const f = prFixture({ issues: [assigned(), assigned('alice', { number: 2 }), assigned('alice', { number: 3 }), issue(4)], prs: [pr(10, { body: 'Fixes #1\nFixes #2\nFixes #3' })] });
  for (const n of [2, 3]) f.state.events.get(n).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  await closeAsStale(f);
  assert.deepEqual([1, 2, 3].map(n => assigneeNames(f, n)), [[], [], []]);
  return f;
}
const holders = f => [1, 2, 3].map(n => assigneeNames(f, n).join('+') || '-').join(' ');
const net = f => f.state.mutations.filter(m => m[0] === 'assign').length - f.state.mutations.filter(m => m[0] === 'unassign').length;
const labelled = f => [1, 2, 3].map(n => hasLabelNamed(f.state.issues.get(n), config.assignedLabel));
const reopenAt = async (f, day) => {
  f.state.prs.get(10).state = 'open';
  f.state.events.set(10, [...f.state.events.get(10), { id: 4000 + day, event: 'reopened', actor: user('alice'), created_at: date(day) }]);
  f.at(ms(day));
  return f.execute('pull_request_target', { action: 'reopened', pull_request: f.state.prs.get(10) });
};
const failNth = (f, method, nth, error) => {
  const original = f.github.rest.issues[method];
  let calls = 0;
  f.github.rest.issues[method] = async args => { if (++calls === nth) throw error; return original(args); };
  return () => { f.github.rest.issues[method] = original; };
};

test('recovery: an API failure on any later issue releases the earlier ones and the retry completes all of them', async () => {
  for (const nth of [1, 2, 3]) {
    const f = await threeIssueClosure();
    const base = net(f);
    const heal = failNth(f, 'addAssignees', nth, Object.assign(new Error('Service Unavailable'), { status: 503 }));
    await assert.rejects(reopenAt(f, 17), /Service Unavailable/);
    assert.equal(holders(f), '- - -', `failure on write ${nth}: no partial assignment left`);
    assert.deepEqual(labelled(f), [false, false, false], `failure on write ${nth}: no stray labels`);
    assert.equal(f.state.prs.get(10).state, 'open', 'a failed recovery never closes the PR');
    assert.equal(refusals(f).length + restoredNotes(f).length, 0, 'no outcome recorded, so a retry is allowed');
    heal();
    await runAt(f, ms(18));
    assert.equal(holders(f), 'alice alice alice', `retry after failure on write ${nth}`);
    assert.deepEqual(labelled(f), [true, true, true]);
    assert.equal(restoredNotes(f).length, 1);
    assert.equal(net(f) - base, 3, 'net assignments equal the three issues: nothing leaked, nothing duplicated');
    assert.equal(f.state.prs.get(10).state, 'open');
  }
});

test('recovery: when the rollback itself fails the state is reported and the retry converges without duplicates', async () => {
  const f = await threeIssueClosure();
  const base = net(f);
  const healWrite = failNth(f, 'addAssignees', 3, new Error('write outage'));
  const healRollback = failNth(f, 'removeAssignees', 1, new Error('rollback outage')); // releasing #1 fails
  await assert.rejects(reopenAt(f, 17), error => /write outage/.test(error.message) || /rollback outage/.test(error.message));
  // #2 was released despite #1's release failing: each rollback step is independent.
  assert.equal(holders(f), 'alice - -');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(refusals(f).length + restoredNotes(f).length, 0);
  healWrite(); healRollback();
  await runAt(f, ms(18));
  assert.equal(holders(f), 'alice alice alice');
  assert.equal(net(f) - base, 3);
  assert.deepEqual([1, 2, 3].map(n => assigneeNames(f, n).length), [1, 1, 1], 'no duplicate assignee entries');
  assert.equal(restoredNotes(f).length, 1);
});

test('recovery: a refusal, a dropped assignee or a failed recheck part-way releases everything already restored', async () => {
  const injections = {
    'another contributor takes the last issue': f => { const list = f.github.rest.issues.listForRepo; let n = 0; f.github.rest.issues.listForRepo = async a => { if (a.assignee === 'alice' && ++n === 6) f.state.issues.get(3).assignees.push(user('bob')); return list(a); }; },
    'GitHub drops the second assignee': f => { const add = f.github.rest.issues.addAssignees; let n = 0; f.github.rest.issues.addAssignees = async a => { if (++n === 2) return { data: structuredClone(f.state.issues.get(a.issue_number)) }; return add(a); }; },
    'the recheck read fails for the second issue': f => failNth(f, 'listForRepo', 5, new Error('list outage')),
  };
  for (const [name, inject] of Object.entries(injections)) {
    const f = await threeIssueClosure();
    inject(f);
    await reopenAt(f, 17).catch(() => {});
    assert.ok(!['alice', 'alice alice', 'alice alice -'].includes(holders(f)) && !/alice/.test(holders(f).replace(/bob/g, '')), `${name}: ${holders(f)}`);
    assert.deepEqual(labelled(f).slice(0, 2), [false, false], name);
    assert.equal(restoredNotes(f).length, 0, name);
  }
});

test('recovery of an issue the author was not assigned to at closure is refused', async () => {
  const f = await staleClosedAt();
  f.state.prs.get(10).body = 'Fixes #1\nFixes #2'; // the contributor edits the closed PR to claim another free issue
  await reopen(f, ms(17));
  assert.deepEqual([assigneeNames(f, 1), assigneeNames(f, 2)], [[], []]);
  assert.match(refusals(f)[0].body, /not assigned to #2 when this PR was closed/);
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('reopening is refused when another contributor now holds the issue', async () => {
  const f = staleClosedFixture();
  await closeAsStale(f);
  f.state.issues.get(1).assignees.push(user('bob'));
  await reopen(f, ms(16));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.deepEqual(f.state.issues.get(1).assignees.map(a => a.login), ['bob']);
});

test('reopening is refused when another valid PR already covers the issue', async () => {
  const f = staleClosedFixture();
  await closeAsStale(f);
  f.state.issues.get(1).assignees.push(user('alice'), user('bob'));
  f.state.prs.set(9, pr(9, { user: user('bob'), head: { sha: '9'.repeat(40) } }));
  f.state.prs.get(9).created_at = date(0.5);
  await reopen(f, ms(16));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.match(botTexts(f, 10, /kubescape-policy:closure -->/).at(-1).body, /open PR from a current assignee: #9/);
  assert.equal(f.state.prs.get(9).state, 'open');
});

test('an assignee already at the three-assignment limit cannot be reassigned, so the PR stays closed', async () => {
  const f = staleClosedFixture();
  await closeAsStale(f);
  for (const n of [2, 3, 4]) f.state.issues.get(n).assignees.push(user('alice'));
  await f.command(1, '/assign @alice', 'maintainer');
  assert.deepEqual(f.state.issues.get(1).assignees, []);
  assert.match(botTexts(f, 1, /3 active issue assignments|already have 3/).at(-1).body, /3 active issue assignments/);
  await reopen(f, ms(16));
  assert.equal(f.state.prs.get(10).state, 'closed');
});

test('a closed or untriaged issue keeps a reopened PR closed', async () => {
  const closed = staleClosedFixture();
  await closeAsStale(closed);
  closed.state.issues.get(1).state = 'closed';
  await reopen(closed, ms(16));
  assert.equal(closed.state.prs.get(10).state, 'closed');
  const untriaged = staleClosedFixture();
  await closeAsStale(untriaged);
  untriaged.state.issues.get(1).labels.push(label(config.needsTriageLabel));
  untriaged.state.issues.get(1).assignees.push(user('alice'));
  await reopen(untriaged, ms(16));
  assert.equal(untriaged.state.prs.get(10).state, 'closed');
  assert.match(botTexts(untriaged, 10, /kubescape-policy:closure -->/).at(-1).body, /needs maintainer triage/);
});

test('a PR closed for a different policy violation gets that violation, not the inactivity wording', async () => {
  const f = fixture({ day: 2, issues: [issue(1, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr()] });
  await f.execute('pull_request_target', { pull_request: pr() });
  assert.equal(f.state.prs.get(10).state, 'closed');
  const first = botTexts(f, 10, /kubescape-policy:closure -->/).at(-1).body;
  assert.match(first, /needs maintainer triage/);
  assert.doesNotMatch(first, /no response|inactiv/i);
  f.state.issues.get(1).labels = [label(config.assignedLabel)];
  f.state.issues.get(1).assignees = [user('alice')];
  await reopen(f, ms(3));
  assert.equal(f.state.prs.get(10).state, 'open');
});

// -- Duplicate PR eligibility ------------------------------------------------

const both = () => issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice'), user('bob')] });
const bobPR = (number = 11, overrides = {}) => pr(number, { user: user('bob'), head: { sha: String(number).repeat(40).slice(0, 40) }, ...overrides });
const openedEvent = (f, n) => f.execute('pull_request_target', { action: 'opened', pull_request: f.state.prs.get(n) });

test('duplicates: two assigned contributors with valid PRs keep exactly the earliest one', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10), bobPR(11)] });
  await openedEvent(f, 11);
  assert.deepEqual([...f.state.prs.values()].map(p => p.state), ['open', 'closed']);
  assert.equal(f.state.checkWrites.filter(w => w.head_sha === SHA).at(-1).conclusion, 'success');
});

test('duplicates: an invalid earlier PR does not block a valid later PR, whatever invalidates it', async () => {
  const cases = {
    'nonexistent issue': { issues: [both()], body: 'Fixes #1, Fixes #99' },
    'untriaged linked issue': { issues: [both(), issue(2, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], body: 'Fixes #1\nRefs #2' },
    'closed linked issue': { issues: [both(), issue(2, { state: 'closed', assignees: [user('alice')] })], body: 'Fixes #1\nRefs #2' },
    'pull request as issue': { issues: [both()], body: 'Fixes #1\nRefs #11', extraPR: pr(11) },
  };
  for (const [name, c] of Object.entries(cases)) {
    const f = fixture({ issues: c.issues, prs: [pr(10, { body: c.body }), bobPR(12)] });
    if (c.extraPR) f.state.prs.set(11, { ...c.extraPR, user: user('carol'), body: 'unrelated' });
    await openedEvent(f, 12);
    assert.equal(f.state.prs.get(12).state, 'open', name);
    assert.equal(f.state.checkWrites.filter(w => w.head_sha === f.state.prs.get(12).head.sha).at(-1).conclusion, 'success', name);
    assert.equal(f.state.prs.get(10).state, 'open', name); // invalid, but not closed: it only fails its check
  }
});

test('duplicates: an earlier PR by someone who is no longer assigned does not block', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('bob')] })], prs: [pr(10), bobPR(11)] });
  await openedEvent(f, 11);
  assert.equal(f.state.prs.get(11).state, 'open');
});

test('duplicates: reopening an eligible earlier PR revalidates the later one; an ineligible one does not', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10, { state: 'closed' }), bobPR(11)] });
  await openedEvent(f, 11);
  assert.equal(f.state.prs.get(11).state, 'open');
  await reopen(f, ms(13), 10);
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(f.state.prs.get(11).state, 'closed');
  const g = fixture({ issues: [both()], prs: [pr(10, { state: 'closed', body: 'Fixes #1, Fixes #99' }), bobPR(11)] });
  await openedEvent(g, 11);
  await reopen(g, ms(13), 10);
  assert.equal(g.state.prs.get(11).state, 'open');
});

test('duplicates: closing or editing the earlier PR revalidates the later one', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10), bobPR(11, { labels: [label(config.pinnedLabel)] })] });
  await f.execute('pull_request_target', { action: 'opened', pull_request: f.state.prs.get(11) });
  assert.equal(f.state.checkWrites.filter(w => w.head_sha === f.state.prs.get(11).head.sha).at(-1).conclusion, 'failure'); // pinned: fails but stays open
  f.state.prs.get(10).state = 'closed';
  await f.execute('pull_request_target', { action: 'closed', pull_request: f.state.prs.get(10) });
  assert.equal(f.state.checkWrites.filter(w => w.head_sha === f.state.prs.get(11).head.sha).at(-1).conclusion, 'success');
  const g = fixture({ issues: [both()], prs: [pr(10), bobPR(11, { labels: [label(config.pinnedLabel)] })] });
  await g.execute('pull_request_target', { action: 'opened', pull_request: g.state.prs.get(11) });
  const oldBody = g.state.prs.get(10).body;
  g.state.prs.get(10).body = 'Fixes #99'; // the earlier PR no longer targets the issue
  await g.execute('pull_request_target', { action: 'edited', pull_request: g.state.prs.get(10), changes: { body: { from: oldBody } } });
  assert.equal(g.state.checkWrites.filter(w => w.head_sha === g.state.prs.get(11).head.sha).at(-1).conclusion, 'success');
});

test('duplicates: an earlier PR becoming ineligible frees a later PR on the next issue event', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10), bobPR(11, { labels: [label(config.pinnedLabel)] })] });
  await f.execute('pull_request_target', { action: 'opened', pull_request: f.state.prs.get(11) });
  f.state.issues.get(1).assignees = [user('bob')];
  await f.execute('issues', { action: 'unassigned', issue: f.state.issues.get(1), assignee: user('alice'), sender: user('maintainer') });
  assert.equal(f.state.checkWrites.filter(w => w.head_sha === f.state.prs.get(11).head.sha).at(-1).conclusion, 'success');
});

test('duplicates: an issue event revalidates PRs that share an issue with an affected PR, in both directions', async () => {
  const pinned = label(config.pinnedLabel);
  const two = () => issue(2, { labels: [label(config.assignedLabel)], assignees: [user('alice')] });
  // The earlier PR becomes ineligible through its OTHER issue: the later PR (linking only #1) is freed.
  const freed = fixture({ issues: [both(), two()], prs: [pr(10, { body: 'Fixes #1\nRefs #2' }), bobPR(11, { labels: [pinned] })] });
  await openedEvent(freed, 11);
  assert.equal(freed.state.checkWrites.filter(w => w.head_sha === freed.state.prs.get(11).head.sha).at(-1).conclusion, 'failure');
  freed.state.issues.get(2).state = 'closed';
  await freed.execute('issues', { action: 'closed', issue: freed.state.issues.get(2), sender: user('maintainer') });
  assert.equal(freed.state.checkWrites.filter(w => w.head_sha === freed.state.prs.get(11).head.sha).at(-1).conclusion, 'success');
  // The earlier PR becomes eligible through its OTHER issue: the later PR is now a duplicate.
  const blocked = fixture({ issues: [both(), issue(2, { labels: [label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr(10, { body: 'Fixes #1\nRefs #2' }), bobPR(11)] });
  await openedEvent(blocked, 11);
  assert.equal(blocked.state.prs.get(11).state, 'open');
  blocked.state.issues.get(2).labels = [];
  await blocked.execute('issues', { action: 'unlabeled', issue: blocked.state.issues.get(2), label: label(config.needsTriageLabel), sender: user('maintainer') });
  assert.equal(blocked.state.prs.get(11).state, 'closed');
});

test('duplicates: simultaneous PRs resolve to the same survivor in any event order', async () => {
  for (const order of [[11, 12], [12, 11], [12, 12, 11]]) {
    const f = fixture({ issues: [both()], prs: [pr(10, { body: 'Fixes #99' }), bobPR(11), pr(12, { user: user('alice'), head: { sha: 'c'.repeat(40) } })] });
    for (const n of order) await openedEvent(f, n);
    assert.deepEqual([11, 12].map(n => f.state.prs.get(n).state), ['open', 'closed'], order.join());
    assert.equal(f.state.prs.get(10).state, 'open');
  }
});

test('duplicates: with several linked issues each issue is evaluated independently', async () => {
  const f = fixture({ issues: [both(), issue(2, { labels: [label(config.assignedLabel)], assignees: [user('alice'), user('bob')] })], prs: [pr(10, { body: 'Fixes #1\nFixes #2' }), bobPR(11, { body: 'Fixes #2' })] });
  await openedEvent(f, 11);
  assert.equal(f.state.prs.get(11).state, 'closed');
  assert.match(botTexts(f, 11, /kubescape-policy:closure -->/).at(-1).body, /Issue #2 already has an open PR from a current assignee: #10/);
  const g = fixture({ issues: [both(), issue(2, { labels: [label(config.assignedLabel)], assignees: [user('alice'), user('bob')] })], prs: [pr(10, { body: 'Fixes #1\nFixes #99' }), bobPR(11, { body: 'Fixes #2' })] });
  await openedEvent(g, 11);
  assert.equal(g.state.prs.get(11).state, 'open');
});

test('duplicates: draft PRs block like any other eligible PR and a shared head aggregates one check', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10, { draft: true }), bobPR(11, { head: { sha: SHA } })] });
  await openedEvent(f, 11);
  assert.equal(f.state.prs.get(11).state, 'closed');
  assert.equal(f.state.checks.size, 1);
  const check = f.state.checkWrites.at(-1);
  assert.equal(check.conclusion, 'failure');
  assert.match(check.output.summary, /#10: Passed/);
  assert.match(check.output.summary, /#11:.*already has an open PR/);
});

test('duplicates: an existing success is withdrawn when the PR stops being eligible', async () => {
  const f = fixture({ issues: [assigned()], prs: [pr(10, { labels: [label(config.pinnedLabel)] })] });
  await f.execute('pull_request_target', { pull_request: pr(10) });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'success');
  f.state.issues.get(1).assignees = [];
  await f.execute('issues', { action: 'unassigned', issue: f.state.issues.get(1), assignee: user('alice'), sender: user('maintainer') });
  assert.equal(f.state.checkWrites.at(-1).conclusion, 'failure');
});

test('duplicates: after every relevant event two eligible duplicates never both pass', async () => {
  const f = fixture({ issues: [both()], prs: [pr(10, { state: 'closed' }), bobPR(11)] });
  await openedEvent(f, 11);
  await reopen(f, ms(13), 10);
  const open = [...f.state.prs.values()].filter(p => p.state === 'open');
  assert.equal(open.length, 1);
  assert.equal(open[0].number, 10);
});

// -- Assigned label ----------------------------------------------------------

const unassignedEvent = (f, login) => f.execute('issues', { action: 'unassigned', issue: structuredClone(f.state.issues.get(1)), assignee: user(login), sender: user('maintainer') });
const hasAssigned = f => hasLabelNamed(f.state.issues.get(1), config.assignedLabel);

test('label: manually removing the last assignee in the UI removes the Assigned label, using live state', async () => {
  const f = fixture({ issues: [assigned('bob')] });
  f.state.issues.get(1).assignees = [];
  await unassignedEvent(f, 'bob');
  assert.equal(hasAssigned(f), false);
  await unassignedEvent(f, 'bob'); // repeated delivery
  assert.equal(hasAssigned(f), false);
});

test('label: removing one of several assignees keeps the label, and a stale payload cannot strip it', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('carol'), user('bob')] })] });
  f.state.issues.get(1).assignees = [user('carol')];
  await unassignedEvent(f, 'bob');
  assert.equal(hasAssigned(f), true);
  const g = fixture({ issues: [assigned('bob')] });
  await g.execute('issues', { action: 'unassigned', issue: issue(1), assignee: user('alice'), sender: user('maintainer') }); // payload claims nobody is assigned
  assert.equal(hasAssigned(g), true);
});

test('label: /unassign-me and /unassign release honestly, repeat safely and keep the label for remaining assignees', async () => {
  const f = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('bob'), user('carol')] })] });
  f.state.permissions.set('dave', 'read');
  const last = () => botTexts(f, 1, /command-/).at(-1).body.split('\n')[1];
  await f.command(1, '/unassign-me', 'bob');
  assert.equal(last(), '@bob, your assignment has been released.');
  assert.equal(hasAssigned(f), true); // carol remains
  await f.command(1, '/unassign-me', 'bob');
  assert.equal(last(), '@bob, you are not assigned to this issue.');
  await f.command(1, '/unassign-me', 'dave');
  assert.equal(last(), '@dave, you are not assigned to this issue.');
  await f.command(1, '/unassign @carol', 'maintainer');
  assert.equal(last(), '@carol, your assignment has been released.');
  assert.equal(hasAssigned(f), false);
  await f.command(1, '/unassign @carol', 'maintainer');
  assert.equal(last(), '@maintainer, carol is not assigned to this issue.');
  assert.equal(f.state.mutations.filter(m => m[0] === 'unassign').length, 2);
});

test('label: expiry, PR-closure release, self-assignment rollback and reassignment all keep the label accurate', async () => {
  const expiry = assignmentFixture();
  await runAt(expiry, ms(8));
  await runAt(expiry, ms(15));
  assert.equal(hasAssigned(expiry), false);
  const closure = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel), label(config.needsTriageLabel)], assignees: [user('alice')] })], prs: [pr()] });
  await closure.execute('pull_request_target', { pull_request: pr() });
  assert.deepEqual(closure.state.issues.get(1).assignees, []);
  assert.equal(hasAssigned(closure), false);
  const rollback = fixture({ issues: [issue(1)] });
  rollback.state.issues.get(1).assignees = [user('alice')];
  rollback.state.events.set(1, [{ id: 50, event: 'assigned', actor: user('alice'), assignee: user('alice'), created_at: date(12) }]);
  await rollback.execute('issues', { action: 'assigned', issue: issue(1), assignee: user('alice'), sender: user('alice') });
  assert.deepEqual(rollback.state.issues.get(1).assignees, []);
  assert.equal(hasAssigned(rollback), false);
  const reassign = fixture({ issues: [issue(1)] });
  await reassign.command(1, '/assign @alice', 'maintainer');
  await reassign.command(1, '/unassign @alice', 'maintainer');
  assert.equal(hasAssigned(reassign), false);
  await reassign.command(1, '/assign @bob', 'maintainer');
  assert.equal(hasAssigned(reassign), true);
});

test('label: scheduled reconciliation repairs wrong labels in both directions and tolerates missing labels', async () => {
  const f = fixture({ day: 2, issues: [issue(1, { labels: [label(config.assignedLabel)] }), issue(2, { assignees: [user('alice')] }),
    issue(3, { labels: [label(config.assignedLabel)], assignees: [user('bob')] }), issue(4)] });
  await f.execute('schedule');
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), false);
  assert.equal(hasLabelNamed(f.state.issues.get(2), config.assignedLabel), true);
  assert.equal(hasLabelNamed(f.state.issues.get(3), config.assignedLabel), true);
  assert.equal(hasLabelNamed(f.state.issues.get(4), config.assignedLabel), false);
  const race = fixture({ day: 2, issues: [issue(1, { labels: [label(config.assignedLabel)] })] });
  race.github.rest.issues.removeLabel = async () => { throw Object.assign(new Error('Label does not exist'), { status: 404 }); };
  await race.execute('schedule'); // the label vanished between read and delete
});

test('label: a partial failure keeps the release, reports the error, and the next run repairs the label', async () => {
  const f = fixture({ issues: [assigned('bob')] });
  const remove = f.github.rest.issues.removeLabel;
  f.github.rest.issues.removeLabel = async () => { throw new Error('label outage'); };
  await assert.rejects(f.command(1, '/unassign-me', 'bob'), /label outage/);
  assert.deepEqual(f.state.issues.get(1).assignees, []);
  assert.match(botTexts(f, 1, /command-/).at(-1).body, /released/); // not "you are not assigned"
  f.github.rest.issues.removeLabel = remove;
  await f.execute('schedule');
  assert.equal(hasAssigned(f), false);
});

test('label: a permission failure on unassignment leaves assignment and label untouched and reports the error', async () => {
  const f = fixture({ issues: [assigned('bob')] });
  f.github.rest.issues.removeAssignees = async () => { throw Object.assign(new Error('Resource not accessible by integration'), { status: 403 }); };
  await assert.rejects(f.command(1, '/unassign-me', 'bob'), /not accessible/);
  assert.deepEqual(f.state.issues.get(1).assignees.map(a => a.login), ['bob']);
  assert.equal(hasAssigned(f), true);
  assert.equal(botTexts(f, 1, /command-/).length, 0);
});

test('label: manual edits of the Assigned label are corrected from the live assignee list', async () => {
  const f = fixture({ issues: [assigned('bob')] });
  f.state.issues.get(1).labels = [];
  await f.execute('issues', { action: 'unlabeled', issue: f.state.issues.get(1), label: label(config.assignedLabel) });
  assert.equal(hasAssigned(f), true);
  const g = fixture({ issues: [issue(1, { labels: [label(config.assignedLabel)] })] });
  await g.execute('issues', { action: 'labeled', issue: g.state.issues.get(1), label: label(config.assignedLabel) });
  assert.equal(hasAssigned(g), false);
});

test('label: an assignment whose label write failed is repaired by the scheduled run and then expires normally', async () => {
  const f = fixture({ day: 5, issues: [issue(1)] });
  const add = f.github.rest.issues.addLabels;
  f.github.rest.issues.addLabels = async a => { if (a.labels.includes(config.assignedLabel)) throw Object.assign(new Error('Bad Gateway'), { status: 502 }); return add(a); };
  await assert.rejects(f.command(1, '/assign @bob', 'maintainer'), /Bad Gateway/);
  f.github.rest.issues.addLabels = add;
  f.state.events.get(1).push({ id: 60, event: 'assigned', assignee: user('bob'), actor: user('maintainer'), created_at: date(5) });
  await runAt(f, ms(5));
  assert.equal(hasAssigned(f), true); // reconciliation added the missing label
  await runAt(f, ms(12));
  assert.match(assignmentReminders(f).at(-1).body, /@bob/);
  await runAt(f, ms(19));
  assert.deepEqual(f.state.issues.get(1).assignees, []);
  assert.equal(hasAssigned(f), false);
});

test('thresholds come only from config and the old values are gone', () => {
  assert.deepEqual([config.inactivityReminderDays, config.inactivityExpiryDays, config.reminderToActionDays], [7, 14, 7]);
  for (const stale of ['assignmentReminderDays', 'assignmentExpiryDays', 'requestedChangesStaleDays', 'stalePRCloseDays']) assert.equal(stale in config, false);
  const source = require('node:fs').readFileSync(require.resolve('../policy.cjs'), 'utf8');
  assert.doesNotMatch(source, /\b\d+ \* DAY\b/); // no hardcoded day counts: only DAY multiplied by a config value
});

// -- Review follow-ups ---------------------------------------------------------

const spyIssueReads = (f, numbers) => {
  const calls = [];
  for (const method of ['get', 'listComments', 'listEventsForTimeline']) {
    const original = f.github.rest.issues[method];
    f.github.rest.issues[method] = async args => { if (numbers.includes(args.issue_number)) calls.push(`${method} #${args.issue_number}`); return original(args); };
  }
  return calls;
};
const quiet = promise => promise.catch(() => {});

test('pre-rollout assigned issues are neither labelled nor read by any scheduled run', async () => {
  const old = { created_at: date(-10), updated_at: date(-5) };
  const f = fixture({ day: 1, issues: [issue(5, { ...old, assignees: [user('alice')] }), issue(6, { ...old, assignees: [user('bob')], labels: [label(config.assignedLabel)] })] });
  for (const n of [5, 6]) f.state.events.set(n, [{ id: 1, event: 'assigned', actor: user('maintainer'), assignee: user('alice'), created_at: date(-9) }]);
  const calls = spyIssueReads(f, [5, 6]);
  for (const day of [10, 11, 30]) await runAt(f, ms(day));
  assert.equal(hasLabelNamed(f.state.issues.get(5), config.assignedLabel), false, 'backlog issue stays unlabelled');
  assert.deepEqual(f.state.mutations, [], 'nothing was written');
  assert.deepEqual(calls, [], 'no detail, timeline or comment reads for backlog issues');
  assert.deepEqual(f.state.issues.get(6).assignees.map(a => a.login), ['bob'], 'and nothing was released');
});

test('an assignment made after rollout on an older issue is still labelled, reminded and released', async () => {
  const f = fixture({ day: 1, issues: [issue(5, { created_at: date(-10), updated_at: date(3), assignees: [user('alice')] })] });
  f.state.events.set(5, [{ id: 1, event: 'assigned', actor: user('maintainer'), assignee: user('alice'), created_at: date(3) }]);
  await runAt(f, ms(5));
  assert.equal(hasLabelNamed(f.state.issues.get(5), config.assignedLabel), true);
  await runAt(f, ms(10));
  assert.equal(assignmentReminders(f, 5).length, 1);
  await runAt(f, ms(17));
  assert.deepEqual(f.state.issues.get(5).assignees, []);
});

test('closed issues never gain the Assigned label, including after a maintainer removes it', async () => {
  const f = fixture({ day: 5, issues: [issue(1, { state: 'closed', assignees: [user('alice')] })] });
  const closed = () => structuredClone(f.state.issues.get(1));
  for (const action of ['unlabeled', 'labeled', 'unassigned']) {
    await f.execute('issues', { action, issue: closed(), label: label(config.assignedLabel), assignee: user('alice'), sender: user('maintainer') });
  }
  await runAt(f, ms(6));
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), false);
  assert.deepEqual(f.state.mutations, []);
  // The same edit on an open issue is still corrected from the live assignee list.
  f.state.issues.get(1).state = 'open';
  await f.execute('issues', { action: 'unlabeled', issue: closed(), label: label(config.assignedLabel), sender: user('maintainer') });
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), true);
});

test('stale label: a failed label write after the reminder is repaired by the next run without a second reminder', async () => {
  const f = prFixture();
  const original = f.github.rest.issues.addLabels;
  f.github.rest.issues.addLabels = async a => { throw Object.assign(new Error('label outage'), { status: 503 }); };
  await quiet(runAt(f, ms(8)));
  assert.equal(prReminders(f).length, 1);
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), false);
  f.github.rest.issues.addLabels = original;
  await runAt(f, ms(9));
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), true);
  assert.equal(prReminders(f).length, 1);
});

test('stale label: a manually removed label is restored inside the window and the PR is never closed without it', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  const strip = () => { f.state.prs.get(10).labels = f.state.prs.get(10).labels.filter(l => l.name !== config.staleLabel); };
  strip();
  await runAt(f, ms(10));
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), true);
  assert.equal(prReminders(f).length, 1);
  strip();
  const original = f.github.rest.issues.addLabels;
  f.github.rest.issues.addLabels = async () => { throw new Error('label outage'); };
  await quiet(runAt(f, ms(15)));
  assert.equal(f.state.prs.get(10).state, 'open', 'no closure while the label cannot be applied');
  f.github.rest.issues.addLabels = original;
  await runAt(f, ms(15, 1000));
  assert.equal(f.state.prs.get(10).state, 'closed');
  assert.equal(hasLabelNamed(f.state.prs.get(10), config.staleLabel), true);
});

test('an author comment written before the reopening does not answer the restarted window', async () => {
  const f = await staleClosedAt();
  f.state.comments.set(10, [...f.state.comments.get(10), { id: 7001, user: user('alice'), body: 'Sorry for the delay, reopening now', created_at: date(16), updated_at: date(16) }]);
  await reopen(f, ms(17));
  assert.equal(f.state.prs.get(10).state, 'open');
  await runAt(f, ms(23));
  assert.equal(prReminders(f).length, 1);
  await runAt(f, ms(24));
  assert.equal(prReminders(f).length, 2, 'the fresh window still produces its reminder');
  await runAt(f, ms(31));
  assert.equal(f.state.prs.get(10).state, 'closed', 'and its closure');
});

test('an author comment written after the reopening answers the restarted window', async () => {
  const f = await staleClosedAt();
  await reopen(f, ms(17));
  f.state.comments.set(10, [...f.state.comments.get(10), { id: 7002, user: user('alice'), body: 'Working on it', created_at: new Date(ms(17, 3600e3)).toISOString(), updated_at: date(17) }]);
  for (const day of [24, 31, 40]) await runAt(f, ms(day));
  assert.equal(prReminders(f).length, 1);
  assert.equal(f.state.prs.get(10).state, 'open');
});

test('closing: a failed close leaves no record and no false claim; a later close writes one record once', async () => {
  const f = prFixture();
  await runAt(f, ms(8));
  const update = f.github.rest.pulls.update;
  f.github.rest.pulls.update = async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); };
  await quiet(runAt(f, ms(15)));
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.equal(botTexts(f, 10, /Record for|stale-closure-/).length, 0, 'no record on an open PR');
  f.github.rest.pulls.update = update;
  await runAt(f, ms(16));
  assert.equal(f.state.prs.get(10).state, 'closed');
  await runAt(f, ms(17));
  const records = botTexts(f, 10, /stale-closure-/);
  assert.equal(records.length, 1, 'exactly one record');
  const data = JSON.parse(records[0].body.match(/<!-- policy-data (\{.*\}) -->/)[1]);
  assert.equal(data.closed, f.state.prs.get(10).closed_at, 'tied to the closure');
  assert.doesNotMatch(records[0].body, /reopen/i, 'reopen instructions are only in the closure comment');
  assert.equal(botTexts(f, 10, /kubescape-policy:closure -->/).length, 1);
});

// Aggregate limits: nothing is assigned, notified or rolled back when the whole recovery cannot fit.
async function twoIssueClosure({ held = [], labels = [] } = {}) {
  const heldIssues = held.map((n, i) => issue(n, { assignees: [user('alice')], labels: [label(config.pinnedLabel), ...(labels[i + 2] ? [label(labels[i + 2])] : [])] }));
  const f = prFixture({ issues: [assigned('alice', { labels: [label(config.assignedLabel), ...(labels[0] ? [label(labels[0])] : [])] }),
    assigned('alice', { number: 2, labels: [label(config.assignedLabel), ...(labels[1] ? [label(labels[1])] : [])] }), ...heldIssues], prs: [pr(10, { body: 'Fixes #1\nFixes #2' })] });
  f.state.events.get(2).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  for (const n of held) f.state.events.set(n, [{ id: 1, event: 'assigned', actor: user('maintainer'), assignee: user('alice'), created_at: date(1) }]);
  await closeAsStale(f);
  return f;
}

test('recovery: a two-issue PR is refused as a whole when the combined count exceeds maxAssignments, with no assign or release churn', async () => {
  const f = await twoIssueClosure({ held: [5, 6] }); // 2 held + 2 restored > 3
  const before = f.state.mutations.length;
  await reopenAt(f, 17);
  assert.deepEqual([1, 2].map(n => assigneeNames(f, n)), [[], []]);
  assert.equal(f.state.mutations.slice(before).filter(m => ['assign', 'unassign'].includes(m[0])).length, 0, 'no assignment and no rollback');
  assert.equal(f.state.events.get(1).filter(e => e.event === 'assigned').length, 1, 'no assignment event was emitted');
  assert.equal(refusals(f).length, 1);
  assert.equal(restoredNotes(f).length, 0);
});

test('recovery: a two-issue PR that fits within maxAssignments is restored in full', async () => {
  const f = await twoIssueClosure({ held: [5] }); // 1 held + 2 restored = 3
  await reopenAt(f, 17);
  assert.deepEqual([1, 2].map(n => assigneeNames(f, n)), [['alice'], ['alice']]);
  assert.equal(restoredNotes(f).length, 1);
});

test('recovery: beginner-label capacity is checked across all targets before anything is assigned', async () => {
  const first = 'good first issue';
  const over = await twoIssueClosure({ held: [5], labels: [first, first, first] }); // 1 held + 2 restored > 2
  const before = over.state.mutations.length;
  await reopenAt(over, 17);
  assert.deepEqual([1, 2].map(n => assigneeNames(over, n)), [[], []]);
  assert.equal(over.state.mutations.slice(before).filter(m => ['assign', 'unassign'].includes(m[0])).length, 0);
  assert.equal(refusals(over).length, 1);
  const fits = await twoIssueClosure({ labels: [first, first] }); // 2 restored = 2
  await reopenAt(fits, 17);
  assert.deepEqual([1, 2].map(n => assigneeNames(fits, n)), [['alice'], ['alice']]);
});

test('recovery trusts a closing event only when its actor is a Bot account named like the policy bot', async () => {
  const f = await staleClosedAt();
  const closed = f.state.events.get(10).filter(e => e.event === 'closed').at(-1);
  closed.actor = user('github-actions[bot]', 'User');
  await reopen(f, ms(17));
  assert.deepEqual(assigneeNames(f), []);
  assert.equal(restoredNotes(f).length, 0);
});

test('a refused self-assignment synchronizes the label exactly once, inside the error handling', async () => {
  const f = fixture({ day: 1, issues: [issue(1, { assignees: [user('alice')], labels: [label(config.assignedLabel)] })] });
  f.state.events.get(1).push({ id: 9, event: 'assigned', actor: user('alice'), assignee: user('alice'), created_at: date(1) });
  let readsAfterRelease = 0, released = false;
  const remove = f.github.rest.issues.removeAssignees, get = f.github.rest.issues.get;
  f.github.rest.issues.removeAssignees = async a => { released = true; return remove(a); };
  f.github.rest.issues.get = async a => { if (released) readsAfterRelease++; return get(a); };
  await f.execute('issues', { action: 'assigned', issue: structuredClone(f.state.issues.get(1)), assignee: user('alice'), sender: user('alice') });
  assert.deepEqual(f.state.issues.get(1).assignees, []);
  assert.equal(hasLabelNamed(f.state.issues.get(1), config.assignedLabel), false);
  assert.equal(readsAfterRelease, 2, 'one read by the single synchronization (label removal check included), none by a second one');
});
