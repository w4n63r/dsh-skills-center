// /api/v1 客户端：限流、重试、分页、以及「同一份代码能被 replay 驱动」的注入点。
// 设计约束：这条链路只能在 Vercel 里拿到 OIDC token，所以本地不指望它跑通——
// 本地要验证的是上游 JSON → catalog.json 的映射，靠 --replay 走同样的代码路径。

export const DEFAULT_BASE = 'https://skills.sh';
export const PER_PAGE = 500; // 文档允许的上限；17 页覆盖全量约 8420 条
export const RATE_LIMIT_PER_MIN = 600; // 文档写明的 (team, project) 级限额
export const MIN_INTERVAL_MS = Math.ceil(60000 / RATE_LIMIT_PER_MIN);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function authHeaders(token) {
  // 实测：只有 Authorization: Bearer 被接受。文档里那个 x-vercel-oidc-token「等价写法」
  // 打在 /api/v1/skills 与 /curated 上直接 401 authentication_required，服务端根本不读。
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** 响应信封：{data:[…], pagination:{page, perPage, total, hasMore}}；search 那套是老形状，一并兼容。 */
export function unwrap(payload) {
  if (Array.isArray(payload)) return { items: payload, total: payload.length, hasMore: false };
  const items = payload?.data ?? payload?.skills ?? payload?.items ?? payload?.results ?? [];
  const total = payload?.pagination?.total ?? payload?.total ?? payload?.count ?? (items.length || 0);
  const hasMore = payload?.pagination?.hasMore ?? payload?.hasMore ?? null;
  return { items: Array.isArray(items) ? items : [], total, hasMore };
}

/** curated 是「按 owner 分组」的形状：{data:[{owner, skills:[…], totalInstalls}]}，必须摊平。 */
export function flattenCurated(payload) {
  const groups = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
  const skills = [];
  for (const group of groups) {
    if (Array.isArray(group?.skills)) {
      for (const skill of group.skills) skills.push({ ...skill, curated: true, official: true });
    } else if (group?.id) {
      skills.push({ ...group, curated: true });
    }
  }
  return skills;
}

export function createClient({ token, base = DEFAULT_BASE, fetchImpl = globalThis.fetch, signal } = {}) {
  let lastCallAt = 0;
  let calls = 0;

  async function request(path, { retries = 4 } = {}) {
    if (!fetchImpl) throw new Error('no fetch available');
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    calls += 1;
    const url = path.startsWith('http') ? path : `${base}${path}`;
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let res;
      try {
        res = await fetchImpl(url, { headers: { accept: 'application/json', ...authHeaders(token) }, signal });
      } catch (err) {
        lastError = err;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        await sleep(Number.isFinite(retryAfter) ? retryAfter * 1000 : 2000 * 2 ** attempt);
        lastError = new Error(`429 rate limited on ${url}`);
        continue;
      }
      if (res.status === 401) {
        // 说明 token 没拿到或不被接受：这是部署配置问题，不是网络抖动，重试没意义。
        throw new Error(
          `401 authentication_required on ${url} — VERCEL_OIDC_TOKEN missing or rejected (enable OIDC Federation on the Vercel project)`,
        );
      }
      if (!res.ok) {
        lastError = new Error(`${res.status} ${res.statusText || ''} on ${url}`);
        if (res.status < 500) throw lastError;
        await sleep(500 * 2 ** attempt);
        continue;
      }
      return res.json();
    }
    throw lastError;
  }

  return {
    request,
    get stats() {
      return { calls };
    },
    // page 是 0 起始（文档：page default 0）。这里对外统一暴露 0 起始，别再自己加一。
    async listPage({ view = 'all-time', page = 0, perPage = PER_PAGE, source } = {}) {
      const params = new URLSearchParams({ view, page: String(page), per_page: String(perPage) });
      if (source) params.set('source', source);
      return unwrap(await request(`/api/v1/skills?${params}`));
    },
    /** 全量榜单。终止条件三选一：hasMore=false / 本页不满 / 拿够了 total。 */
    async listAll({ view = 'all-time', perPage = PER_PAGE, maxPages = 400, onPage } = {}) {
      const all = [];
      for (let page = 0; page < maxPages; page += 1) {
        const { items, total, hasMore } = await this.listPage({ view, page, perPage });
        all.push(...items);
        onPage?.({ page, got: items.length, total, accumulated: all.length });
        if (!items.length) break;
        if (hasMore === false) break;
        if (hasMore == null && items.length < perPage) break;
        if (Number.isFinite(total) && all.length >= total) break;
      }
      return all;
    },
    async curated() {
      // curated 是按 owner 分组的形状，必须摊平后才和列表项同构
      return flattenCurated(await request('/api/v1/skills/curated'));
    },
    async detail(id) {
      return request(`/api/v1/skills/${id.split('/').map(encodeURIComponent).join('/')}`);
    },
    async audit(id) {
      return request(`/api/v1/skills/audit/${id.split('/').map(encodeURIComponent).join('/')}`);
    },
  };
}

/** 并发跑一批任务，但把并发压在 limit 内；单个失败不拖垮整批（返回 null）。 */
export async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        out[index] = await worker(items[index], index);
      } catch {
        out[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return out;
}
