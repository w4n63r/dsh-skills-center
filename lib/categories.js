// 功能分类：skills.sh 不提供分类字段，这里用关键词把技能归到「它到底干什么」。
//
// 为什么是规则而不是模型：全量 7600 多条里只有几百条有描述（其余只有 slug/name），
// 送模型分类既贵又不稳；规则可复现、可单测、离线可跑，覆盖率还高。
//
// 两条经验（都是拿真实目录量出来的）：
//   1) 必须按「词边界」匹配，不能裸子串——`test` 会命中 latest/contest，`doc` 会命中 docker。
//   2) 词表里不许放泛词（skill / agent / api / review / model）。实测把 `skill` 放进 AI 分类后，
//      `find-skills` 被归成「AI 与模型」，纯噪声。
//
// 分类是多标签：一条技能可能既属于「前端与界面」又属于「测试与质量」，取分数最高的前 3 个；
// 一个都没命中才落到「其他」。

export const CATEGORIES = [
  { key: 'frontend', label: '前端与界面' },
  { key: 'design', label: '设计与图像' },
  { key: 'mobile', label: '移动端' },
  { key: 'backend', label: '后端与数据库' },
  { key: 'language', label: '语言与框架' },
  { key: 'data', label: '数据与分析' },
  { key: 'testing', label: '测试与质量' },
  { key: 'debug', label: '调试与排障' },
  { key: 'review', label: '代码评审与 Git' },
  { key: 'devops', label: '部署与运维' },
  { key: 'browser', label: '浏览器与自动化' },
  { key: 'security', label: '安全与合规' },
  { key: 'commerce', label: '电商与支付' },
  { key: 'docs', label: '文档与写作' },
  { key: 'office', label: '办公文档' },
  { key: 'media', label: '视频与音频' },
  { key: 'ai', label: 'AI 与模型' },
  { key: 'editor', label: '编辑器与插件' },
  { key: 'collab', label: '协作与沟通' },
  { key: 'product', label: '产品与项目' },
  { key: 'research', label: '研究与调研' },
  { key: 'finance', label: '财务与交易' },
  { key: 'support', label: '销售与客服' },
  { key: 'legal', label: '法务与合同' },
  { key: 'graphics', label: '游戏与图形' },
  { key: 'gpu', label: 'GPU 与加速计算' },
  { key: 'science', label: '科学与工程' },
  { key: 'marketing', label: '内容与营销' },
  { key: 'other', label: '其他' },
];

export const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map((c) => [c.key, c.label]));

/** key → 关键词。按词边界匹配，所以这里写的是词，不是子串。 */
const KEYWORDS = {
  frontend: ['react', 'nextjs', 'next.js', 'vue', 'nuxt', 'svelte', 'astro', 'tailwind', 'css', 'scss', 'html', 'frontend', 'front-end', 'shadcn', 'component', 'jsx', 'tsx', 'view transitions', 'responsive', 'web app', 'remix', 'solid'],
  design: ['design', 'figma', 'svg', 'icon', 'logo', 'illustration', 'typography', 'palette', 'brand', 'imagegen', 'image generation', 'image-to-code', 'ui', 'ux', 'visual', 'p5.js', 'algorithmic art', 'poster', 'layout'],
  mobile: ['ios', 'android', 'react native', 'react-native', 'swiftui', 'swift', 'flutter', 'expo', 'kotlin', 'mobile', 'widgetkit'],
  backend: ['postgres', 'postgresql', 'mysql', 'sqlite', 'sql', 'prisma', 'drizzle', 'supabase', 'redis', 'mongodb', 'database', 'backend', 'graphql', 'orm', 'migration', 'server action', 'fastapi', 'express', 'nestjs', 'django', 'rails', 'laravel', 'api endpoint', 'rest api', 'queue', 'cron job'],
  language: ['dotnet', '.net', 'c#', 'csharp', 'java', 'spring boot', 'springboot', 'kotlin', 'golang', 'go module', 'rust', 'cargo', 'python', 'ruby', 'php', 'ef core', 'entity framework', 'asp.net', 'gradle', 'maven', 'typescript', 'node.js', 'deno'],
  data: ['data analysis', 'dataset', 'analytics', 'csv', 'pandas', 'dataframe', 'chart', 'dashboard', 'etl', 'warehouse', 'bigquery', 'statistic', 'visualization', 'clickhouse', 'duckdb', 'explore data', 'profiling', 'metric', 'posthog', 'amplitude', 'mixpanel', 'metabase'],
  testing: ['test', 'tests', 'testing', 'tdd', 'vitest', 'jest', 'playwright', 'cypress', 'e2e', 'unit test', 'coverage', 'eslint', 'snapshot', 'regression', 'qa'],
  debug: ['debug', 'debugging', 'troubleshoot', 'root cause', 'stack trace', 'incident', 'sentry', 'logging', 'diagnos', 'crash', 'bug'],
  review: ['code review', 'reviewer', 'pull request', 'merge conflict', 'refactor', 'codebase', 'changelog', 'git', 'commit', 'branch', 'diff'],
  devops: ['deploy', 'deployment', 'docker', 'kubernetes', 'k8s', 'terraform', 'ci/cd', 'github action', 'vercel', 'aws', 'azure', 'gcp', 'cloudflare', 'infrastructure', 'serverless', 'monitoring', 'observability', 'linux', 'powershell', 'bash', 'shell', 'helm', 'pipeline'],
  browser: ['browser', 'scrape', 'scraping', 'crawl', 'puppeteer', 'chrome devtools', 'web automation', 'selenium', 'cdp', 'page automation', 'http request', 'curl', 'firecrawl', 'apify'],
  security: ['security', 'vulnerab', 'auth', 'oauth', 'authentication', 'authorization', 'secret', 'credential', 'compliance', 'rbac', 'permission', 'encryption', 'privacy', 'threat', 'clerk', 'sso', 'zero trust', 'sandbox'],
  commerce: ['stripe', 'shopify', 'payment', 'checkout', 'subscription', 'billing', 'invoice', 'ecommerce', 'e-commerce', 'paypal', 'square', 'polaris'],
  docs: ['documentation', 'docs', 'readme', 'markdown', 'writing', 'blog', 'technical writing', 'handoff', 'note', 'spec', 'prd', 'manuscript', 'copy edit'],
  office: ['docx', 'xlsx', 'pptx', 'excel', 'word', 'powerpoint', 'pdf', 'slides', 'spreadsheet', 'office', 'deck', 'notion', 'airtable'],
  media: ['video', 'audio', 'speech', 'voice', 'tts', 'music', 'subtitle', 'caption', 'animation', 'remotion', 'ffmpeg', 'transcri', 'podcast', 'lip sync', 'motion'],
  ai: ['llm', 'prompt', 'gpt', 'claude', 'openai', 'anthropic', 'huggingface', 'langchain', 'llamaindex', 'deepseek', 'gemini', 'embedding', 'rag', 'fine-tune', 'inference', 'mcp', 'model context protocol', 'subagent', 'context window', 'copilot', 'assistant'],
  editor: ['vscode', 'vs code', 'extension', 'jetbrains', 'neovim', 'editorconfig', 'cursor', 'ide', 'syntax highlight', 'language server'],
  collab: ['slack', 'teams', 'zoom', 'googleworkspace', 'google workspace', 'meeting', 'calendar', 'standup', 'briefing', 'email', 'gmail', 'outlook', 'm365', 'notion', 'confluence', 'jira', 'messaging', 'call summary', 'transcript', 'inbox', 'schedule', 'chat sdk', 'webhook'],
  product: ['roadmap', 'prd', 'product manager', 'backlog', 'sprint', 'user story', 'persona', 'okr', 'requirement', 'feature spec', 'feedback', 'interview', 'onboarding', 'process', 'workflow', 'project plan', 'estimation'],
  research: ['research', 'synthesize', 'literature', 'arxiv', 'paper', 'citation', 'survey', 'competitive', 'deep research', 'fact check', 'insight', 'analysis report', 'web search'],
  finance: ['finance', 'financial', 'trade', 'trading', 'swap', 'portfolio', 'invoice', 'accounting', 'month-end', 'budget', 'forecast', 'payroll', 'expense', 'tax', 'revenue', 'usdc', 'crypto', 'wallet', 'ledger', 'quickbooks', 'xero', 'audit trail'],
  support: ['support', 'ticket', 'helpdesk', 'zendesk', 'customer', 'crm', 'salesforce', 'hubspot', 'knowledge base', 'churn', 'renewal', 'deal', 'service request'],
  legal: ['legal', 'contract', 'nda', 'lawyer', 'clause', 'terms of service', 'trademark', 'patent', 'litigation', 'regulatory'],
  graphics: ['game', 'unity', 'unreal', 'godot', 'shader', '3d', 'blender', 'render pipeline', 'multiplayer', 'sprite', 'voxel', 'gpu', 'mesh', 'texture'],
  gpu: ['nvidia', 'cuda', 'tensorrt', 'deepstream', 'omniverse', 'nemotron', 'nemo', 'gpu', 'hpc', 'cuopt', 'cudf', 'cudaq', 'accelerated computing'],
  science: ['simulation', 'physics', 'chemistry', 'biolog', 'genome', 'protein', 'molecul', 'climate', 'numpy', 'scipy', 'matlab', 'finite element', 'engineering model', 'scientific'],
  marketing: ['seo', 'marketing', 'social media', 'twitter', 'newsletter', 'campaign', 'copywriting', 'ads', 'content strategy', 'growth', 'outreach', 'lead', 'reddit'],
};

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 连字符/下划线/斜杠都当分隔符：slug 里的 `code-review-checklist` 要能命中词表里的 "code review"。 */
const normalize = (text) => String(text).toLowerCase().replace(/[-_/]+/g, ' ');

/**
 * 预编译成「带词边界」的正则；`ci/cd`、`c#`、`.net` 这类带符号的词也能安全匹配。
 * 每条同时留着小写原词：先用 `includes` 做一次廉价过滤，只有子串命中才跑正则——
 * 7600 条 × 380 个词的实测里，绝大多数词第一道就被筛掉了。
 */
const MATCHERS = Object.fromEntries(
  Object.entries(KEYWORDS).map(([key, words]) => [
    key,
    words.map((word) => {
      const normalized = normalize(word);
      return {
        word: normalized,
        pattern: new RegExp(`(?:^|[^a-z0-9])${escapeRe(normalized)}(?:[^a-z0-9]|$)`),
      };
    }),
  ]),
);

/** 字段权重：slug/name 比描述可靠；source 是 owner/repo，正文为空时靠它兜底；描述最弱。 */
// 短字段：一次匹配就很便宜，先看它们。
const SHORT_FIELDS = [
  [(s) => s.slug, 3],
  [(s) => s.name, 3],
  // source（owner/repo）是强线索：`anthropics/claude-for-legal/*` 这种正文为空也能靠 owner 归类
  [(s) => s.source, 2],
  [(s) => s.name_zh, 2],
];

// 长文本：只有短字段一个都没命中才读，且截断——开头几句就足以判断这个技能干什么。
const LONG_TEXT_CAP = 600;
const LONG_FIELDS = [
  [(s) => s.zh?.intro, 1],
  [(s) => s.description_en, 1],
];

/**
 * 给一条技能打分类标签。
 * @returns {string[]} 按分数降序、最多 3 个；一个都没命中返回 ['other']
 */
export function classify(skill, { max = 3 } = {}) {
  if (!skill) return ['other'];
  const pick = (spec, cap) =>
    spec
      .map(([get, weight]) => ({ text: normalize(get(skill) ?? '').slice(0, cap), weight }))
      .filter((entry) => entry.text);

  const score = (fields) => {
    const scores = new Map();
    if (!fields.length) return scores;
    for (const [key, patterns] of Object.entries(MATCHERS)) {
      let value = 0;
      for (const { word, pattern } of patterns) {
        for (const { text, weight } of fields) {
          if (!text.includes(word)) continue; // 第一道：廉价子串
          if (pattern.test(text)) {
            value += weight;
            break; // 同一个关键词在一条技能里只算一次
          }
        }
      }
      if (value > 0) scores.set(key, value);
    }
    return scores;
  };

  // 先短字段；一个分类都没命中才去读长文本（这是兜底路径，慢一点没关系）
  let scores = score(pick(SHORT_FIELDS, 200));
  if (!scores.size) scores = score(pick(LONG_FIELDS, LONG_TEXT_CAP));
  if (!scores.size) return ['other'];
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([key]) => key);
}

/** 预热用：把整份目录分类一遍并丢掉结果，只为让后面的查询命中缓存。 */
export function warmCategories(skills) {
  for (const skill of skills || []) classify(skill);
}

/** 全目录每个分类各有多少条（一条技能算进它的每个分类，所以总和会大于条数）。 */
export function categoryCounts(skills) {
  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.key, 0]));
  let classified = 0;
  for (const skill of skills || []) {
    const cats = skill.categories || classify(skill);
    if (!(cats.length === 1 && cats[0] === 'other')) classified += 1;
    for (const key of cats) {
      if (counts[key] != null) counts[key] += 1;
    }
  }
  return { counts, classified, total: (skills || []).length };
}
