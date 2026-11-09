import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { ICA4Api, EXPECTED_IDENTITY } from '../assets/api.js';

const source = fs.readFileSync(new URL('../assets/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;\s*/m, '').replace(/export /g, '')
  .replace(/import\.meta\.url/g, "'https://pages.test/assets/app.js'")
  .replace(/if \(typeof document !== 'undefined'\) boot\(\);/, '');
const session = (change = {}) => ({ ...EXPECTED_IDENTITY, run_id: 'r1', group_id: 'g01', role: 'student', flow_mode: 'self_paced', phase: 'explanation', paused: false, frozen: { extraction: true, membership: true }, current_rounds: { extraction: 1, membership: 1 }, ...change });
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

async function harness() {
  const elements = new Map(), calls = [];
  let ownSession = session(), loseAdvance = false, loseSubmission = false, deferSubmission, downloadGate;
  const element = selector => {
    if (!elements.has(selector)) {
      const classes = new Set();
      const el = { id: typeof selector === 'string' ? selector.slice(1) : '', textContent: '', value: '', disabled: false, children: [], dataset: {}, events: {},
        classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c), toggle(c, on) { if (on) classes.add(c); else classes.delete(c); } },
        append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
        addEventListener(name, handler) { this.events[name] = handler; }, setAttribute() {}, remove() {}, click() {},
      };
      elements.set(selector, el);
    }
    return elements.get(selector);
  };
  const fetch = async (url, options) => {
    const route = String(url);
    if (route.endsWith('config.json')) return json({ protocolVersion: 'ica4-v1', apiBaseUrl: 'https://api.example.test' });
    calls.push([route, options]);
    if (route.endsWith('/session')) return json(ownSession);
    if (route.endsWith('/usage')) return json([]);
    if (route.endsWith('/manifest')) return json({ ...EXPECTED_IDENTITY, class_order: [0, 1] });
    if (route.endsWith('/evidence')) return json({ schema_version: 'ica4-evidence-v1', run_id: ownSession.run_id, group_id: ownSession.group_id, server_receipts: [], student_analysis: [] });
    if (route.endsWith('/explanation-materials')) { if (downloadGate) await downloadGate; return new Response('synthetic-npz'); }
    if (route.endsWith('/progress/advance')) {
      if (loseAdvance) { loseAdvance = false; throw new Error('lost response'); }
      ownSession = { ...ownSession, phase: 'submission' };
      return json({ run_id: ownSession.run_id, group_id: ownSession.group_id, phase: 'submission', flow_mode: 'self_paced' });
    }
    if (route.endsWith('/submissions')) {
      if (loseSubmission) { loseSubmission = false; throw new Error('lost response'); }
      if (deferSubmission) await deferSubmission;
      ownSession = { ...ownSession, phase: 'closed' };
      return json({ version: 1, phase: 'closed' });
    }
    assert.fail('Unexpected route ' + route);
  };
  let counter = 0;
  const context = vm.createContext({ ICA4Api: class extends ICA4Api { constructor() { super({ fetch }); } }, EXPECTED_IDENTITY,
    document: { querySelector: element, querySelectorAll: selector => selector === '[data-download]' ? [element('#explanation-download')] : [], createElement: tag => element(Symbol(tag)), createDocumentFragment: () => element(Symbol('fragment')), body: { append() {} } },
    fetch, URL, crypto: { randomUUID: () => 'synthetic-key-' + (++counter) },
    setTimeout: () => 0, clearTimeout() {}, navigator: { clipboard: { async writeText() {} } }, console,
  });
  element('#explanation-download').dataset.download = 'explanation-materials';
  vm.runInContext(source, context); await vm.runInContext('boot()', context);
  element('#token').value = 'synthetic-token';
  await element('#student-login').events.submit({ preventDefault() {} });
  return { element, calls, setSession(value) { ownSession = value; }, loseAdvance() { loseAdvance = true; }, loseSubmission() { loseSubmission = true; }, deferSubmission(value) { deferSubmission = value; }, deferDownload(value) { downloadGate = value; },
    click: id => element(id).events.click(), submit: () => element('#analysis-form').events.submit({ preventDefault() {} }),
  };
}

test('normal public login wires guarded advance with stable retry key and own closure preserves draft', async () => {
  const h = await harness();
  assert.equal(h.element('#advance-phase').disabled, false);
  h.loseAdvance(); await h.click('#advance-phase'); await h.click('#advance-phase');
  const advances = h.calls.filter(c => c[0].endsWith('/progress/advance'));
  assert.equal(advances.length, 2);
  assert.equal(advances[0][1].headers['Idempotency-Key'], advances[1][1].headers['Idempotency-Key']);
  assert.equal(h.element('#advance-phase').disabled, true);
  assert.equal(h.element('#submit-conclusion').disabled, false);
  const draft = 'Evidence 0.83 and the limitation of this particular experiment.';
  h.element('#conclusion').value = draft;
  h.loseSubmission(); await h.submit(); await h.submit();
  const submissions = h.calls.filter(c => c[0].endsWith('/submissions'));
  assert.equal(submissions.length, 2);
  assert.equal(submissions[0][1].headers['Idempotency-Key'], submissions[1][1].headers['Idempotency-Key']);
  assert.equal(h.element('#conclusion').value, draft);
  assert.equal(h.element('#submit-conclusion').disabled, true);
  assert.match(h.element('#phase-summary').textContent, /小组已完成/);
  assert.ok(h.calls.every(c => !/predict|evaluate/.test(c[0])));
});

test('public advance keys reset after reopened round and logout', async () => {
  const h = await harness(); h.loseAdvance(); await h.click('#advance-phase');
  h.setSession(session({ current_rounds: { extraction: 1, membership: 2 } })); await h.click('#refresh');
  h.loseAdvance(); await h.click('#advance-phase');
  const advances = h.calls.filter(c => c[0].endsWith('/progress/advance'));
  assert.notEqual(advances[0][1].headers['Idempotency-Key'], advances[1][1].headers['Idempotency-Key']);
  await h.click('#logout');
  h.element('#token').value = 'synthetic-token';
  await h.element('#student-login').events.submit({ preventDefault() {} });
  await h.click('#advance-phase');
  assert.notEqual(h.calls.filter(c => c[0].endsWith('/progress/advance')).at(-1)[1].headers['Idempotency-Key'], advances[1][1].headers['Idempotency-Key']);
});

test('editing a draft during a public in-flight submission cannot start a concurrent submission', async () => {
  const h = await harness(); await h.click('#advance-phase');
  let release;
  h.deferSubmission(new Promise(resolve => { release = resolve; }));
  h.element('#conclusion').value = 'Evidence 0.83 with a limitation of this experiment.';
  const first = h.submit();
  h.element('#conclusion').value = 'Revised evidence 0.84 with a limitation of this experiment.';
  h.element('#conclusion').events.input();
  const second = h.submit();
  assert.equal(h.calls.filter(c => c[0].endsWith('/submissions')).length, 1);
  release(); await Promise.all([first, second]);
  assert.match(h.element('#conclusion').value, /Revised evidence/);
});

test('public explanation render and download completion retain exact self-paced and legacy gates', async () => {
  const h = await harness();
  for (const change of [{ frozen: { extraction: true, membership: false } }, { run_phase: 'closed' }, { paused: true }, { phase: 'membership' }, { frozen: { extraction: false, membership: true } }]) {
    h.setSession(session(change)); await h.click('#refresh');
    assert.equal(h.element('#explanation-download').disabled, true);
  }
  for (const change of [{}, { phase: 'closed' }, { frozen: { extraction: false, membership: true }, route: 'teacher_reference' }, { flow_mode: 'teacher_controlled', run_phase: 'closed', frozen: { extraction: true, membership: false } }, { flow_mode: 'teacher_controlled', frozen: {}, route: 'teacher_reference' }]) {
    h.setSession(session(change)); await h.click('#refresh');
    assert.equal(h.element('#explanation-download').disabled, false);
  }
  for (const change of [{ run_phase: 'closed' }, { frozen: { extraction: true, membership: false } }]) {
    h.setSession(session()); await h.click('#refresh');
    let release;
    h.deferDownload(new Promise(resolve => { release = resolve; }));
    const downloading = h.click('#explanation-download');
    h.setSession(session(change)); await h.click('#refresh');
    release(); await downloading;
    assert.equal(h.element('#explanation-download').disabled, true);
  }
});
