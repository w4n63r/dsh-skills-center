// dsh-skills-center 的浏览器半边。
//
// 左侧栏一个「技能中心」图标，点开是主区的一张卡片墙：搜索、筛选、排序、翻页，
// 点卡片弹出完整中文卡。数据全部来自宿主插件自己的只读 JSON 接口
// （/api/dsh-skills-center/list 与 /card），这里不读盘、不写状态、不碰别人的 DOM。
//
// 手写而不是编译：宿主浏览器模块表提供 react，模块只认 window.__ModuleLoader__.load
// 这一种形状（id 必须等于包名），见 cordis-plugin-development/references/ui-plugin.md。
window.__ModuleLoader__.load({
  id: 'dsh-skills-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useRef } = React;

    const NAMESPACE = 'skills-center';
    const PANEL_ID = 'skills-center';
    const API = '/api/dsh-skills-center';
    const PAGE = 60;

    const ZH = {
      nav: '技能中心',
      title: '技能中心',
      search: '搜索技能名、中文介绍、来源…',
      sort: '排序',
      sortScore: 'S 分',
      sortInstalls: '安装量',
      sortTrend: '8 周趋势',
      sortName: '名称',
      desc: '降序',
      asc: '升序',
      filterAll: '全部',
      filterZh: '有中文卡',
      filterOfficial: '官方精选',
      filterRisky: '有风险信号',
      filterEnriched: '已抓正文',
      loading: '读取中…',
      empty: '没匹配到。换个词试试。',
      failed: '读取失败：',
      more: '加载更多',
      noMore: '已经到底了',
      catalog: '目录',
      matched: '匹配',
      showing: '已显示',
      active: '已激活',
      version: '版本',
      none: '无',
      intro: '介绍',
      usage: '用途',
      notes: '使用注意事项',
      installs: '安装数',
      trend: '8 周趋势',
      source: '来源',
      flags: '标记',
      score: 'S 分',
      audit: '审计',
      auditNone: '没有审计结论（不等于安全）',
      auditPass: '家通过',
      id: 'id',
      installCmd: '自己装（在终端里跑）',
      close: '关闭',
      clickCard: '点卡片看详情',
      noIntro: '上游没给描述，这条目前只有名称、装量、审计结论',
      representative: '官方',
      curated: '精选',
      cardZh: '中文卡',
      enriched: '有正文',
      firstSeen: '首次收录',
    };

    const EN = {
      nav: 'Skills Center',
      title: 'Skills Center',
      search: 'Search name, Chinese intro, or source…',
      sort: 'Sort',
      sortScore: 'Score',
      sortInstalls: 'Installs',
      sortTrend: '8-week trend',
      sortName: 'Name',
      desc: 'Desc',
      asc: 'Asc',
      filterAll: 'All',
      filterZh: 'Chinese cards',
      filterOfficial: 'Official picks',
      filterRisky: 'Risk signals',
      filterEnriched: 'Has body',
      loading: 'Loading…',
      empty: 'No match.',
      failed: 'Failed: ',
      more: 'Load more',
      noMore: 'End of list',
      catalog: 'Catalog',
      matched: 'matched',
      showing: 'shown',
      active: 'active',
      version: 'version',
      none: 'none',
      intro: 'Intro',
      usage: 'Use for',
      notes: 'Caveats',
      installs: 'Installs',
      trend: '8-week trend',
      source: 'Source',
      flags: 'Flags',
      score: 'Score',
      audit: 'Audit',
      auditNone: 'No audit verdict (not the same as safe)',
      auditPass: ' passed',
      id: 'id',
      installCmd: 'Install it yourself (run in a terminal)',
      close: 'Close',
      clickCard: 'Click a card for details',
      noIntro: 'Upstream gave no description; only name, installs and audits are known',
      representative: 'Official',
      curated: 'Curated',
      cardZh: 'Chinese card',
      enriched: 'Has body',
      firstSeen: 'First seen',
    };

    // 词典由 apply 里的 locale 服务注册；这里留一个直读中文的兜底，
    // 保证 locale 拿不到时面板不会变成一片 key。
    let translate = () => '';
    const t = (key) => {
      const value = translate(key);
      return value && value !== key ? value : ZH[key] || key;
    };

    const STYLE = `
.dsc-root{height:100%;min-height:0;display:flex;flex-direction:column;box-sizing:border-box;
color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.dsc-top{padding:14px 18px 10px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.dsc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dsc-title{margin:0;font-size:16px;font-weight:600}
.dsc-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dsc-search{flex:1 1 280px;min-width:200px;display:flex;align-items:center;gap:8px;padding:7px 12px;
border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dsc-search:focus-within{border-color:var(--dsw-alias-brand-primary)}
.dsc-search input{flex:1;min-width:0;border:0;outline:none;background:transparent;color:inherit;font:inherit}
.dsc-search svg{flex:0 0 auto;color:var(--dsw-alias-label-secondary)}
.dsc-select,.dsc-btn{appearance:none;padding:7px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;cursor:pointer;white-space:nowrap}
.dsc-select:hover,.dsc-btn:hover{border-color:var(--dsw-alias-border-l2)}
.dsc-btn[disabled]{opacity:.5;cursor:default}
.dsc-chips{display:flex;gap:8px;flex-wrap:wrap}
.dsc-chip{padding:5px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;
background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}
.dsc-chip:hover{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}
.dsc-chip[data-on="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);
background:var(--dsw-alias-bg-layer-2)}
.dsc-scroll{flex:1 1 auto;min-height:0;overflow:auto;padding:14px 18px 18px}
.dsc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.dsc-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-1);
padding:12px 14px;display:flex;flex-direction:column;gap:8px;cursor:pointer;transition:border-color .12s,background .12s}
.dsc-card:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2)}
.dsc-card-top{display:flex;align-items:flex-start;gap:10px}
.dsc-card-name{flex:1 1 auto;min-width:0}
.dsc-card-name strong{display:block;font-size:13.5px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsc-score{flex:0 0 auto;text-align:right;font-variant-numeric:tabular-nums}
.dsc-score b{display:block;font-size:14px;font-weight:600}
.dsc-score span{font-size:10.5px;color:var(--dsw-alias-label-secondary)}
.dsc-desc{margin:0;font-size:12.5px;line-height:1.5;color:var(--dsw-alias-label-primary);
display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.dsc-desc.dsc-muted{color:var(--dsw-alias-label-secondary);font-style:italic}
.dsc-facts{display:flex;gap:10px;flex-wrap:wrap;font-size:11.5px;color:var(--dsw-alias-label-secondary)}
.dsc-facts b{color:var(--dsw-alias-label-primary);font-weight:500}
.dsc-tags{display:flex;gap:6px;flex-wrap:wrap}
.dsc-tag{padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;font-size:11px;
color:var(--dsw-alias-label-secondary)}
.dsc-tag.dsc-brand{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.dsc-tag.dsc-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsc-tag.dsc-bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsc-tag.dsc-good{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.dsc-up{color:var(--dsw-alias-state-success-primary)}
.dsc-down{color:var(--dsw-alias-state-error-primary)}
.dsc-foot{display:flex;align-items:center;gap:12px;padding:12px 18px 16px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-empty{padding:26px 4px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
.dsc-overlay{position:fixed;inset:0;z-index:40;background:rgba(0,0,0,.38);display:flex;align-items:center;
justify-content:center;padding:32px}
.dsc-modal{width:min(720px,100%);max-height:100%;overflow:auto;border-radius:14px;border:1px solid var(--dsw-alias-border-l1);
background:var(--dsw-alias-bg-overlay);box-shadow:0 18px 48px rgba(0,0,0,.28)}
.dsc-modal-head{position:sticky;top:0;display:flex;align-items:flex-start;gap:12px;padding:14px 18px;
border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-overlay)}
.dsc-modal-head h3{margin:0;font-size:15px}
.dsc-modal-body{padding:14px 18px 18px;display:flex;flex-direction:column;gap:12px}
.dsc-field{display:flex;flex-direction:column;gap:3px}
.dsc-label{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsc-text{margin:0;white-space:pre-wrap;word-break:break-word}
.dsc-code{margin:0;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;
background:var(--dsw-alias-bg-layer-2);font-family:ui-monospace,Consolas,monospace;font-size:12px;
white-space:pre-wrap;word-break:break-all}
.dsc-audit{display:flex;flex-direction:column;gap:4px}
.dsc-audit-row{display:flex;gap:8px;align-items:baseline;font-size:12px}
.dsc-audit-row span:first-child{flex:0 0 auto;min-width:140px;color:var(--dsw-alias-label-secondary)}
`;

    const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
    const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
    const trendClass = (v) => (v == null ? '' : v > 0 ? 'dsc-up' : v < 0 ? 'dsc-down' : '');

    function field(label, value) {
      if (!value) return null;
      return h(
        'div',
        { className: 'dsc-field' },
        h('span', { className: 'dsc-label' }, label),
        h('p', { className: 'dsc-text' }, value),
      );
    }

    function SearchIcon() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('circle', { cx: 7, cy: 7, r: 4.6, stroke: 'currentColor', strokeWidth: 1.4 }),
        h('path', { d: 'M10.6 10.6 14 14', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
      );
    }

    /** 一张技能卡：名称 + S 分 + 介绍 + 事实行 + 标签。 */
    function Card({ row, onOpen }) {
      const tags = [];
      if (row.official) tags.push(['dsc-brand', t('representative')]);
      if (row.curated && !row.official) tags.push(['dsc-brand', t('curated')]);
      tags.push([row.has_zh ? 'dsc-good' : '', t('cardZh')]);
      if (row.enriched) tags.push(['', t('enriched')]);
      const audit = row.audit;
      if (audit) {
        const cls = audit.fail ? 'dsc-bad' : audit.warn ? 'dsc-warn' : 'dsc-good';
        tags.push([cls, `${t('audit')} ${audit.pass}/${audit.judged} ${t('auditPass')}`]);
      }
      for (const flag of row.flags || []) tags.push(['dsc-warn', flag]);

      return h(
        'div',
        { className: 'dsc-card', onClick: () => onOpen(row), role: 'button', tabIndex: 0 },
        h(
          'div',
          { className: 'dsc-card-top' },
          h(
            'div',
            { className: 'dsc-card-name' },
            h('strong', null, row.name_zh || row.slug || row.id),
            h('div', { className: 'dsc-sub' }, `${row.slug || row.id}${row.source ? ` · ${row.source}` : ''}`),
          ),
          h(
            'div',
            { className: 'dsc-score' },
            h('b', null, row.S == null ? '—' : Number(row.S).toFixed(3)),
            h('span', null, 'S'),
          ),
        ),
        h(
          'p',
          { className: row.has_zh || row.description ? 'dsc-desc' : 'dsc-desc dsc-muted' },
          row.description || t('noIntro'),
        ),
        h(
          'div',
          { className: 'dsc-facts' },
          h('span', null, `${t('installs')} `, h('b', null, fmtInt(row.installs))),
          h('span', { className: trendClass(row.trend_pct) }, `${t('trend')} ${fmtPct(row.trend_pct)}`),
        ),
        h(
          'div',
          { className: 'dsc-tags' },
          tags.map(([cls, text], index) =>
            h('span', { key: `${text}-${index}`, className: `dsc-tag ${cls}`.trim() }, text),
          ),
        ),
      );
    }

    /** 详情弹层：完整中文卡 + 审计明细 + 安装命令。 */
    function Detail({ state, onClose }) {
      useEffect(() => {
        const onKey = (event) => {
          if (event.key === 'Escape') onClose();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
      });

      const skill = state.skill || {};
      const row = state.row || {};
      const zh = skill.zh || {};
      const score = skill.score || row.score || {};
      const title = row.name_zh || skill.name_zh || zh.name_zh || row.slug || state.id;

      return h(
        'div',
        { className: 'dsc-overlay', onClick: onClose },
        h(
          'div',
          { className: 'dsc-modal', onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { className: 'dsc-modal-head' },
            h(
              'div',
              { style: { flex: '1 1 auto', minWidth: 0 } },
              h('h3', null, title),
              h('div', { className: 'dsc-sub' }, `${row.verdict || ''}　${skill.id || state.id || ''}`),
            ),
            h('button', { type: 'button', className: 'dsc-btn', onClick: onClose }, t('close')),
          ),
          h(
            'div',
            { className: 'dsc-modal-body' },
            state.status === 'loading' ? h('div', { className: 'dsc-empty' }, t('loading')) : null,
            state.status === 'error' ? h('div', { className: 'dsc-empty' }, t('failed') + (state.error || '')) : null,
            field(t('intro'), zh.intro || skill.intro_zh || skill.description_en || t('noIntro')),
            field(t('usage'), zh.usage),
            field(t('notes'), zh.notes),
            field(t('installs'), fmtInt(skill.installs ?? row.installs)),
            field(t('trend'), fmtPct(skill.trend_pct ?? row.trend_pct)),
            field(t('source'), skill.source),
            field(
              t('score'),
              score.S == null
                ? ''
                : `${Number(score.S).toFixed(3)}（H ${score.H} / T ${score.T} / C ${score.C} / A ${score.A}）`,
            ),
            skill.first_seen || row.first_seen ? field(t('firstSeen'), skill.first_seen || row.first_seen) : null,
            (skill.flags || row.flags || []).length
              ? field(t('flags'), (skill.flags || row.flags || []).join('、'))
              : null,
            (() => {
              const audits = skill.audit?.audits || [];
              if (!audits.length) return field(t('audit'), t('auditNone'));
              return h(
                'div',
                { className: 'dsc-field' },
                h('span', { className: 'dsc-label' }, t('audit')),
                h(
                  'div',
                  { className: 'dsc-audit' },
                  audits.map((item, index) =>
                    h(
                      'div',
                      { className: 'dsc-audit-row', key: `${item.provider}-${index}` },
                      h('span', null, item.provider || item.slug || '—'),
                      h(
                        'span',
                        {
                          className:
                            item.status === 'fail' ? 'dsc-down' : item.status === 'warn' ? 'dsc-up' : '',
                        },
                        `${item.status || '—'}${item.riskLevel ? ` / ${item.riskLevel}` : ''}`,
                      ),
                    ),
                  ),
                ),
              );
            })(),
            row.install_hint
              ? h(
                  'div',
                  { className: 'dsc-field' },
                  h('span', { className: 'dsc-label' }, t('installCmd')),
                  h('pre', { className: 'dsc-code' }, row.install_hint),
                )
              : null,            field(t('id'), skill.id || row.id),
          ),
        ),
      );
    }

    function Panel() {
      const [state, setState] = useState({
        status: 'loading',
        rows: [],
        matched: 0,
        total: 0,
        version: null,
        active: [],
        maxActive: 0,
        error: '',
        loadingMore: false,
      });
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState('S');
      const [dir, setDir] = useState('desc');
      const [filter, setFilter] = useState('');
      const [detail, setDetail] = useState({ status: 'idle', id: '', skill: null, row: null });
      const requestId = useRef(0);

      const buildQuery = (offset) => {
        const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset), sort, dir });
        if (query.trim()) params.set('q', query.trim());
        if (filter) params.set('filter', filter);
        return params.toString();
      };

      const fetchPage = async (offset, append) => {
        const token = requestId.current + 1;
        requestId.current = token;
        if (append) setState((prev) => ({ ...prev, loadingMore: true }));
        else setState((prev) => ({ ...prev, status: 'loading', error: '' }));
        try {
          const response = await fetch(`${API}/list?${buildQuery(offset)}`, {
            headers: { accept: 'application/json' },
          });
          const body = await response.json();
          if (requestId.current !== token) return; // 有更新的请求在路上，这一份丢弃
          setState((prev) => {
            const rows = append ? prev.rows.concat(body.rows || []) : body.rows || [];
            const seen = new Set();
            const unique = rows.filter((row) => (seen.has(row.id) ? false : seen.add(row.id)));
            return {
              status: 'ready',
              rows: unique,
              matched: body.matched || 0,
              total: body.total || 0,
              version: body.version || null,
              active: Array.isArray(body.active) ? body.active : prev.active,
              maxActive: body.maxActive || prev.maxActive,
              error: '',
              loadingMore: false,
            };
          });
        } catch (error) {
          if (requestId.current !== token) return;
          setState((prev) => ({
            ...prev,
            status: prev.rows.length ? 'ready' : 'error',
            error: String(error && error.message ? error.message : error),
            loadingMore: false,
          }));
        }
      };

      // 查询条件一变就重头拉第一页（防抖 200ms，打字期间不打接口）。
      useEffect(() => {
        const timer = setTimeout(() => fetchPage(0, false), 200);
        return () => clearTimeout(timer);
      }, [query, sort, dir, filter]);

      // 切面板/卸载时把未完成的响应标记作废，避免回过头的 setState。
      useEffect(() => () => {
        requestId.current += 1;
      }, []);

      const openDetail = async (row) => {
        setDetail({ status: 'loading', id: row.id, skill: null, row });
        try {
          const response = await fetch(`${API}/card?id=${encodeURIComponent(row.id)}`, {
            headers: { accept: 'application/json' },
          });
          const skill = await response.json();
          setDetail({ status: 'ready', id: row.id, skill, row });
        } catch (error) {
          setDetail({ status: 'error', id: row.id, skill: null, row, error: String(error) });
        }
      };

      const filters = [
        ['', t('filterAll')],
        ['zh', t('filterZh')],
        ['official', t('filterOfficial')],
        ['risky', t('filterRisky')],
        ['enriched', t('filterEnriched')],
      ];
      const sorts = [
        ['S', t('sortScore')],
        ['installs', t('sortInstalls')],
        ['trend', t('sortTrend')],
        ['name', t('sortName')],
      ];

      const meta = [
        `${t('catalog')} ${fmtInt(state.total)}`,
        state.matched ? `${t('matched')} ${fmtInt(state.matched)}` : '',
        `${t('version')} ${state.version || t('none')}`,
        `${t('active')} ${state.active.length}${state.maxActive ? `/${state.maxActive}` : ''}`,
      ]
        .filter(Boolean)
        .join(' · ');

      const hasMore = state.rows.length < state.matched;

      return h(
        'div',
        { className: 'dsc-root' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dsc-top' },
          h(
            'div',
            { className: 'dsc-head' },
            h('h2', { className: 'dsc-title' }, t('title')),
            h('span', { className: 'dsc-meta' }, meta),
          ),
          h(
            'div',
            { className: 'dsc-tools' },
            h(
              'label',
              { className: 'dsc-search' },
              h(SearchIcon),
              h('input', {
                type: 'search',
                value: query,
                placeholder: t('search'),
                spellCheck: false,
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(
              'select',
              {
                className: 'dsc-select',
                value: sort,
                onChange: (event) => setSort(event.target.value),
                title: t('sort'),
              },
              sorts.map(([value, label]) => h('option', { key: value, value }, label)),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dsc-btn',
                onClick: () => setDir(dir === 'desc' ? 'asc' : 'desc'),
              },
              dir === 'desc' ? t('desc') : t('asc'),
            ),
          ),
          h(
            'div',
            { className: 'dsc-chips' },
            filters.map(([value, label]) =>
              h(
                'button',
                {
                  key: value || 'all',
                  type: 'button',
                  className: 'dsc-chip',
                  'data-on': filter === value ? 'true' : 'false',
                  onClick: () => setFilter(value),
                },
                label,
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dsc-scroll' },
          state.status === 'loading'
            ? h('div', { className: 'dsc-empty' }, t('loading'))
            : state.rows.length
              ? h(
                  'div',
                  { className: 'dsc-grid' },
                  state.rows.map((row) => h(Card, { key: row.id, row, onOpen: openDetail })),
                )
              : h('div', { className: 'dsc-empty' }, state.status === 'error' ? t('failed') + state.error : t('empty')),
        ),
        h(
          'div',
          { className: 'dsc-foot' },
          h('span', null, `${t('showing')} ${fmtInt(state.rows.length)}${state.matched ? ` / ${fmtInt(state.matched)}` : ''}`),
          hasMore
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'dsc-btn',
                  disabled: state.loadingMore,
                  onClick: () => fetchPage(state.rows.length, true),
                },
                state.loadingMore ? t('loading') : t('more'),
              )
            : h('span', null, t('noMore')),
          state.error && state.rows.length ? h('span', null, t('failed') + state.error) : null,
        ),
        detail.status === 'idle' ? null : h(Detail, { state: detail, onClose: () => setDetail({ status: 'idle', id: '', skill: null, row: null }) }),
      );
    }

    // 侧栏图标：一个「目录 + 列表」的方框，尺寸与选中态都由宿主给。
    function Icon(owner) {
      const size = (owner && owner.size) || 16;
      const active = Boolean(owner && owner.active);
      const color = active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-secondary)';
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { x: 1.6, y: 2.2, width: 5.6, height: 5.6, rx: 1.3, stroke: color, strokeWidth: 1.3 }),
        h('rect', { x: 1.6, y: 8.9, width: 5.6, height: 4.9, rx: 1.3, stroke: color, strokeWidth: 1.3 }),
        h('path', {
          d: 'M10.4 4.4h4M10.4 7.3h4M10.4 11.4h2.4',
          stroke: color,
          strokeWidth: 1.3,
          strokeLinecap: 'round',
        }),
      );
    }

    function apply(ctx) {
      // 词典注册失败不能连带面板一起消失：locale 缺失时 t() 直读中文兜底。
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, 'zh', ZH), 'skills-center: locale zh');
      } catch (error) {
        void error;
      }
      try {
        ctx.effect(() => ctx.locale.register(NAMESPACE, 'en', EN), 'skills-center: locale en');
      } catch (error) {
        void error;
      }
      translate = typeof ctx.locale?.bind === 'function' ? ctx.locale.bind(NAMESPACE) : () => '';

      // 侧栏那一行是 id，主区那一格是同一个 id 的 key——宿主靠这个 id 把图标和面板对上。
      ctx.slots.inject('sidebar.panellist', () => {
        const offRow = ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: 2,
            label: () => t('nav'),
            locale: NAMESPACE,
            inject: () => ({ t }),
          },
          Icon,
        );
        const offPanel = ctx.slots.register(
          { name: 'main', key: PANEL_ID, locale: NAMESPACE, inject: () => ({ t }) },
          Panel,
        );
        return () => {
          if (typeof offPanel === 'function') offPanel();
          if (typeof offRow === 'function') offRow();
        };
      });
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
