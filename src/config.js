/** 配置：默认值、服务商预设、读写与校验。 */

import { readJson, writeJson, removeKey } from './store.js';

export const PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  moonshot: { label: 'Moonshot / Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { label: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  dashscope: { label: '阿里通义（兼容模式）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  siliconflow: { label: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  ollama: { label: '本地 Ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
  custom: { label: '自定义（OpenAI 兼容）', baseUrl: '', model: '' },
};

export const DEFAULT_CONFIG = {
  provider: 'deepseek',
  /** auto | chaoxing | generic */
  adapter: 'auto',
  api: {
    baseUrl: PROVIDERS.deepseek.baseUrl,
    apiKey: '',
    model: PROVIDERS.deepseek.model,
    temperature: 0.2,
    maxTokens: 1024,
    timeout: 60000,
    jsonMode: true,
    /** 额外请求头，形如 {"X-Foo":"bar"}，部分中转站需要 */
    extraHeaders: '',
  },
  answer: {
    autoStart: false,
    autoNext: true,
    autoSubmit: false,
    /** 每题之间的随机等待（毫秒） */
    requestInterval: [500, 1200],
    /** 答题后等待页面反应的时间（毫秒） */
    questionDelay: [900, 1800],
    retry: 2,
    /** 低于该置信度视为「没把握」 */
    confidence: 0.35,
    /** 没把握时仍然作答（false = 跳过，留给人工） */
    guessWhenUnsure: true,
    concurrency: 1,
    /** 单次运行最多答多少题，0 = 不限制 */
    maxAnswerPerRun: 0,
    /** 页面上没有可答题时最多等多久（毫秒）再收工 */
    idleTimeoutMs: 60000,
    /** 只识别不点击，用于先观察 */
    dryRun: false,
  },
  bank: {
    enabled: false,
    url: '',
    method: 'POST',
    headers: '',
    timeout: 8000,
    /** 本地答案缓存（同一道题只问一次 AI） */
    cache: true,
    cacheLimit: 3000,
  },
  ui: {
    left: null,
    top: null,
    minimized: false,
    logLimit: 80,
  },
  debug: false,
};

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function mergeDeep(base, patch) {
  const out = Array.isArray(base) ? [...base] : { ...base };
  if (!isPlainObject(patch)) return out;
  for (const [k, v] of Object.entries(patch)) {
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = mergeDeep(out[k], v);
    else if (v !== undefined) out[k] = v;
  }
  return out;
}

let cached = null;

export function loadConfig() {
  if (cached) return cached;
  const saved = readJson('config', null);
  cached = mergeDeep(DEFAULT_CONFIG, saved || {});
  return cached;
}

export function getConfig() {
  return loadConfig();
}

export function saveConfig(config) {
  cached = mergeDeep(DEFAULT_CONFIG, config);
  writeJson('config', cached);
  return cached;
}

export function patchConfig(patch) {
  return saveConfig(mergeDeep(loadConfig(), patch));
}

export function resetConfig() {
  removeKey('config');
  cached = mergeDeep(DEFAULT_CONFIG, {});
  return cached;
}

export function applyProvider(name, config) {
  const preset = PROVIDERS[name];
  if (!preset) return config;
  const next = mergeDeep(config, {
    provider: name,
    api: { baseUrl: preset.baseUrl, model: preset.model },
  });
  return saveConfig(next);
}

/** 返回人类可读的问题列表；为空表示可以开跑 */
export function validateConfig(config = loadConfig()) {
  const problems = [];
  const { api } = config;
  if (!api.baseUrl || !/^https?:\/\//i.test(api.baseUrl)) problems.push('接口地址必须以 http(s):// 开头');
  if (!api.model) problems.push('没有填写模型名（例如 deepseek-chat）');
  if (!api.apiKey && !/127\.0\.0\.1|localhost/i.test(api.baseUrl || '')) problems.push('没有填写 API Key');
  if (!(config.answer.confidence >= 0 && config.answer.confidence <= 1)) problems.push('置信度阈值应在 0~1 之间');
  return problems;
}

/** 拼接最终的 chat/completions 地址 */
export function resolveChatUrl(baseUrl) {
  const url = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!url) return '';
  if (/\/chat\/completions$/i.test(url)) return url;
  // 已经带版本号（/v1、/v4、/compatible-mode/v1 …）就直接拼，否则补 /v1
  if (/\/v\d+$/i.test(url)) return url + '/chat/completions';
  return url + '/v1/chat/completions';
}
