// /api/v1 客户端：限流、重试、分页、以及「同一份代码能被 replay 驱动」的注入点。
// 设计约束：这条链路只能在 Vercel 里拿到 OIDC token，所以本地不指望它跑通——
// 本地要验证的是上游 JSON → catalog.json 的映射，靠 --replay 走同样的代码路径。

export const DEFAULT_BASE = 'https://skills.sh';
export const SITE = 'https://www.skills.sh'; // 页面（HTML）站点和 API 同域但不同主机名，实测两个都能解析
// 文档允许的上限是 500，实测 1000 会被夹回 500。全量 93036 条 → 187 页，
// 所以「抓多少页」必须是显式参数（见 collect.mjs 的 limitRecords），不能默认全量。
export const PER_PAGE = 500;
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
  if (Array.isArray(payload)) return { items: payload, total: payload.length, hasMore: false, perPage: payload.length };
  const items = payload?.data ?? payload?.skills ?? payload?.items ?? payload?.results ?? [];
  const total = payload?.pagination?.total ?? payload?.total ?? payload?.count ?? (items.length || 0);
  const hasMore = payload?.pagination?.hasMore ?? payload?.hasMore ?? null;
  // 服务端会把自己的 perPage 回显出来：算「还要几页」必须用它，不能用手上请求的那个 per_page。
  // 实测 per_page=1000 会被夹回 500；fixture 也会钉一个更小的 pageSize，两者都靠这个字段暴露。
  const perPage = Number(payload?.pagination?.perPage) || null;
  return { items: Array.isArray(items) ? items : [], total, hasMore, perPage };
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

  /** 同一个限流器与计数器的文本请求（页面 HTML 用）。不解析 JSON，也不吃 /api/v1 的鉴权头。 */
  async function requestText(url) {
    if (!fetchImpl) throw new Error('no fetch available');
    const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    calls += 1;
    const res = await fetchImpl(url, { headers: { accept: 'text/html' } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText || ''} on ${url}`);
    return res.text();
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
    /**
     * 取「前 maxPages 页」，页与页之间并发。
     *
     * 为什么必须并发：实测列表接口单次固定约 7s（per_page=1 也是 7.5s，与载荷无关），
     * 一页一个请求串行取 6 页就是 42s —— 直接吃掉 Vercel Hobby 的 60s。并发 6~8 实测无 429，
     * 8 页并发总耗时 8.4s（≈ 单次延迟）。所以延迟是服务端每次查询的固定成本，并发是唯一的解法。
     *
     * 终止条件：先取第 0 页拿 pagination.total，再按 total 和 maxPages 取小值决定真正要几页，
     * 绝不闷头翻到 hasMore 变 false（全量 187 页）。
     */
    async listPages({ view = 'all-time', perPage = PER_PAGE, maxPages = 6, concurrency = 6, onPage } = {}) {
      const first = await this.listPage({ view, page: 0, perPage });
      const all = [...first.items];
      const total = first.total;
      // 用服务端回显的每页大小算页数（见 unwrap 的注释）
      const effectivePerPage = first.perPage || perPage;
      onPage?.({ page: 0, got: first.items.length, total, accumulated: all.length });
      if (!first.items.length) return { items: all, total, pages: 1, failed: [] };

      const byTotal = Number.isFinite(total) && total > 0 ? Math.ceil(total / effectivePerPage) : maxPages;
      const pages = Math.max(1, Math.min(maxPages, byTotal));
      const wanted = [];
      for (let page = 1; page < pages; page += 1) wanted.push(page);

      const results = await mapLimit(wanted, concurrency, async (page) => {
        const { items, total: t } = await this.listPage({ view, page, perPage });
        return { page, items, total: t };
      });
      const failed = [];
      // 并发跑完后按页号排序拼回去，保证记录顺序等于服务端顺序（后续 preCluster 依赖安装量降序）
      const ordered = results
        .map((r, i) => r || { page: wanted[i], items: null })
        .sort((a, b) => a.page - b.page);
      for (const entry of ordered) {
        if (!entry.items) {
          failed.push(entry.page);
          continue;
        }
        all.push(...entry.items);
        onPage?.({ page: entry.page, got: entry.items.length, total: entry.total ?? total, accumulated: all.length });
      }
      return { items: all, total, pages, failed };
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
    /**
     * 技能页 HTML（https://www.skills.sh/<source>/<slug>）。为什么需要它：
     * /api/v1 的列表项和 detail 都不返回 weeklyInstalls（实测 detail 只有 id/source/slug/installs/hash/files），
     * 「8 周趋势」这个维度只存在于页面上的 aria-label="Weekly installs: …" 里，只能抓 HTML。
     * 顺手把页面上的「First Seen」也解析出来——同一份 HTML，不加请求：
     *   <span>First Seen</span></div><div class="...">Jan 19, 2026</div>
     * 页面里**没有**「更新时间」这类字段（实测扫过 ISO 日期、Updated/Modified/ago 文案都是 0 命中），
     * 所以面板只展示发布时间，不做「更新时间」。
     * 一次 1 个请求，所以调用方必须把它算进预算。
     */
    async page(id) {
      const path = id.split('/').map(encodeURIComponent).join('/');
      const html = await requestText(`${SITE}/${path}`);
      return { weekly_series: parseWeeklyInstalls(html), first_seen: parseFirstSeen(html) };
    },
  };
}

const MONTHS = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

/**
 * 页面上的 First Seen（上游自己的首次收录日期）→ ISO 日期；解析不出来给 null，不编。
 * 不用 `new Date(...)`：`Jan 19, 2026` 会按本地时区解析，再 toISOString() 会退到前一天
 * （实测时区 +08:00 下 Jan 19 变成 Jan 18）。这里直接按月名映射拼字符串，不经过时区。
 */
export function parseFirstSeen(html) {
  const m = /First Seen<\/span><\/div><div[^>]*>([^<]{3,40})<\/div>/.exec(String(html || ''));
  if (!m) return null;
  const text = m[1].trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return text;
  const named = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s*(\d{4})$/.exec(text);
  if (!named) return null;
  const month = MONTHS[named[1].slice(0, 3).toLowerCase()];
  if (!month) return null;
  const day = String(Number(named[2])).padStart(2, '0');
  return `${named[3]}-${month}-${day}`;
}

/**
 * 从技能页 HTML 里抠出 8 周安装量序列。
 * 逗号既是千分位又是分隔符的老坑：先用「1-3 位 + 若干组 ,ddd」整体匹配数字，再逐个数。
 */
export function parseWeeklyInstalls(html) {
  const m = /aria-label="Weekly installs:([^"]*)"/.exec(String(html || ''));
  if (!m) return null;
  const nums = (m[1].match(/\d{1,3}(?:,\d{3})*/g) || []).map((x) => Number(x.replace(/,/g, '')));
  return nums.length ? nums.slice(0, 8) : null;
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
