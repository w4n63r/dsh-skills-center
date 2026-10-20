// 离线回放：把一份 fixture 变成 createClient 能用的 fetchImpl，让 --replay 走和线上完全相同的代码路径。
//
// fixture 的形状必须与 HANDOFF §3.1 的实测契约一致（不是我们希望的形状）：
//   - /api/v1/skills?page=N  → { data:[V1Skill], pagination:{page, perPage, total, hasMore} }，page 从 0 起始
//   - /api/v1/skills/curated → { data:[{owner, totalInstalls, featuredRepo, featuredSkill, skills:[V1Skill]}], ... }（按 owner 分组）
//   - /api/v1/skills/{id}    → detail，只有这里才有 hash
//   - /api/v1/skills/audit/{id} → { id, source, slug, audits:[{provider, slug, status, summary, auditedAt, riskLevel?}] }
//
// pageSize 是 fixture 专用旋钮：真实上游 per_page 最大 500，用这么小的数据集翻不出第二页，
// 所以 fixture 可以声明一个更小的 pageSize 来真的走一遍「0 起始 + hasMore」的分页分支。
// 线上运行时 pageSize 为 null，per_page 完全交给请求参数。

import { readFile } from 'node:fs/promises';

const ok = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  statusText: status === 404 ? 'Not Found' : '',
  headers: { get: () => null },
  json: async () => body,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

/** 造一个假的 fetch。`impl.calls` 记录每个请求的 url 与 headers，供测试断言。 */
export function createReplayFetch(fixture, { log = () => {} } = {}) {
  const list = Array.isArray(fixture?.list) ? fixture.list : [];
  const pinnedPageSize = Number.isFinite(fixture?.pageSize) && fixture.pageSize > 0 ? fixture.pageSize : null;
  const calls = [];

  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init?.headers || {} });
    const u = new URL(String(url));

    // 技能页面（HTML）：只有这里能拿到 8 周安装量，趋势就靠它
    if (u.hostname === 'www.skills.sh') {
      const id = decodeURIComponent(u.pathname.replace(/^\//, ''));
      const weekly = fixture?.pages?.[id];
      if (!weekly) return ok('<html>no weekly installs</html>', 404);
      return ok(`<html><span aria-label="Weekly installs:${weekly.map((n) => ` ${n.toLocaleString('en-US')}`)}"></span></html>`);
    }

    if (u.pathname === '/api/v1/skills') {
      // 契约：page 默认 0，per_page 1–500 默认 100；这里缺省值取 per_page=500 与客户端一致
      const page = Number(u.searchParams.get('page') ?? 0);
      const per = Number(u.searchParams.get('per_page') || 500);
      const size = pinnedPageSize ? Math.min(per, pinnedPageSize) : per;
      const start = page * size;
      const rows = list.slice(start, start + size);
      log(`replay list page=${page} → ${rows.length}/${list.length}`);
      return ok({
        data: rows,
        pagination: { page, perPage: size, total: list.length, hasMore: start + size < list.length },
      });
    }

    if (u.pathname === '/api/v1/skills/curated') {
      const curated = fixture?.curated;
      log(`replay curated → ${Array.isArray(curated?.data) ? curated.data.length : 0} owner groups`);
      return ok(curated ?? { data: [], totalOwners: 0, totalSkills: 0, generatedAt: null });
    }

    if (u.pathname.startsWith('/api/v1/skills/audit/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/v1/skills/audit/'.length));
      const body = fixture?.audits?.[id];
      // 缺失就老实回 404：线上没有审计记录时也是这个行为，别用空对象假装有数据
      return body ? ok(body) : ok({ error: 'not_found', id }, 404);
    }

    if (u.pathname.startsWith('/api/v1/skills/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/v1/skills/'.length));
      const body = fixture?.details?.[id];
      return body ? ok(body) : ok({ error: 'not_found', id }, 404);
    }

    return ok({ error: 'unknown_path', path: u.pathname }, 404);
  };

  impl.calls = calls;
  return impl;
}

/** 读 fixture 文件 → fetchImpl。 */
export async function loadReplayFixture(path) {
  const fixture = JSON.parse(await readFile(path, 'utf8'));
  return { fixture, fetchImpl: createReplayFetch(fixture) };
}
