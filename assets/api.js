export const EXPECTED_IDENTITY = Object.freeze({
  protocol_version: 'ica4-v1',
  asset_version: 'ica4-assets-442-v1',
  model_versions: Object.freeze({ baseline: 'baseline-61b9c7843367', regularized: 'regularized-45b4d9a7215d' }),
});
const phases = ['setup', 'extraction', 'membership', 'explanation', 'submission', 'closed'];
const messages = {
  AUTH_INVALID: '小组 Token 无效或已撤销，请重新登录。',
  PHASE_CLOSED: '当前阶段未开放此操作，或教师已暂停课堂。',
  MISSING_EVALUATION: '请先在 Notebook 中完成并冻结成员推断评估。',
  IDEMPOTENCY_CONFLICT: '重试标识已用于另一份内容，请检查后重试。',
  QUOTA_EXCEEDED: '查询额度不足，请查看用量或联系教师。',
  CONCLUSION_REQUIRED: '结论至少需要 20 个字符，并包含数值证据和限制。',
};
export class ApiError extends Error {
  constructor(message, code, status = 0) { super(message); this.name = 'ApiError'; this.code = code; this.status = status; }
}
export function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { throw new ApiError('请填写教师提供的 HTTPS API 地址。', 'API_SETUP'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['/', '/api/v1', '/api/v1/'].includes(url.pathname)) {
    throw new ApiError('API 必须是 HTTPS 服务根地址，不可含凭据、查询参数或其他路径。', 'API_SETUP');
  }
  return url.origin;
}
export class ICA4Api {
  #token = '';
  #session = null;
  #generation = 0;
  #fetch;
  #baseUrl = '';
  constructor({ baseUrl = '', fetch: fetchImpl = globalThis.fetch } = {}) {
    this.#fetch = fetchImpl;
    this.configure(baseUrl);
  }
  get baseUrl() { return this.#baseUrl; }
  get authenticated() { return Boolean(this.#token); }
  configure(value) {
    this.logout();
    this.#baseUrl = '';
    if (String(value ?? '').trim()) this.#baseUrl = normalizeBaseUrl(value);
    return this.#baseUrl;
  }
  setToken(value) {
    this.logout();
    const token = String(value ?? '').trim();
    if (!token || token.length > 4096 || /[^\x21-\x7E]/.test(token)) throw new ApiError('请填写有效的小组 Token。', 'TOKEN_REQUIRED');
    this.#token = token;
  }
  logout() { this.#token = ''; this.#session = null; this.#generation += 1; }
  #mismatch() { this.logout(); throw new ApiError('服务身份或实验版本不匹配。已退出，请核对教师 API 地址。', 'IDENTITY_MISMATCH'); }
  #validIdentity(value) {
    return value?.protocol_version === EXPECTED_IDENTITY.protocol_version && value?.asset_version === EXPECTED_IDENTITY.asset_version;
  }
  #validModels(value) {
    return Object.entries(EXPECTED_IDENTITY.model_versions).every(([model, version]) => value?.model_versions?.[model] === version);
  }
  #sameGroup(value) { return this.#session && value?.run_id === this.#session.run_id && value?.group_id === this.#session.group_id; }
  async #request(route, { method = 'GET', body, key, blob = false } = {}) {
    if (!this.#baseUrl) throw new ApiError('API 尚未配置，请填写教师提供的 HTTPS API 地址。', 'API_SETUP');
    if (!this.#token) throw new ApiError('请重新输入小组 Token。', 'TOKEN_REQUIRED');
    const generation = this.#generation;
    const headers = { Authorization: `Bearer ${this.#token}`, Accept: blob ? '*/*' : 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (key) headers['Idempotency-Key'] = key;
    let response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/api/v1/${route}`, {
        method, headers, credentials: 'omit', cache: 'no-store', redirect: 'error',
        referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (generation !== this.#generation) throw new ApiError('会话已改变。', 'SESSION_CHANGED');
      throw new ApiError('无法连接 API。请检查地址、网络及教师服务的 HTTPS / CORS 设置。', 'NETWORK_ERROR');
    }
    if (generation !== this.#generation) throw new ApiError('会话已改变。', 'SESSION_CHANGED');
    if (!response.ok) {
      let data;
      try { data = await response.json(); } catch { /* Never display a raw proxy response. */ }
      const code = response.status === 401 ? 'AUTH_INVALID' : (Object.hasOwn(messages, data?.error?.code ?? '') ? data.error.code : 'HTTP_ERROR');
      if (code === 'AUTH_INVALID') this.logout();
      throw new ApiError(messages[code] ?? `API 请求失败（HTTP ${response.status}），请稍后重试。`, code, response.status);
    }
    let result;
    try { result = blob ? await response.blob() : await response.json(); }
    catch { throw new ApiError('API 响应格式无效，请核对服务地址。', 'INVALID_RESPONSE', response.status); }
    if (generation !== this.#generation) throw new ApiError('会话已改变。', 'SESSION_CHANGED');
    return blob ? { blob: result, disposition: response.headers.get('Content-Disposition') } : result;
  }
  async session() {
    const data = await this.#request('session');
    if (data?.role !== 'student' || !this.#validIdentity(data) || !this.#validModels(data) ||
      typeof data.run_id !== 'string' || !data.run_id || typeof data.group_id !== 'string' || !data.group_id ||
      !phases.includes(data.phase) || typeof data.paused !== 'boolean' || (this.#session && !this.#sameGroup(data))) this.#mismatch();
    this.#session = structuredClone(data);
    return data;
  }
  async usage() {
    const data = await this.#request('usage');
    if (!Array.isArray(data) || data.some(q => !['extraction', 'membership'].includes(q.purpose) || !['baseline', 'regularized'].includes(q.model) ||
      !['used', 'reserved', 'remaining'].every(k => Number.isFinite(q[k]) && q[k] >= 0) || !Number.isFinite(q.lim ?? q.limit_count))) {
      throw new ApiError('API 额度响应格式无效。', 'INVALID_RESPONSE');
    }
    return data;
  }
  async manifest() {
    const data = await this.#request('manifest');
    if (!this.#validIdentity(data) || JSON.stringify(data.class_order) !== '[0,1]') this.#mismatch();
    return data;
  }
  async evidence() {
    const data = await this.#request('evidence');
    if (!this.#sameGroup(data) || data?.schema_version !== 'ica4-evidence-v1' || !Array.isArray(data.server_receipts) || !Array.isArray(data.student_analysis)) this.#mismatch();
    for (const receipt of data.server_receipts) {
      const payload = receipt?.payload;
      if (!this.#sameGroup(payload) || !this.#validIdentity(payload) || !this.#validModels(payload) || payload.schema_version !== 'ica4-receipt-v1' ||
        !['extraction', 'membership'].includes(payload.kind) || !Array.isArray(payload.results)) this.#mismatch();
    }
    return data;
  }
  async download(name) {
    const assets = ['student-package.zip', 'public_manifest.json', 'extraction_pool.npz', 'extraction_test.npz', 'membership_candidates.npz', 'shadow_baseline.npz', 'shadow_regularized.npz'];
    const route = name === 'evidence' ? 'evidence' : name === 'explanation-materials' ? name : assets.includes(name) ? `downloads/${name}` : null;
    if (!route) throw new ApiError('不支持的下载文件。', 'INVALID_DOWNLOAD');
    const file = await this.#request(route, { blob: true });
    const fallback = name === 'evidence' ? 'ica4-attack-evidence.json' : name === 'explanation-materials' ? 'explanations.npz' : name;
    const match = file.disposition?.match(/filename="([^"]+)"/i);
    const safe = match?.[1].split(/[\\/]/).at(-1).replace(/[^\w.\-]/g, '_');
    return { blob: file.blob, filename: safe && safe !== '.' && safe !== '..' ? safe : fallback };
  }
  async submitConclusion(conclusion, key) {
    if (typeof conclusion !== 'string' || conclusion.trim().length < 20) throw new ApiError(messages.CONCLUSION_REQUIRED, 'CONCLUSION_REQUIRED');
    if (new TextEncoder().encode(JSON.stringify({ conclusion })).length > 190000) throw new ApiError('结论内容过长，请精简后提交。', 'INVALID_INPUT');
    if (!this.#session || this.#session.phase !== 'submission' || this.#session.paused) throw new ApiError('仅在提交阶段且课堂未暂停时可提交。', 'PHASE_CLOSED');
    if (typeof key !== 'string' || !/^[\x21-\x7E]{1,128}$/.test(key)) throw new ApiError('提交重试标识无效。', 'INVALID_KEY');
    return this.#request('submissions', { method: 'POST', body: { conclusion }, key });
  }
}
