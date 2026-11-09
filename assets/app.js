import { ICA4Api, EXPECTED_IDENTITY } from './api.js';

const phases = ['setup', 'extraction', 'membership', 'explanation', 'submission', 'closed'];
const phaseNames = ['准备课堂', '模型窃取', '成员推断', '解释分析', '提交证据', '课堂结束'];
const views = { overview: '实验总览', materials: '实验材料', results: '评估结果', api: '连接 API' };
export async function fetchDashboard(api, initial = false) {
  const session = await api.session();
  const [usage, evidence, manifest] = await Promise.all([api.usage(), api.evidence(), initial ? api.manifest() : undefined]);
  return { session, usage, evidence, manifest };
}
export function canSubmit(session) { return Boolean(session?.phase === 'submission' && !session.paused && session.frozen?.membership); }
export function notebookSnippet(baseUrl) {
  return `from getpass import getpass\nfrom ica4_client import ICA4Client\n\nclient = ICA4Client(\n    ${JSON.stringify(baseUrl)},\n    getpass('Group token: ')\n)\nprint(client.session())\nprint(client.usage())\n\n# 后续查询与正式评估请按配套 Notebook 的固定流程运行。`;
}

async function boot() {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  const api = new ICA4Api();
  let currentSession, timer, epoch = 0, busyEpoch = null, toastTimer, pendingSubmission;
  const node = (tag, text, className) => {
    const el = document.createElement(tag);
    if (text !== undefined) el.textContent = String(text ?? '—');
    if (className) el.className = className;
    return el;
  };
  function notify(message) {
    $('#toast').textContent = message; $('#toast').classList.remove('hidden');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.add('hidden'), 6000);
  }
  function showView(view) {
    $$('[data-panel]').forEach(el => el.classList.toggle('hidden', el.dataset.panel !== view));
    $$('[data-view]').forEach(el => { el.classList.toggle('active', el.dataset.view === view); el.setAttribute('aria-current', el.dataset.view === view ? 'page' : 'false'); });
    $('#page-title').textContent = views[view]; $('#breadcrumb').textContent = views[view];
  }
  function logout(message = '') {
    epoch += 1; clearTimeout(timer); api.logout(); currentSession = null; pendingSubmission = null;
    $('#token').value = ''; $('#conclusion').value = ''; $('#workspace').classList.add('hidden');
    $('#login').classList.remove('hidden'); $('#logout').classList.add('hidden');
    $('#student-group').textContent = 'Student workspace'; $('#connection-status').textContent = '尚未登录';
    $('#login-error').textContent = message;
    // Remove group-specific content from the hidden workspace as well.
    for (const selector of ['#quota-stats', '#receipts', '#protocol', '#stages']) $(selector).replaceChildren();
    $('#student-run').textContent = 'CLASSROOM / ICA 04'; $('#api-code').textContent = '';
  }
  function reportError(error, login = false) {
    if (error.code === 'SESSION_CHANGED') return;
    if (!api.authenticated || ['AUTH_INVALID', 'IDENTITY_MISMATCH'].includes(error.code)) { logout(error.message); return; }
    if (login) { logout(error.message); return; }
    $('#workspace-error').textContent = `${error.message} 当前显示的是最后一次成功同步的数据。`;
    $('#workspace-error').classList.remove('hidden'); $('#connection-status').textContent = '连接异常 · 数据未同步';
  }
  function table(headers, rows) {
    const wrap = node('div', undefined, 'table-wrap'), tab = node('table'), head = node('thead'), tr = node('tr');
    headers.forEach(h => tr.append(node('th', h))); head.append(tr); tab.append(head);
    const body = node('tbody'); rows.forEach(values => { const row = node('tr'); values.forEach(value => row.append(node('td', value))); body.append(row); });
    tab.append(body); wrap.append(tab); return wrap;
  }
  const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : '—';
  const decimal = value => Number.isFinite(value) ? value.toFixed(3) : '—';
  function renderReceipts(evidence) {
    const content = document.createDocumentFragment();
    if (!evidence.server_receipts.length) {
      const empty = node('div', undefined, 'empty panel'); empty.append(node('strong', '还没有正式结果'), node('p', '在 Notebook 中完成并提交评估后，这里将显示服务端签名回执。')); content.append(empty);
    }
    for (const receipt of evidence.server_receipts) {
      const p = receipt.payload, section = node('section', undefined, 'panel receipt-panel'), head = node('div', undefined, 'panel-head');
      const current = currentSession.current_rounds?.[p.kind] === p.round;
      head.append(node('h2', p.kind === 'extraction' ? '模型窃取 · 正式评估' : '成员推断 · 正式评估'));
      head.append(node('span', `ROUND ${p.round} · ${current && currentSession.frozen?.[p.kind] ? 'FROZEN' : 'HISTORICAL'}`, 'tag'));
      section.append(head);
      if (p.kind === 'extraction') section.append(table(['预算', 'Agreement', 'Task accuracy', '训练时间'], p.results.map(r => [r.budget, percent(r.agreement), percent(r.task_accuracy), Number.isFinite(r.training_seconds) ? `${r.training_seconds.toFixed(2)} s` : '—'])));
      else section.append(table(['模型', '分数', 'ROC-AUC', 'Balanced acc.', 'TP / FP / TN / FN'], p.results.map(r => [r.model_id, r.score_name, decimal(r.roc_auc), percent(r.balanced_accuracy), [r.tp, r.fp, r.tn, r.fn].join(' / ')])));
      const meta = node('div', undefined, 'panel-footer'); meta.append(node('span', `回执 ${p.evaluation_id}`), node('span', `${p.source ?? 'student'} · 签名由教师核验`)); section.append(meta); content.append(section);
    }
    $('#receipts').replaceChildren(content);
    $('#submission-count').textContent = `${evidence.student_analysis.length} 个已存版本`;
  }
  function render(data) {
    currentSession = data.session;
    const s = currentSession, index = phases.indexOf(s.phase);
    $('#student-run').textContent = `${s.run_id} / ${s.group_id}`; $('#student-group').textContent = `Group ${s.group_id}`;
    $('#phase-summary').textContent = `${s.run_id} · 当前阶段：${phaseNames[index]}${s.paused ? ' · 教师已暂停课堂' : ''}`;
    $('#route-label').textContent = s.route === 'teacher_reference' ? '教师参考路线' : '学生实践路线';
    const stats = data.usage.map(q => {
      const card = node('article', undefined, 'stat');
      card.append(node('div', q.purpose === 'extraction' ? '模型窃取 · 剩余额度' : `成员推断 · ${q.model} · 剩余`, 'stat-label'), node('div', q.remaining, 'stat-value'), node('div', `${q.used} used · ${q.reserved} reserved / ${q.lim ?? q.limit_count} total`, 'stat-foot'));
      return card;
    });
    const receiptStat = node('article', undefined, 'stat'); receiptStat.append(node('div', '正式评估回执', 'stat-label'), node('div', data.evidence.server_receipts.length, 'stat-value'), node('div', '服务端生成 · 可验签', 'stat-foot'));
    $('#quota-stats').replaceChildren(...stats, receiptStat);
    $('#stages').replaceChildren(...phases.slice(0, 5).map((phase, i) => {
      const item = node('div', undefined, `stage ${i === index ? 'active' : i < index ? 'done' : ''}`);
      item.append(node('div', i < index ? '✓' : String(i + 1).padStart(2, '0'), 'circle'), node('span', phaseNames[i])); return item;
    }));
    $('#protocol').replaceChildren(...[['协议版本', s.protocol_version], ['资产版本', s.asset_version], ['普通模型', s.model_versions.baseline], ['正则化模型', s.model_versions.regularized], ['类别顺序', '0 → 1'], ['单批次上限', '50 records']].map(([label, value]) => { const row = node('div', undefined, 'protocol-row'); row.append(node('span', label), node('b', value)); return row; }));
    const canExplain = ['explanation', 'submission', 'closed'].includes(s.phase) && !s.paused && (s.frozen?.extraction || s.route === 'teacher_reference');
    $('#explanation-download').disabled = !canExplain;
    $('#explanation-note').textContent = canExplain ? '固定锚点、邻域与目标输出；现可下载。' : '教师开放解释阶段且本组窃取评估冻结后可访问。';
    renderReceipts(data.evidence);
    // The textarea is never replaced during refresh; focus, selection and draft remain intact.
    $('#submit-conclusion').disabled = !canSubmit(s) || Boolean(pendingSubmission?.busy);
    $('#submission-note').textContent = canSubmit(s) ? '可以提交；如网络中断，原内容重试会保留同一提交标识。' : '等待提交阶段、课堂恢复及成员评估冻结。';
    $('#api-code').textContent = notebookSnippet(api.baseUrl); $('#api-host').textContent = api.baseUrl;
    $('#sync-time').textContent = new Date().toLocaleTimeString('zh-CN');
    $('#workspace-error').classList.add('hidden'); $('#connection-status').textContent = s.paused ? 'API 已连接 · 课堂暂停' : 'API 已连接';
  }
  async function refresh(initial = false) {
    if (busyEpoch === epoch || !api.authenticated) return;
    const ticket = epoch; busyEpoch = ticket;
    try { const data = await fetchDashboard(api, initial); if (ticket === epoch) render(data); }
    finally { if (busyEpoch === ticket) busyEpoch = null; }
  }
  function schedule() {
    clearTimeout(timer);
    if (!api.authenticated) return;
    timer = setTimeout(async () => {
      try { await refresh(); } catch (error) { reportError(error); }
      if (api.authenticated) schedule();
    }, 5000);
  }
  $('#student-login').addEventListener('submit', async event => {
    event.preventDefault(); $('#login-button').disabled = true; $('#login-error').textContent = '';
    try {
      epoch += 1; api.configure($('#api-url').value); api.setToken($('#token').value); $('#token').value = '';
      await refresh(true);
      if (!api.authenticated || !currentSession) return;
      $('#login').classList.add('hidden'); $('#workspace').classList.remove('hidden'); $('#logout').classList.remove('hidden');
      showView('overview'); schedule();
    } catch (error) { $('#token').value = ''; reportError(error, true); }
    finally { $('#login-button').disabled = false; }
  });
  $('#logout').addEventListener('click', () => logout());
  $$('[data-view]').forEach(button => button.addEventListener('click', () => showView(button.dataset.view)));
  $('#refresh').addEventListener('click', async () => { try { await refresh(); } catch (error) { reportError(error); } });
  $$('[data-download]').forEach(button => button.addEventListener('click', async () => {
    const ticket = epoch; button.disabled = true;
    try {
      const file = await api.download(button.dataset.download); if (ticket !== epoch) return;
      const url = URL.createObjectURL(file.blob), link = node('a'); link.href = url; link.download = file.filename;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 10000);
      notify('文件已通过身份验证并开始下载。');
    } catch (error) { reportError(error); }
    finally { button.disabled = button.id === 'explanation-download' ? !currentSession || !['explanation', 'submission', 'closed'].includes(currentSession.phase) || currentSession.paused || !(currentSession.frozen?.extraction || currentSession.route === 'teacher_reference') : false; }
  }));
  $('#conclusion').addEventListener('input', () => { if (pendingSubmission && pendingSubmission.text !== $('#conclusion').value) pendingSubmission = null; });
  $('#analysis-form').addEventListener('submit', async event => {
    event.preventDefault(); const text = $('#conclusion').value, ticket = epoch;
    if (!canSubmit(currentSession)) return;
    if (!pendingSubmission || pendingSubmission.text !== text) pendingSubmission = { text, key: crypto.randomUUID() };
    if (pendingSubmission.busy) return;
    const attempt = pendingSubmission; attempt.busy = true; $('#submit-conclusion').disabled = true;
    try {
      const result = await api.submitConclusion(text, attempt.key); if (ticket !== epoch) return;
      notify(`结论已保存为版本 ${result.version}。请下载最新证据。`);
      pendingSubmission = null; await refresh();
    } catch (error) { reportError(error); }
    finally { attempt.busy = false; $('#submit-conclusion').disabled = !canSubmit(currentSession); }
  });
  $('#copy-api').addEventListener('click', async () => { try { await navigator.clipboard.writeText($('#api-code').textContent); notify('已复制连接示例。'); } catch { notify('浏览器未允许自动复制，请手动选中示例文本。'); } });
  try {
    const response = await fetch(new URL('../config.json', import.meta.url), { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('config');
    const config = await response.json();
    if (config.protocolVersion !== EXPECTED_IDENTITY.protocol_version) throw new Error('config');
    api.configure(config.apiBaseUrl ?? ''); $('#api-url').value = api.baseUrl;
    $('#setup-message').textContent = api.baseUrl ? '已填入课程公开配置；如教师另有通知，可在此修改。' : '尚未配置 API。请填写教师提供的 HTTPS 地址；网页不会向 GitHub Pages 发送实验请求。';
    $('#connection-status').textContent = api.baseUrl ? '等待小组登录' : '等待配置 API';
  } catch {
    $('#setup-message').textContent = '公开配置未能加载或格式无效。请手动填写教师提供的 HTTPS API 地址。';
    $('#connection-status').textContent = '需要配置 API';
  } finally { $('#login-button').disabled = false; }
}
if (typeof document !== 'undefined') boot();
