// dsh-skills-center 的浏览器半边。
//
// 只做一件事：在左侧栏放一个「技能中心」图标，点开后在主区渲染一个可搜索、可排序、
// 点开能看中文卡的只读面板。数据全部来自宿主插件自己的只读 JSON 接口
// （/api/dsh-skills-center/list 与 /card），这里不读盘、不写状态、不碰别人的 DOM。
//
// 手写而不是编译：宿主浏览器模块表提供 react，模块只认 window.__ModuleLoader__.load
// 这一种形状（id 必须等于包名），见 cordis-plugin-development/references/ui-plugin.md。
window.__ModuleLoader__.load({
  id: 'dsh-skills-center',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useMemo } = React;

    const NAMESPACE = 'skills-center';
    const PANEL_ID = 'skills-center';
    const API = '/api/dsh-skills-center';
    const RENDER_CAP = 400;

    const ZH = {
      nav: '技能中心',
      title: '技能中心',
      search: '搜技能名 / 中文介绍 / 来源（全目录，不只这一屏）',
      onlyZh: '只看有中文卡',
      colName: '技能',
      colInstalls: '安装数',
      colTrend: '8 周',
      colScore: 'S',
      colVerdict: '判断',
      loading: '读取中…',
      empty: '没匹配到。',
      pick: '点左边任意一行看完整卡片。',
      failed: '读取失败：',
      directory: '目录',
      items: '条',
      matched: '匹配',
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
      id: 'id',
      noIntro: '上游没给描述，这条目前只有名称、装量、审计结论',
      capped: '（只画前 %n 行，搜索与排序作用于全部加载结果）',
    };

    const EN = {
      nav: 'Skills Center',
      title: 'Skills Center',
      search: 'Search name, Chinese intro, or source (whole catalog)',
      onlyZh: 'Chinese cards only',
      colName: 'Skill',
      colInstalls: 'Installs',
      colTrend: '8 wk',
      colScore: 'S',
      colVerdict: 'Verdict',
      loading: 'Loading…',
      empty: 'No match.',
      pick: 'Pick a row to read its card.',
      failed: 'Failed: ',
      directory: 'Catalog',
      items: '',
      matched: 'matched',
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
      id: 'id',
      noIntro: 'Upstream gave no description; only name, installs and audits are known',
      capped: ' (first %n rows drawn; search and sort cover everything loaded)',
    };

    // 词典由 apply 里的 locale 服务注册；这里留一个直读中文的兜底，
    // 保证 locale 拿不到时面板不会变成一片 key。
    let translate = () => '';
    const t = (key) => {
      const value = translate(key);
      return value && value !== key ? value : ZH[key] || key;
    };

    const STYLE = `
.dsc-root{height:100%;min-height:0;display:flex;flex-direction:column;gap:10px;padding:14px 18px 16px;box-sizing:border-box;
color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);
font:13px/1.55 -apple-system,"Segoe UI","Microsoft YaHei",system-ui,sans-serif}
.dsc-head{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap}
.dsc-title{margin:0;font-size:15px;font-weight:600}
.dsc-meta{color:var(--dsw-alias-label-secondary);font-size:12px}
.dsc-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.dsc-input{flex:1 1 260px;min-width:180px;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;
background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;outline:none}
.dsc-input:focus{border-color:var(--dsw-alias-brand-primary)}
.dsc-check{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12px;
user-select:none;cursor:pointer;white-space:nowrap}
.dsc-body{flex:1 1 auto;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) minmax(0,368px);gap:12px}
.dsc-scroll{min-height:0;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;
background:var(--dsw-alias-bg-layer-1)}
.dsc-table{width:100%;border-collapse:collapse}
.dsc-table th{position:sticky;top:0;z-index:1;text-align:left;padding:7px 10px;font-size:12px;font-weight:500;
color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2);
border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;white-space:nowrap}
.dsc-table td{padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}
.dsc-row{cursor:pointer}
.dsc-row:hover td{background:var(--dsw-alias-bg-layer-2)}
.dsc-row[data-open="true"] td{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dsc-name{font-weight:600}
.dsc-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsc-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dsc-up{color:var(--dsw-alias-state-success-primary)}
.dsc-down{color:var(--dsw-alias-state-error-primary)}
.dsc-flag{display:inline-block;margin:2px 4px 0 0;padding:0 5px;border:1px solid var(--dsw-alias-border-l1);
border-radius:5px;font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsc-detail{padding:12px 14px;display:flex;flex-direction:column;gap:9px}
.dsc-detail h3{margin:0;font-size:14px;line-height:1.4}
.dsc-label{display:block;color:var(--dsw-alias-label-secondary);font-size:11.5px}
.dsc-text{margin:0;white-space:pre-wrap;word-break:break-word}
.dsc-empty{padding:18px;color:var(--dsw-alias-label-secondary);font-size:12.5px}
`;

    const fmtInt = (n) => (n == null ? '—' : Number(n).toLocaleString('en-US'));
    const fmtPct = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);

    function trendClass(v) {
      if (v == null) return 'dsc-sub';
      return v > 0 ? 'dsc-up' : v < 0 ? 'dsc-down' : 'dsc-sub';
    }

    function field(label, value) {
      if (!value) return null;
      return h(
        'div',
        null,
        h('span', { className: 'dsc-label' }, label),
        h('p', { className: 'dsc-text' }, value),
      );
    }

    function Detail({ state }) {
      if (state.status === 'idle') return h('div', { className: 'dsc-empty' }, t('pick'));
      if (state.status === 'loading') return h('div', { className: 'dsc-empty' }, t('loading'));
      if (state.status === 'error') {
        return h('div', { className: 'dsc-empty' }, t('failed') + (state.error || ''));
      }
      const skill = state.skill || {};
      const row = state.row || {};
      const zh = skill.zh || {};
      const intro = zh.intro || skill.intro_zh || skill.description_en || '';
      const score = skill.score || {};
      return h(
        'div',
        { className: 'dsc-detail' },
        h('h3', null, `${skill.name_zh || zh.name_zh || skill.slug || state.id}`),
        h('div', { className: 'dsc-sub' }, `${row.verdict || ''}　${skill.id || ''}`),
        field(t('intro'), intro || t('noIntro')),
        field(t('usage'), zh.usage),
        field(t('notes'), zh.notes),
        field(t('installs'), fmtInt(skill.installs)),
        field(t('trend'), fmtPct(skill.trend_pct)),
        field(t('source'), skill.source),
        field(t('flags'), (skill.flags || []).join('、')),
        field(
          t('score'),
          score.S == null ? '' : `${Number(score.S).toFixed(3)}（H ${score.H} / T ${score.T} / C ${score.C} / A ${score.A}）`,
        ),
        field(t('id'), skill.id || row.id),
      );
    }

    function Panel() {
      const [list, setList] = useState({
        status: 'loading',
        rows: [],
        total: 0,
        matched: 0,
        version: null,
        active: [],
        maxActive: 0,
        error: '',
      });
      const [query, setQuery] = useState('');
      const [onlyZh, setOnlyZh] = useState(false);
      const [sortKey, setSortKey] = useState('S');
      const [detail, setDetail] = useState({ status: 'idle', id: '', skill: null, row: null });

      useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(async () => {
          try {
            const params = new URLSearchParams({ limit: String(RENDER_CAP), sort: 'S' });
            if (query.trim()) params.set('q', query.trim());
            if (onlyZh) params.set('zh', '1');
            const response = await fetch(`${API}/list?${params.toString()}`, {
              headers: { accept: 'application/json' },
            });
            const body = await response.json();
            if (cancelled) return;
            setList({
              status: 'ready',
              rows: Array.isArray(body.rows) ? body.rows : [],
              total: body.total || 0,
              matched: body.matched || 0,
              version: body.version || null,
              active: Array.isArray(body.active) ? body.active : [],
              maxActive: body.maxActive || 0,
              error: '',
            });
          } catch (error) {
            if (cancelled) return;
            setList((prev) => ({
              ...prev,
              status: 'error',
              error: String(error && error.message ? error.message : error),
            }));
          }
        }, 180);
        return () => {
          cancelled = true;
          clearTimeout(timer);
        };
      }, [query, onlyZh]);

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

      const rows = useMemo(() => {
        const copy = list.rows.slice();
        copy.sort((a, b) => {
          if (sortKey === 'name') {
            return String(a.name_zh || a.slug || '').localeCompare(String(b.name_zh || b.slug || ''), 'zh');
          }
          if (sortKey === 'installs') return (b.installs ?? -1) - (a.installs ?? -1);
          if (sortKey === 'trend') return (b.trend_pct ?? -1e9) - (a.trend_pct ?? -1e9);
          return (b.S ?? -1) - (a.S ?? -1);
        });
        return copy.slice(0, RENDER_CAP);
      }, [list.rows, sortKey]);

      const meta = [
        `${t('directory')} ${fmtInt(list.total)} ${t('items')}`,
        query.trim() || onlyZh ? `${t('matched')} ${fmtInt(list.matched)}` : '',
        `${t('version')} ${list.version || t('none')}`,
        `${t('active')} ${list.active.length}${list.maxActive ? `/${list.maxActive}` : ''}`,
      ]
        .filter(Boolean)
        .join(' · ');

      const header = (key, label, className) =>
        h(
          'th',
          { key, onClick: () => setSortKey(key), className: className || '' },
          label,
        );

      return h(
        'div',
        { className: 'dsc-root' },
        h('style', null, STYLE),
        h(
          'div',
          { className: 'dsc-head' },
          h('h2', { className: 'dsc-title' }, t('title')),
          h('span', { className: 'dsc-meta' }, meta),
        ),
        h(
          'div',
          { className: 'dsc-tools' },
          h('input', {
            className: 'dsc-input',
            type: 'search',
            value: query,
            placeholder: t('search'),
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
          }),
          h(
            'label',
            { className: 'dsc-check' },
            h('input', {
              type: 'checkbox',
              checked: onlyZh,
              onChange: (event) => setOnlyZh(event.target.checked),
            }),
            t('onlyZh'),
          ),
        ),
        h(
          'div',
          { className: 'dsc-body' },
          h(
            'div',
            { className: 'dsc-scroll' },
            h(
              'table',
              { className: 'dsc-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  header('name', t('colName')),
                  header('installs', t('colInstalls'), 'dsc-num'),
                  header('trend', t('colTrend'), 'dsc-num'),
                  header('S', t('colScore'), 'dsc-num'),
                  h('th', null, t('colVerdict')),
                ),
              ),
              h(
                'tbody',
                null,
                rows.length
                  ? rows.map((row) =>
                      h(
                        'tr',
                        {
                          key: row.id,
                          className: 'dsc-row',
                          'data-open': detail.id === row.id ? 'true' : 'false',
                          onClick: () => openDetail(row),
                        },
                        h(
                          'td',
                          null,
                          h('div', { className: 'dsc-name' }, row.name_zh || row.slug || row.id),
                          h('div', { className: 'dsc-sub' }, row.slug || row.id),
                        ),
                        h('td', { className: 'dsc-num' }, fmtInt(row.installs)),
                        h('td', { className: 'dsc-num ' + trendClass(row.trend_pct) }, fmtPct(row.trend_pct)),
                        h('td', { className: 'dsc-num' }, row.S == null ? '—' : Number(row.S).toFixed(3)),
                        h(
                          'td',
                          null,
                          h('div', { className: 'dsc-sub' }, row.verdict || ''),
                          (row.flags || []).map((flag) => h('span', { key: flag, className: 'dsc-flag' }, flag)),
                        ),
                      ),
                    )
                  : h(
                      'tr',
                      null,
                      h(
                        'td',
                        { colSpan: 5, className: 'dsc-empty' },
                        list.status === 'error'
                          ? t('failed') + list.error
                          : list.status === 'loading'
                            ? t('loading')
                            : t('empty'),
                      ),
                    ),
              ),
            ),
          ),
          h('div', { className: 'dsc-scroll' }, h(Detail, { state: detail })),
        ),
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
