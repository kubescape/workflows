'use strict';
const assert = require('node:assert/strict');
const { run } = require('../policy.cjs');
const config = require('../config.json');
const DAY = 86_400_000;
const epoch = Date.parse('2026-12-01T00:00:00Z');
const date = day => new Date(epoch + day * DAY).toISOString();
const user = (login, type = 'User') => ({ login, type });
const label = name => ({ name });
const issue = (number, overrides = {}) => ({ number, state: 'open', labels: [], assignees: [], user: user('reporter'), created_at: date(1), updated_at: date(1), ...overrides });
const pr = (number = 10, overrides = {}) => ({ ...issue(number), user: user('alice'), body: 'Fixes #1', head: { sha: number === 10 ? 'a'.repeat(40) : String(number).padStart(40, '0') }, merged: false, ...overrides });

function fixture({ issues = [issue(1, { assignees: [user('alice')] })], prs = [], day = 12, repository = 'kubescape/kubescape', policyRun = run } = {}) {
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
  const execute = (eventName, payload = {}, overrides = {}) => policyRun({ github, context: { repo: { owner: repository.split('/')[0], repo: repository.split('/')[1] }, eventName, payload }, core: { info() {} }, start: date(0), now, ...overrides });
  const command = async (number, body, login = 'alice') => {
    const comment = { id: id++, user: user(login), body, created_at: date(day), updated_at: date(day) };
    state.comments.set(number, [...(state.comments.get(number) ?? []), comment]);
    const payload = { issue: structuredClone(state.issues.get(number)), comment };
    await execute('issue_comment', payload);
    return payload;
  };
  return { state, execute, command, now, github };
}

module.exports = { fixture, DAY, epoch, date, user, label, issue, pr };
