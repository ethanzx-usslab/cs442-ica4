import test from 'node:test';
import assert from 'node:assert/strict';
import { ICA4Api, normalizeBaseUrl } from '../assets/api.js';

const identity = { protocol_version: 'ica4-v1', asset_version: 'ica4-assets-442-v1', model_versions: { baseline: 'baseline-61b9c7843367', regularized: 'regularized-45b4d9a7215d' } };
const session = () => ({ ...identity, role: 'student', run_id: 'class-1', group_id: 'g01', phase: 'submission', paused: false, frozen: { extraction: true, membership: true } });
const evidence = () => ({ schema_version: 'ica4-evidence-v1', run_id: 'class-1', group_id: 'g01', server_receipts: [], student_analysis: [], usage: [] });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
function harness(responses = []) {
  const calls = [];
  const api = new ICA4Api({ baseUrl: 'https://api.example.test/', fetch: async (...args) => { calls.push(args); const next = responses.shift(); if (next instanceof Error) throw next; return next ?? json(session()); } });
  api.setToken('test-group-token');
  return { api, calls };
}

test('normalizes root and api prefix without duplicate routes', () => {
  assert.equal(normalizeBaseUrl(' https://api.example.test/api/v1/ '), 'https://api.example.test');
  assert.equal(normalizeBaseUrl('https://api.example.test/'), 'https://api.example.test');
});
for (const url of ['', 'http://api.example.test', 'javascript:alert(1)', '/api', 'https://user:pass@api.example.test', 'https://api.example.test/?token=x', 'https://api.example.test/#x', 'https://api.example.test/other']) {
  test(`rejects unsafe or unconfigured API URL: ${url}`, () => assert.throws(() => normalizeBaseUrl(url), /HTTPS|API/));
}
test('empty setup and missing token never call fetch', async () => {
  const { api, calls } = harness(); api.logout();
  await assert.rejects(api.session(), /Token/);
  api.configure(''); api.setToken('x');
  await assert.rejects(api.session(), /API/);
  assert.equal(calls.length, 0);
});
test('authenticates exclusively with Bearer and excludes cookies/cache', async () => {
  const { api, calls } = harness(); await api.session();
  assert.equal(calls[0][0], 'https://api.example.test/api/v1/session');
  assert.equal(calls[0][1].headers.Authorization, 'Bearer test-group-token');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(calls[0][1].redirect, 'error');
  assert.ok(!calls[0][0].includes('test-group-token'));
  assert.ok(!JSON.stringify(api).includes('test-group-token'));
});
test('logout clears credentials and changing endpoint clears credentials', async () => {
  const { api, calls } = harness(); await api.session(); api.logout();
  assert.equal(api.authenticated, false); await assert.rejects(api.usage(), /Token/);
  api.setToken('new-token'); api.configure('https://other.example.test');
  assert.equal(api.authenticated, false); assert.equal(calls.length, 1);
});
test('token validation rejects whitespace/control characters locally', () => {
  const { api, calls } = harness();
  for (const token of ['', ' ', 'bad token', 'bad\nvalue']) assert.throws(() => api.setToken(token), /Token/);
  assert.equal(calls.length, 0);
});
test('401 clears token and yields a readable status without raw response', async () => {
  const { api } = harness([json({ error: { code: 'AUTH_INVALID', message: 'expired' } }, 401)]);
  await assert.rejects(api.session(), e => e.code === 'AUTH_INVALID' && e.status === 401);
  assert.equal(api.authenticated, false);
});
test('phase 403 is reported without discarding valid token', async () => {
  const { api } = harness([json({ error: { code: 'PHASE_CLOSED', message: 'closed' } }, 403)]);
  await assert.rejects(api.usage(), e => e.code === 'PHASE_CLOSED');
  assert.equal(api.authenticated, true);
});
test('network and invalid JSON errors are explicit', async () => {
  const { api } = harness([new Error('secret upstream'), new Response('<html>bad</html>')]);
  await assert.rejects(api.session(), e => e.code === 'NETWORK_ERROR' && !e.message.includes('secret upstream'));
  await assert.rejects(api.session(), e => e.code === 'INVALID_RESPONSE');
});
for (const change of [{ role: 'teacher' }, { protocol_version: 'wrong' }, { run_id: '' }, { group_id: null }, { phase: 'wrong' }, { asset_version: 'wrong' }, { model_versions: { baseline: 'wrong', regularized: 'wrong' } }]) {
  test(`rejects incompatible session: ${JSON.stringify(change)}`, async () => {
    const { api } = harness([json({ ...session(), ...change })]);
    await assert.rejects(api.session(), e => e.code === 'IDENTITY_MISMATCH'); assert.equal(api.authenticated, false);
  });
}
test('rejects group changes during a session', async () => {
  const { api } = harness([json(session()), json({ ...session(), group_id: 'g02' })]);
  await api.session(); await assert.rejects(api.session(), e => e.code === 'IDENTITY_MISMATCH');
});
test('reads dashboard routes without any prediction/evaluation requests', async () => {
  const { api, calls } = harness([json(session()), json([]), json({ ...identity, class_order: [0, 1] }), json(evidence())]);
  await api.session(); await api.usage(); await api.manifest(); await api.evidence();
  assert.deepEqual(calls.map(c => new URL(c[0]).pathname), ['/api/v1/session', '/api/v1/usage', '/api/v1/manifest', '/api/v1/evidence']);
});
test('rejects manifest version/class order and evidence identity mismatches', async () => {
  for (const manifest of [{ ...identity, class_order: [1, 0] }, { ...identity, asset_version: 'bad', class_order: [0, 1] }]) {
    const { api } = harness([json(session()), json(manifest)]); await api.session();
    await assert.rejects(api.manifest(), e => e.code === 'IDENTITY_MISMATCH');
  }
  const { api } = harness([json(session()), json({ ...evidence(), group_id: 'wrong' })]); await api.session();
  await assert.rejects(api.evidence(), e => e.code === 'IDENTITY_MISMATCH');
});
test('authenticated downloads return Blob and safe filename', async () => {
  const { api, calls } = harness([new Response('zip-bytes', { headers: { 'Content-Disposition': 'attachment; filename="../../student.zip"' } })]);
  const file = await api.download('student-package.zip');
  assert.ok(file.blob instanceof Blob); assert.equal(await file.blob.text(), 'zip-bytes');
  assert.equal(file.filename, 'student.zip'); assert.equal(calls[0][1].headers.Authorization, 'Bearer test-group-token');
});
test('download restricts routes and checks HTTP failures before creating Blob', async () => {
  const { api, calls } = harness([json({ error: { code: 'AUTH_INVALID' } }, 401)]);
  await assert.rejects(api.download('../admin/export'), /下载/); assert.equal(calls.length, 0);
  await assert.rejects(api.download('evidence'), e => e.status === 401); assert.equal(api.authenticated, false);
});
test('submits conclusion with stable caller idempotency key and local validation', async () => {
  const { api, calls } = harness([json(session()), json({ submission_id: 's1', version: 1 })]);
  await api.session();
  await assert.rejects(api.submitConclusion('short', 'key-1'), /20/); assert.equal(calls.length, 1);
  await api.submitConclusion('This conclusion has numerical evidence 0.83 and a limitation.', 'key-1');
  assert.equal(calls[1][0], 'https://api.example.test/api/v1/submissions');
  assert.equal(calls[1][1].headers['Idempotency-Key'], 'key-1');
  assert.equal(JSON.parse(calls[1][1].body).conclusion, 'This conclusion has numerical evidence 0.83 and a limitation.');
});
test('does not submit outside submission phase or while paused', async () => {
  for (const change of [{ phase: 'extraction' }, { paused: true }]) {
    const { api, calls } = harness([json({ ...session(), ...change })]); await api.session();
    await assert.rejects(api.submitConclusion('long enough conclusion with metric 0.83', 'key'), /阶段|暂停/);
    assert.equal(calls.length, 1);
  }
});
test('logout invalidates in-flight session response', async () => {
  let release;
  const api = new ICA4Api({ baseUrl: 'https://api.example.test', fetch: () => new Promise(r => { release = r; }) });
  api.setToken('token'); const pending = api.session(); api.logout(); release(json(session()));
  await assert.rejects(pending, e => e.code === 'SESSION_CHANGED'); assert.equal(api.authenticated, false);
});
test('authentication never accesses browser storage', async () => {
  const previous = ['localStorage', 'sessionStorage'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  try {
    for (const [name] of previous) Object.defineProperty(globalThis, name, { configurable: true, get() { assert.fail(`${name} must not be accessed`); } });
    const { api } = harness(); await api.session(); api.logout();
  } finally {
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else delete globalThis[name]; }
  }
});
test('invalid quota and incompatible receipt responses are rejected', async () => {
  const { api } = harness([json([{ purpose: 'extraction', model: 'baseline', used: 'bad', reserved: 0, remaining: 800, lim: 800 }])]);
  await assert.rejects(api.usage(), e => e.code === 'INVALID_RESPONSE');
  const second = harness([json(session()), json({ ...evidence(), server_receipts: [{ payload: { ...session(), schema_version: 'ica4-receipt-v1', kind: 'extraction', results: [], asset_version: 'wrong' } }] })]);
  await second.api.session(); await assert.rejects(second.api.evidence(), e => e.code === 'IDENTITY_MISMATCH');
  assert.equal(second.api.authenticated, false);
});
test('unknown server errors remain readable and do not reveal raw payloads', async () => {
  const { api } = harness([json({ error: { code: 'INTERNAL', message: 'private internals' } }, 503)]);
  await assert.rejects(api.usage(), e => e.code === 'HTTP_ERROR' && e.message.includes('503') && !e.message.includes('private'));
});
