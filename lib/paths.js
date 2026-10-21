// 路径与本地状态：所有落盘位置集中在这里，方便卸载与迁移。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（lib/ 的上一级）。 */
export const PACKAGE_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** DSH 主目录；测试时可覆盖。 */
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh');

/** 本插件的私有目录。 */
export const CENTER_HOME = join(DSH_HOME, 'skills-center');

/** 已下载技能的库存（只占磁盘，不进任何 skills 根）。 */
export const LIBRARY_DIR = join(CENTER_HOME, 'library');

/** 激活集合的落盘文件。 */
export const ACTIVATION_FILE = join(CENTER_HOME, 'activation.json');

/**
 * 正文缓存：目录里只有 body.sha256 与顶层 body_base，正文按内容寻址（<sha256>.md）。
 * 同一份正文永远同一个文件名，所以缓存不需要失效逻辑。
 */
export const BODY_CACHE_DIR = join(CENTER_HOME, 'bodies');

/** 全量目录：优先用 DSH_HOME 里同步下来的，退回包内样例数据。 */
export const CATALOG_CANDIDATES = [
  join(CENTER_HOME, 'catalog', 'catalog.json'),
  join(PACKAGE_ROOT, 'data', 'catalog.json'),
];

/** 激活上限：每个激活技能的 name+description 都会进系统提示，必须封顶。 */
export const MAX_ACTIVE = 50;
