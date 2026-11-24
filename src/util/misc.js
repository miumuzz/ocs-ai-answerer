/** 通用小工具：延时、随机、格式化等。 */

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms | 0)));

/** [min, max] 之间的随机整数 */
export function randInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

export function nowText(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

/** 带抖动与上限的指数退避 */
export function backoff(attempt, base = 800, cap = 15000) {
  const exp = Math.min(cap, base * Math.pow(2, Math.max(0, attempt - 1)));
  return Math.round(exp * (0.7 + Math.random() * 0.6));
}

/** 把可能很长的字符串截断，避免日志/提示词爆掉 */
export function truncate(str, max = 400, tail = '…') {
  const s = String(str ?? '');
  return s.length > max ? s.slice(0, max) + tail : s;
}

export function safeJsonParse(str, fallback = null) {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
}

/** 串行队列：保证同一时刻只有一个任务在跑（AI 请求默认串行，防止限流） */
export function createLimiter(concurrency = 1) {
  let active = 0;
  const queue = [];
  const next = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active--;
        next();
      });
  };
  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      next();
    });
}
