'use strict';

// Offline before/after evidence: identical mocked events, no GitHub writes.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { fixture, issue, pr, user } = require('../.github/actions/contribution-policy/tests/fixture.cjs');
const root = resolve(__dirname, '..');
const action = '.github/actions/contribution-policy';
const ref = process.argv[2];
if (!ref) throw new Error('Usage: node scripts/contribution-policy-proof.cjs REF');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
const sha = git('rev-parse', '--verify', `${ref}^{commit}`);
const installed = git('ls-tree', sha, `${action}/policy.cjs`) !== '';
const directory = mkdtempSync(join(tmpdir(), 'contribution-policy-proof-'));

async function main() {
  let policyRun = async () => {}; // No policy at the base revision: no policy writes.
  if (installed) {
    for (const name of ['policy.cjs', 'config.json']) {
      writeFileSync(join(directory, name), git('show', `${sha}:${action}/${name}`));
    }
    policyRun = require(join(directory, 'policy.cjs')).run;
  }
  const scenarios = [
    { name: 'assigned, triaged PR', issues: [issue(1, { assignees: [user('alice')] })], prs: [pr()], states: ['open'], check: 'success' },
    { name: 'non-assignee PR', issues: [issue(1, { assignees: [user('bob')] })], prs: [pr()], states: ['closed'], check: 'failure' },
    { name: 'colon-form non-assignee link', issues: [issue(1, { assignees: [user('bob')] })], prs: [pr(10, { body: 'Fixes: #1' })], states: ['closed'], check: 'failure' },
    { name: 'same-head invalid PR and exempt sibling', issues: [issue(1)], prs: [pr(10, { body: '' }), pr(11, { user: user('maintainer'), head: { sha: 'a'.repeat(40) } })], states: ['open', 'open'], check: 'failure' },
  ];
  console.log(`revision=${sha} policy=${installed ? 'present' : 'absent'} mode=offline-mocked-api`);
  for (const scenario of scenarios) {
    const f = fixture({ ...scenario, policyRun });
    await f.execute('pull_request_target', { pull_request: scenario.prs[0] });
    const states = [...f.state.prs.values()].map(p => p.state);
    const check = f.state.checkWrites.at(-1)?.conclusion ?? 'none';
    assert.deepEqual(states, installed ? scenario.states : scenario.prs.map(() => 'open'));
    assert.equal(check, installed ? scenario.check : 'none');
    console.log(`${scenario.name}: PRs=${states.join(',')} check=${check}`);
  }
  if (installed) {
    const f = fixture({ prs: [pr()], policyRun });
    await f.execute('pull_request_target', { pull_request: pr() });
    await f.execute('pull_request_target', { pull_request: pr() });
    assert.equal(f.state.checks.size, 1);
    console.log('repeat same event: check runs=1 (updated, not appended)');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => rmSync(directory, { recursive: true, force: true }));
