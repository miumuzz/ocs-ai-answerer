/**
 * 存储层：优先 GM_setValue / GM_getValue（脚本猫、油猴都支持，跨站点共享），
 * 没有 GM 时退回 localStorage，保证在普通页面调试也能跑。
 */

const PREFIX = 'aicourse.';

function gmGet(key, def) {
  const g = globalThis;
  if (typeof g.GM_getValue === 'function') return g.GM_getValue(key, def);
  if (g.GM && typeof g.GM.getValue === 'function') return g.GM.getValue(key, def); // 旧版异步实现不兼容，返回 Promise 时由上层忽略
  return def;
}

function gmSet(key, value) {
  const g = globalThis;
  if (typeof g.GM_setValue === 'function') return g.GM_setValue(key, value);
  if (g.GM && typeof g.GM.setValue === 'function') return g.GM.setValue(key, value);
  return undefined;
}

function gmDelete(key) {
  const g = globalThis;
  if (typeof g.GM_deleteValue === 'function') return g.GM_deleteValue(key);
  if (g.GM && typeof g.GM.deleteValue === 'function') return g.GM.deleteValue(key);
  return undefined;
}

export function readJson(key, fallback) {
  const full = PREFIX + key;
  try {
    const raw = gmGet(full, null);
    if (raw === null || raw === undefined || raw === '') {
      const ls = localStorage.getItem(full);
      if (ls) return JSON.parse(ls);
      return fallback;
    }
    if (typeof raw === 'string') return JSON.parse(raw);
    return raw;
  } catch {
    return fallback;
  }
}

export function writeJson(key, value) {
  const full = PREFIX + key;
  const raw = JSON.stringify(value);
  try {
    gmSet(full, raw);
  } catch {
    /* ignore */
  }
  try {
    localStorage.setItem(full, raw);
  } catch {
    /* 隐私模式或容量满，忽略 */
  }
}

export function removeKey(key) {
  const full = PREFIX + key;
  try {
    gmDelete(full);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(full);
  } catch {
    /* ignore */
  }
}
