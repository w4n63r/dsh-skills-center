// 榜单页：插件自己吐一张只读 HTML，不引入前端构建。
// 目录走 /api/dsh-skills-center/ 打开；卡片详情复用 /card 接口，不重复实现中文渲染。

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function rankingPayload({ version, count, shown, active, maxActive, skills }) {
  return {
    version: version ?? null,
    count: count ?? skills.length,
    shown: shown ?? skills.length,
    active: active ?? [],
    maxActive: maxActive ?? null,
    rows: skills.map((s) => ({
      id: s.id,
      slug: s.slug,
      name: s.name_zh || s.slug,
      // 中文卡在 s.zh.intro（采集端可能整块没给，老样例里也见过 intro_zh 这种写法，一并认）
      intro: s.zh?.intro || s.intro_zh || s.description_en || '',
      installs: s.installs ?? null,
      trend_pct: s.trend_pct ?? null,
      S: s.score?.S ?? null,
      verdict: s.verdict || '',
      flags: s.flags || [],
    })),
  };
}

export function renderRankingPage(payload) {
  const data = JSON.stringify(payload).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>技能中心 · ${escapeHtml(payload.count)} 条</title>
<style>
:root{--fg:#1a1a1a;--dim:#6b6b6b;--line:#e4e4e4;--bg:#fafafa;--up:#1a7f37;--down:#b42318;--mark:#fff6d6}
@media (prefers-color-scheme:dark){:root{--fg:#e8e8e8;--dim:#9a9a9a;--line:#333;--bg:#161616;--up:#4ade80;--down:#f87171;--mark:#3a3410}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
header{padding:16px 20px;border-bottom:1px solid var(--line);display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}
h1{font-size:16px;margin:0;font-weight:600}
.meta{color:var(--dim);font-size:12px}
input{padding:6px 10px;border:1px solid var(--line);border-radius:6px;background:transparent;color:inherit;min-width:240px}
main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:0}
table{width:100%;border-collapse:collapse}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}
th{position:sticky;top:0;background:var(--bg);font-size:12px;color:var(--dim);font-weight:500;cursor:pointer;white-space:nowrap}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.row{cursor:pointer}
tr.row:hover{background:color-mix(in srgb,var(--fg) 5%,transparent)}
tr.on{background:color-mix(in srgb,var(--fg) 9%,transparent)}
.name{font-weight:600}
.sub{color:var(--dim);font-size:12px}
.up{color:var(--up)}.down{color:var(--down)}
.flag{display:inline-block;border:1px solid var(--line);border-radius:4px;padding:0 4px;font-size:11px;color:var(--dim);margin-right:4px}
aside{border-left:1px solid var(--line);padding:14px 18px;min-height:60vh;position:sticky;top:0;max-height:100vh;overflow:auto;white-space:pre-wrap}
aside h2{font-size:14px;margin:0 0 8px}
.empty{color:var(--dim);padding:24px}
@media (max-width:860px){main{grid-template-columns:1fr}aside{border-left:0;border-top:1px solid var(--line);position:static;max-height:none}}
</style></head>
<body>
<header>
  <h1>技能中心</h1>
  <span class="meta" id="meta"></span>
  <input id="q" placeholder="筛技能名 / 简介 / 标记（直接打字）" autocomplete="off">
</header>
<main>
  <div><table>
    <thead><tr>
      <th data-k="idx">#</th><th data-k="name">技能</th><th data-k="installs">安装数</th>
      <th data-k="trend_pct">8 周</th><th data-k="S">评分</th><th>判断 / 标记</th>
    </tr></thead>
    <tbody id="rows"></tbody>
  </table></div>
  <aside id="card"><div class="empty">点左边任意一行看完整卡片。</div></aside>
</main>
<script id="data" type="application/json">${data}</script>
<script>
const D = JSON.parse(document.getElementById('data').textContent);
document.getElementById('meta').textContent =
  '目录 ' + D.count + ' 条' + (D.shown && D.shown < D.count ? '（本页列出按 S 排的前 ' + D.shown + ' 条；卡片详情对全部 id 有效）' : '')
  + ' · 版本 ' + (D.version || '无') + ' · 已激活 ' + D.active.length + (D.maxActive ? '/' + D.maxActive : '');
const RENDER_CAP = 400;
let sortKey = 'S', sortDir = -1, query = '';
const body = document.getElementById('rows'), aside = document.getElementById('card');
const fmt = (n) => n == null ? '—' : n.toLocaleString('en-US');
const pct = (t) => t == null ? '<span class="sub">—</span>'
  : '<span class="' + (t > 0 ? 'up' : t < 0 ? 'down' : 'sub') + '">' + (t > 0 ? '+' : '') + t + '%</span>';
const raw = (t) => t == null ? -1e9 : t;

function draw() {
  const q = query.trim().toLowerCase();
  let rows = D.rows.filter((r) => !q || (r.name + ' ' + r.slug + ' ' + r.intro + ' ' + r.verdict + ' ' + r.flags.join(' ')).toLowerCase().includes(q));
  rows.sort((a, b) => {
    if (sortKey === 'name') return sortDir * String(a.name).localeCompare(String(b.name), 'zh');
    return sortDir * (raw(a[sortKey]) - raw(b[sortKey]));
  });
  // 全量目录动辄七千条，一次性建七千个 <tr> 会卡住主线程；只画前 RENDER_CAP 行，
  // 但搜索/排序作用于全量（数据在 D.rows 里），并在 meta 行如实写出「画了多少/匹配多少」。
  const shown = rows.slice(0, RENDER_CAP);
  body.innerHTML = '';
  for (const [i, r] of shown.entries()) {
    const tr = document.createElement('tr');
    tr.className = 'row';
    tr.dataset.id = r.id;
    tr.innerHTML = '<td class="num sub">' + (i + 1) + '</td>'
      + '<td><div class="name"></div><div class="sub"></div></td>'
      + '<td class="num">' + fmt(r.installs) + '</td>'
      + '<td class="num">' + pct(r.trend_pct) + '</td>'
      + '<td class="num">' + (r.S == null ? '—' : Math.round(r.S * 100)) + '</td>'
      + '<td><div class="sub"></div></td>';
    tr.querySelector('.name').textContent = r.name;
    tr.querySelector('.name + .sub').textContent = r.slug;
    const judge = tr.children[5].querySelector('.sub');
    judge.textContent = r.verdict;
    for (const f of r.flags) {
      const s = document.createElement('span');
      s.className = 'flag';
      s.textContent = f;
      tr.children[5].appendChild(s);
    }
    tr.onclick = () => openCard(r.id, tr);
    body.appendChild(tr);
  }
  const meta = document.getElementById('meta');
  meta.textContent = D.count + ' 条 · 匹配 ' + rows.length + (rows.length > shown.length ? '（画前 ' + shown.length + '）' : '')
    + ' · 版本 ' + (D.version || '无') + ' · 已激活 ' + D.active.length + (D.maxActive ? '/' + D.maxActive : '');
  if (!rows.length) body.innerHTML = '<tr><td colspan="6" class="empty">没匹配到。</td></tr>';
}

async function openCard(id, tr) {
  for (const el of body.querySelectorAll('tr.on')) el.classList.remove('on');
  tr.classList.add('on');
  aside.textContent = '读取中…';
  try {
    const r = await fetch('/api/dsh-skills-center/card?id=' + encodeURIComponent(id));
    const s = await r.json();
    aside.innerHTML = '';
    const h = document.createElement('h2');
    h.textContent = (s.name_zh || s.slug) + ' · ' + s.id;
    aside.appendChild(h);
    const pre = document.createElement('div');
    pre.textContent = s.text || JSON.stringify(s, null, 2);
    aside.appendChild(pre);
  } catch (e) { aside.textContent = '读取失败：' + e; }
}

for (const th of document.querySelectorAll('th[data-k]')) {
  th.onclick = () => {
    const k = th.dataset.k;
    sortDir = sortKey === k ? -sortDir : (k === 'name' ? 1 : -1);
    sortKey = k;
    draw();
  };
}
document.getElementById('q').oninput = (e) => { query = e.target.value; draw(); };
draw();
</script>
</body></html>`;
}
