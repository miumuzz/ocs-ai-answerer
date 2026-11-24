/**
 * 题库层：本地答案缓存 + 可选的外部题库接口。
 *
 * 顺序永远是「缓存 → 外部题库 → AI」：
 * 同一道题第二次出现不再烧 token；外部题库能命中就用题库（更准）；
 * 都没有才让大模型现算。
 */

import { readJson, writeJson, removeKey } from './store.js';
import { request } from './net/request.js';
import { truncate } from './util/misc.js';

function pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

export class AnswerBank {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
  }

  get cacheLimit() {
    return Math.max(50, Number(this.config.bank.cacheLimit) || 3000);
  }

  loadAll() {
    return readJson('cache', {}) || {};
  }

  /** @returns {{answer:any, confidence:number|null, source:string, at:number}|null} */
  get(fingerprint) {
    if (!this.config.bank.cache) return null;
    const all = this.loadAll();
    const hit = all[fingerprint];
    if (!hit) return null;
    return { ...hit, source: hit.source || 'cache' };
  }

  put(fingerprint, entry) {
    if (!this.config.bank.cache) return;
    const all = this.loadAll();
    all[fingerprint] = { ...entry, at: Date.now() };
    const keys = Object.keys(all);
    if (keys.length > this.cacheLimit) {
      keys
        .sort((a, b) => (all[a].at || 0) - (all[b].at || 0))
        .slice(0, keys.length - this.cacheLimit)
        .forEach((k) => delete all[k]);
    }
    writeJson('cache', all);
  }

  clear() {
    removeKey('cache');
  }

  size() {
    return Object.keys(this.loadAll()).length;
  }

  /**
   * 查询外部题库（可选）。
   * 约定：POST JSON {question, type, options}，返回里包含 answer 字段即可；
   * 也兼容 {code, data:{answer}} / {data:"A"} 这类常见包装。
   */
  async queryRemote({ stem, type, options }) {
    const cfg = this.config.bank;
    if (!cfg.enabled || !cfg.url) return null;
    let headers = { 'Content-Type': 'application/json' };
    if (cfg.headers) {
      try {
        Object.assign(headers, JSON.parse(cfg.headers));
      } catch {
        this.log('warn', '题库请求头不是合法 JSON，已忽略');
      }
    }
    const payload = {
      question: stem,
      type,
      options: (options || []).map((o, i) => ({ label: o.label || String.fromCharCode(65 + i), text: o.text })),
    };

    try {
      const isGet = String(cfg.method || 'POST').toUpperCase() === 'GET';
      const url = isGet ? cfg.url + (cfg.url.includes('?') ? '&' : '?') + 'q=' + encodeURIComponent(stem) : cfg.url;
      const res = await request({
        url,
        method: isGet ? 'GET' : 'POST',
        headers,
        data: isGet ? undefined : JSON.stringify(payload),
        timeout: cfg.timeout,
      });
      if (res.status < 200 || res.status >= 300) throw new Error('HTTP ' + res.status);
      let data;
      try {
        data = JSON.parse(res.text);
      } catch {
        throw new Error('题库返回不是 JSON：' + truncate(res.text, 80));
      }
      const answer =
        pick(data, ['answer', '答案', 'result', 'data']) ??
        pick(data.data || {}, ['answer', '答案', 'result']);
      if (answer === undefined) return null;
      return { answer, source: '题库' };
    } catch (err) {
      this.log('warn', '题库查询失败：' + (err && err.message ? err.message : err));
      return null;
    }
  }
}
