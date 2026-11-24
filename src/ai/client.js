/**
 * 大模型客户端：OpenAI 兼容的 /chat/completions。
 * 只依赖一个 baseUrl + apiKey + model，所以 DeepSeek / Kimi / 智谱 / 通义 / 硅基 / Ollama / 中转站都能用。
 */

import { request } from '../net/request.js';
import { backoff, sleep, truncate } from '../util/misc.js';
import { resolveChatUrl } from '../config.js';

export class ApiError extends Error {
  constructor(message, { status = 0, detail = '', retryable = false } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.retryable = retryable;
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

function friendlyStatus(status, detail) {
  if (status === 401 || status === 403) return `鉴权失败（${status}）：API Key 不对、没权限或已过期`;
  if (status === 404) return `接口不存在（404）：检查「接口地址」和「模型名」，或用「测试连接」确认`;
  if (status === 429) return `请求太频繁被限流（429）：把「请求间隔」调大，或换更便宜/额度更高的模型`;
  if (status >= 500) return `模型服务出错（${status}）：稍后重试或换服务商`;
  if (status === 400) return `请求参数被拒绝（400）：${truncate(detail, 200)}`;
  return `请求失败（${status}）：${truncate(detail, 200)}`;
}

export class AIClient {
  constructor(config, log = () => {}) {
    this.config = config;
    this.log = log;
  }

  get api() {
    return this.config.api;
  }

  headers() {
    const headers = { 'Content-Type': 'application/json' };
    const key = String(this.api.apiKey || '').trim();
    if (key) headers.Authorization = `Bearer ${key}`;
    if (this.api.extraHeaders) {
      try {
        const extra = JSON.parse(this.api.extraHeaders);
        for (const [k, v] of Object.entries(extra)) headers[k] = String(v);
      } catch {
        /* 用户填错就忽略，不阻塞答题 */
      }
    }
    return headers;
  }

  /**
   * @param {{role:'system'|'user'|'assistant', content:string}[]} messages
   * @param {{signal?:AbortSignal, retry?:number, maxTokens?:number, temperature?:number, jsonMode?:boolean}} opts
   * @returns {Promise<{content:string, usage:object, model:string, latency:number}>}
   */
  async chat(messages, { signal, retry = null, maxTokens = null, temperature = null, jsonMode = null } = {}) {
    const url = resolveChatUrl(this.api.baseUrl);
    if (!url) throw new ApiError('接口地址为空：请先在面板「设置」里填写');

    const body = {
      model: String(this.api.model || '').trim(),
      messages,
      temperature: temperature == null ? this.api.temperature : temperature,
      max_tokens: maxTokens == null ? this.api.maxTokens : maxTokens,
      stream: false,
    };
    let useJsonMode = jsonMode == null ? !!this.api.jsonMode : !!jsonMode;
    if (useJsonMode) body.response_format = { type: 'json_object' };
    let jsonModeDropped = false;

    const maxRetry = retry == null ? Math.max(0, this.api.retry ?? this.config.answer.retry ?? 0) : retry;
    let attempt = 0;
    let lastError = null;

    while (attempt <= maxRetry) {
      attempt++;
      const startedAt = Date.now();
      try {
        const res = await request({
          url,
          method: 'POST',
          headers: this.headers(),
          data: JSON.stringify(body),
          timeout: this.api.timeout,
          signal,
        });
        const latency = Date.now() - startedAt;

        if (res.status < 200 || res.status >= 300) {
          // 有些兼容接口/中转站不认 response_format，直接 400；自动去掉再试一次
          const mentionsJsonMode = /response_format|json_object|json mode/i.test(res.text || '');
          if (res.status === 400 && useJsonMode && mentionsJsonMode && !jsonModeDropped) {
            jsonModeDropped = true;
            useJsonMode = false;
            delete body.response_format;
            this.log && this.log('warn', '该接口不支持 JSON 模式，已自动关闭 response_format 重试');
            attempt--;
            continue;
          }
          const retryable = RETRYABLE_STATUS.has(res.status);
          const err = new ApiError(friendlyStatus(res.status, res.text), {
            status: res.status,
            detail: res.text,
            retryable,
          });
          if (retryable && attempt <= maxRetry) {
            lastError = err;
            await sleep(backoff(attempt));
            continue;
          }
          throw err;
        }

        let data;
        try {
          data = JSON.parse(res.text);
        } catch {
          throw new ApiError('返回内容不是 JSON：可能被登录页/网关拦截了，检查接口地址', { detail: res.text });
        }
        if (data.error) {
          throw new ApiError(`模型返回错误：${data.error.message || JSON.stringify(data.error)}`, { detail: res.text });
        }
        const choice = data.choices && data.choices[0];
        const content = choice && choice.message ? choice.message.content : '';
        if (!content) throw new ApiError('模型返回了空内容', { detail: res.text });
        return { content, usage: data.usage || {}, model: data.model || this.api.model, latency };
      } catch (err) {
        if (err instanceof ApiError && !err.retryable) throw err;
        if (err && (err.name === 'AbortError' || err.message === '请求被取消')) throw err;
        lastError = err;
        if (attempt > maxRetry) break;
        await sleep(backoff(attempt));
      }
    }

    if (lastError instanceof ApiError) throw lastError;
    const msg = lastError && lastError.message ? lastError.message : '未知错误';
    throw new ApiError(`调用大模型失败：${msg}`, { detail: String(lastError && lastError.body) });
  }

  /** 设置页的「测试连接」：发一个极小的请求，回报延迟与模型回显 */
  async test() {
    const startedAt = Date.now();
    const res = await this.chat(
      [
        { role: 'system', content: '你是连通性测试助手，回复两个字：可用' },
        { role: 'user', content: '测试' },
      ],
      // 这里刻意关掉 JSON 模式：部分服务商（如 DeepSeek）要求 JSON 模式的提示词里
      // 必须出现 "json" 字样，否则直接 400，会让「测试连接」误报失败。
      { retry: 0, maxTokens: 16, temperature: 0, jsonMode: false }
    );
    return { latency: Date.now() - startedAt, model: res.model, reply: truncate(res.content, 60) };
  }
}
