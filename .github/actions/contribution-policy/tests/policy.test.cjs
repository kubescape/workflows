'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { run, issueLinks, assignmentProblem, assignmentActivity, changesRequested } = require('../policy.cjs');
const config = require('../config.json');
const DAY = 86_400_000;
const epoch = Date.parse('2026-12-01T00:00:00Z');
const date = day => new Date(epoch + day * DAY).toISOString();
const user = (login, type = 'User') => ({ login, type });
const label = name => ({ name });
const issue = (number, overrides = {}) => ({ number, state: 'open', labels: [], assignees: [], user: user('reporter'), created_at: date(1), updated_at: date(1), ...overrides });
const pr = (number = 10, overrides = {}) => ({ ...issue(number), user: user('alice'), body: 'Fixes #1', head: { sha: number === 10 ? 'a'.repeat(40) : String(number).padStart(40, '0') }, merged: false, ...overrides });

function fixture({ issues = [issue(1, { assignees: [user('alice')] })], prs = [], day = 12, repository = 'kubescape/kubescape' } = {}) {
  const state = { issues: new Map(issues.map(i => [i.number, structuredClone(i)])), prs: new Map(prs.map(p => [p.number, structuredClone(p)])), comments: new Map(), events: new Map(), reviews: new Map(), inline: new Map(), permissions: new Map([['maintainer', 'write']]), checks: new Map(), checkWrites: [], mutations: [] };
  for (const i of issues) state.events.set(i.number, [
    { id: 1, event: 'unlabeled', label: label(config.needsTriageLabel), actor: user('maintainer'), created_at: date(1) },
    ...i.assignees.map((a, n) => ({ id: n + 2, event: 'assigned', actor: user('maintainer'), assignee: a, created_at: date(1) })),
  ]);
  let id = 100;
  const now = epoch + day * DAY;
  const endpoint = handler => async args => ({ data: structuredClone(await handler(args)) });
  const getItem = n => state.prs.get(n) ?? state.issues.get(n);
  const rest = {
    issues: {
      get: endpoint(a => { const item = getItem(a.issue_number); if (!item) throw Object.assign(new Error('missing'), { status: 404 }); return state.prs.has(a.issue_number) ? { ...item, pull_request: {} } : item; }),
      listForRepo: endpoint(a => [...state.issues.values(), ...[...state.prs.values()].map(p => ({...p, pull_request: {}}))].filter(i => (!a.state || a.state === 'all' || i.state === a.state) && (!a.assignee || i.assignees.some(u => u.login === a.assignee)) && (!a.labels || i.labels.some(l => l.name === a.labels)))),
      listComments: endpoint(a => state.comments.get(a.issue_number) ?? []),
      getComment: endpoint(a => [...state.comments.values()].flat().find(c => c.id === a.comment_id)),
      listEventsForTimeline: endpoint(a => state.events.get(a.issue_number) ?? []),
      createComment: endpoint(a => { const c = { id: id++, user: user('github-actions[bot]', 'Bot'), body: a.body, created_at: date(day), updated_at: date(day) }; state.comments.set(a.issue_number, [...(state.comments.get(a.issue_number) ?? []), c]); state.mutations.push(['comment', a.issue_number]); return c; }),
      updateComment: endpoint(a => { const c = [...state.comments.values()].flat().find(c => c.id === a.comment_id); c.body = a.body; c.updated_at = date(day); return c; }),
      addLabels: endpoint(a => { const item = getItem(a.issue_number); item.labels.push(...a.labels.map(label)); item.updated_at = date(day); return item.labels; }),
      removeLabel: endpoint(a => { const item = getItem(a.issue_number); item.labels = item.labels.filter(l => l.name !== a.name); item.updated_at = date(day); return item.labels; }),
      addAssignees: endpoint(a => { const item = getItem(a.issue_number); item.assignees.push(...a.assignees.map(u => user(u))); state.mutations.push(['assign', a.issue_number]); return item; }),
      removeAssignees: endpoint(a => { const item = getItem(a.issue_number); item.assignees = item.assignees.filter(u => !a.assignees.includes(u.login)); state.mutations.push(['unassign', a.issue_number]); return item; }),
    },
    pulls: {
      get: endpoint(a => state.prs.get(a.pull_number)),
      list: endpoint(a => [...state.prs.values()].filter(p => p.state === a.state)),
      listReviews: endpoint(a => state.reviews.get(a.pull_number) ?? []),
      listReviewComments: endpoint(a => state.inline.get(a.pull_number) ?? []),
      update: endpoint(a => { const p = state.prs.get(a.pull_number); p.state = a.state; p.closed_at = date(day); state.mutations.push(['close', a.pull_number]); return p; }),
    },
    checks: {
      listForRef: endpoint(a => [...state.checks.values()].filter(c => c.head_sha === a.ref && c.name === a.check_name)),
      create: endpoint(a => { const c = { ...a, id: id++, app: { slug: 'github-actions' } }; state.checks.set(c.id, c); state.checkWrites.push(structuredClone(c)); return c; }),
      update: endpoint(a => { const c = state.checks.get(a.check_run_id); Object.assign(c, a); state.checkWrites.push(structuredClone(c)); return c; }),
    },
    repos: {
      getCollaboratorPermissionLevel: endpoint(a => ({ permission: state.permissions.get(a.username) ?? 'read' })),

    },
  };
  const github = { rest, paginate: async (method, args) => { assert.equal(args.per_page, 100); return (await method(args)).data; } };
  const execute = (eventName, payload = {}, overrides = {}) => run({ github, context: { repo: { owner: repository.split('/')[0], repo: repository.split('/')[1] }, eventName, payload }, core: { info() {} }, start: date(0), now, ...overrides });
  const command = async (number, body, login = 'alice') => {
    const comment = { id: id++, user: user(login), body, created_at: date(day), updated_at: date(day) };
    state.comments.set(number, [...(state.comments.get(number) ?? []), comment]);
    const payload = { issue: structuredClone(state.issues.get(number)), comment };
    await execute('issue_comment', payload);
    return payload;
  };
  return { state, execute, command, now, github };
}

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

test('inactivity gives a reminder before expiry, then releases without counting bot activity', async () => {
  const f = fixture({ day: 15, issues: [issue(1, { labels: [label(config.assignedLabel)], assignees: [user('alice')] })] });
  f.state.events.get(1).push({ id: 9, event: 'assigned', assignee: user('alice'), created_at: date(1) });
  await f.execute('schedule');
  assert.equal(f.state.issues.get(1).assignees.length, 1);
  assert.match(f.state.comments.get(1)[0].body, /reminder/);
  await f.execute('schedule', {}, { now: f.now + DAY });
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

function staleFixture() {
  const f = fixture({ prs: [pr(10, { labels: [label(config.staleLabel)] })] });
  f.state.reviews.set(10, [{ id: 1, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(2) }]);
  f.state.comments.set(10, [{ id: 50, user: user('github-actions[bot]', 'Bot'), created_at: date(4), body: `<!-- kubescape-policy:stale-${'a'.repeat(40)}-123 -->\nReminder` }]);
  return f;
}

test('stale requested changes close after seven warning days and release the issue', async () => {
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
  f.state.reviews.get(10).push({ id: 2, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(11) });
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

test('requested changes get a warning first; waiting for review does not', async () => {
  const f = fixture({ prs: [pr()], day: 5 });
  f.state.reviews.set(10, [{ id: 1, user: user('maintainer'), state: 'CHANGES_REQUESTED', submitted_at: date(1) }]);
  await f.execute('schedule');
  assert.equal(f.state.prs.get(10).state, 'open');
  assert.ok(f.state.prs.get(10).labels.some(l => l.name === config.staleLabel));
  assert.match(f.state.comments.get(10).at(-1).body, /within 7 days/);
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
  f.state.prs.get(10).updated_at = date(12);
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


test('non-assignee PRs close for Fixes and Refs without releasing the rightful assignee', async () => {
  for (const body of ['Fixes #1', 'Refs #1']) {
    const f = fixture({ prs: [pr(10, { user: user('bob'), body })] });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.prs.get(10).state, 'closed');
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
    if (++reads === 3) f.state.issues.get(1).labels.push(label(config.pinnedLabel));
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
