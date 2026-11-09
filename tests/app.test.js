import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchDashboard, canSubmit, notebookSnippet } from '../assets/app.js';

test('dashboard validates session before reading group evidence and never invokes query', async () => {
  const calls = [];
  const api = Object.fromEntries(['session', 'usage', 'manifest', 'evidence'].map(name => [name, async () => { calls.push(name); return name; }]));
  api.query = () => assert.fail('dashboard must not query targets');
  const result = await fetchDashboard(api, true);
  assert.equal(calls[0], 'session'); assert.deepEqual(new Set(calls), new Set(['session', 'usage', 'manifest', 'evidence']));
  assert.equal(result.session, 'session'); assert.equal(result.manifest, 'manifest');
});
test('polls read only session usage evidence after initial manifest', async () => {
  const calls = [];
  const api = Object.fromEntries(['session', 'usage', 'manifest', 'evidence'].map(name => [name, async () => { calls.push(name); return name; }]));
  await fetchDashboard(api); assert.deepEqual(calls, ['session', 'usage', 'evidence']);
});
test('conclusion only opens during unpaused submission with frozen membership', () => {
  assert.equal(canSubmit({ phase: 'submission', paused: false, frozen: { membership: true } }), true);
  for (const value of [null, { phase: 'extraction' }, { phase: 'submission', paused: true, frozen: { membership: true } }, { phase: 'submission', paused: false, frozen: { membership: false } }]) assert.equal(canSubmit(value), false);
});
test('Notebook example uses configured API URL and interactive token prompt', () => {
  const snippet = notebookSnippet('https://api.example.test');
  assert.ok(snippet.includes('https://api.example.test')); assert.ok(snippet.includes("getpass('Group token: ')"));
  assert.ok(!snippet.includes('github.io')); assert.ok(!snippet.includes('predict'));
});
