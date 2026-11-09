import test from 'node:test';
import assert from 'node:assert/strict';
import { ICA4Api, EXPECTED_IDENTITY } from '../assets/api.js';
import * as app from '../assets/app.js';

const session = (change = {}) => ({ ...EXPECTED_IDENTITY, role: 'student', run_id: 'r1', group_id: 'g01', flow_mode: 'self_paced', phase: 'explanation', paused: false, frozen: { extraction: true, membership: true }, ...change });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

test('explanation completion guard requires own frozen unpaused self-paced stage', () => {
  assert.equal(app.canAdvance(session()), true);
  for (const value of [null, session({ phase: 'membership' }), session({ phase: 'closed' }), session({ run_phase: 'closed' }), session({ paused: true }), session({ frozen: { membership: false } }), session({ flow_mode: 'teacher_controlled' })]) assert.equal(app.canAdvance(value), false);
});

test('advance posts only the fixed expected phase with caller retry key', async () => {
  const calls = [];
  const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: async (...args) => { calls.push(args); return json(calls.length === 1 ? session() : { run_id: 'r1', group_id: 'g01', phase: 'submission', flow_mode: 'self_paced' }); } });
  api.setToken('synthetic-token'); await api.session();
  const result = await api.advancePhase('advance-key');
  assert.equal(result.phase, 'submission');
  assert.equal(calls[1][0], 'https://api.example.test/api/v1/progress/advance');
  assert.deepEqual(JSON.parse(calls[1][1].body), { expected_phase: 'explanation' });
  assert.equal(calls[1][1].headers['Idempotency-Key'], 'advance-key');
});

test('advance guards invalid stage, pause, freeze and retry key before fetch', async () => {
  for (const change of [{ phase: 'extraction' }, { run_phase: 'closed' }, { paused: true }, { frozen: { membership: false } }, { flow_mode: 'teacher_controlled' }]) {
    let count = 0;
    const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: async () => { count += 1; return json(session(change)); } });
    api.setToken('synthetic-token'); await api.session();
    await assert.rejects(api.advancePhase('key'), e => e.code === 'PHASE_CLOSED');
    assert.equal(count, 1);
  }
  const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: async () => json(session()) });
  api.setToken('synthetic-token'); await api.session();
  await assert.rejects(api.advancePhase('bad key'), e => e.code === 'INVALID_KEY');
});

test('archived classrooms preserve group history but disable submission guard and API writes', async () => {
  const archived = session({ phase: 'submission', run_phase: 'closed' });
  assert.equal(app.canSubmit(archived), false);
  let count = 0;
  const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: async () => { count += 1; return json(archived); } });
  api.setToken('synthetic-token'); await api.session();
  await assert.rejects(api.submitConclusion('Evidence 0.83 and a limitation of the experiment.', 'key'), e => e.code === 'PHASE_CLOSED');
  assert.equal(count, 1);
});

test('same advance key survives network loss and a foreign transition is rejected', async () => {
  const calls = [];
  let fail = true;
  const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: async (url, options) => {
    calls.push([url, options]);
    if (url.endsWith('/session')) return json(session());
    if (fail) { fail = false; throw new Error('lost response'); }
    return json({ run_id: 'r1', group_id: 'g02', phase: 'submission', flow_mode: 'self_paced' });
  } });
  api.setToken('synthetic-token'); await api.session();
  await assert.rejects(api.advancePhase('same-key'), e => e.code === 'NETWORK_ERROR');
  await assert.rejects(api.advancePhase('same-key'), e => e.code === 'IDENTITY_MISMATCH');
  assert.deepEqual(calls.slice(1).map(c => c[1].headers['Idempotency-Key']), ['same-key', 'same-key']);
});
