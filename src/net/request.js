/**
 * 网络层：优先走 GM_xmlhttpRequest（跨域不受 CORS 限制），
 * 拿不到 GM API 时退回 fetch。所有请求都带超时与可读的错误信息。
 */

export class NetError extends Error {
  constructor(message, { status = 0, body = '', cause = null, timeout = false } = {}) {
    super(message);
    this.name = 'NetError';
    this.status = status;
    this.body = body;
    this.cause = cause;
    this.timeout = timeout;
  }
}

function gmRequestFn() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (typeof g.GM_xmlhttpRequest === 'function') return g.GM_xmlhttpRequest.bind(g);
  if (g.GM && typeof g.GM.xmlHttpRequest === 'function') return g.GM.xmlHttpRequest.bind(g.GM);
  return null;
}

function parseHeaders(raw) {
  const out = {};
  if (!raw) return out;
  for (const line of String(raw).split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx > 0) out[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return out;
}

/**
 * @param {{url:string, method?:string, headers?:Record<string,string>, data?:string,
 *          timeout?:number, signal?:AbortSignal}} opts
 * @returns {Promise<{status:number, headers:Record<string,string>, text:string}>}
 */
export function request(opts) {
  const { url, method = 'GET', headers = {}, data, timeout = 60000, signal } = opts;
  const gm = gmRequestFn();

  if (gm) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        fn(value);
      };
      let handle = null;
      try {
        handle = gm({
          url,
          method,
          headers,
          data,
          timeout,
          responseType: 'text',
          onload: (res) =>
            finish(resolve, { status: res.status, headers: parseHeaders(res.responseHeaders), text: res.responseText ?? '' }),
          onerror: (res) => finish(reject, new NetError('网络错误（请求未能发出或连接被重置）', { cause: res })),
          ontimeout: () => finish(reject, new NetError(`请求超时（${timeout}ms）`, { timeout: true })),
          onabort: () => finish(reject, new NetError('请求被取消', { cause: 'abort' })),
        });
      } catch (err) {
        finish(reject, new NetError('GM 请求调用失败：' + (err && err.message ? err.message : err), { cause: err }));
        return;
      }
      if (signal) {
        if (signal.aborted) {
          try {
            handle && handle.abort && handle.abort();
          } catch {
            /* ignore */
          }
          finish(reject, new NetError('请求被取消', { cause: 'abort' }));
          return;
        }
        signal.addEventListener('abort', () => {
          try {
            handle && handle.abort && handle.abort();
          } catch {
            /* ignore */
          }
          finish(reject, new NetError('请求被取消', { cause: 'abort' }));
        });
      }
    });
  }

  // 没有 GM API：退回 fetch（可能被 CORS 拦截）
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  if (signal) signal.addEventListener('abort', () => controller.abort());
  return fetch(url, { method, headers, body: data, signal: controller.signal })
    .then(async (res) => ({ status: res.status, headers: parseHeaders([...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n')), text: await res.text() }))
    .catch((err) => {
      if (err && err.name === 'AbortError') throw new NetError(`请求超时（${timeout}ms）`, { timeout: true });
      throw new NetError('fetch 失败（脚本猫里通常是缺少 GM_xmlhttpRequest 的 @grant，或被 CORS 拦截）', { cause: err });
    })
    .finally(() => clearTimeout(timer));
}

export const hasGMRequest = () => !!gmRequestFn();
