#!/usr/bin/env node
/**
 * OCS AI 题库 · 本地服务
 *
 * 为什么是它：OCS 的题库请求走的是它自己沙箱里的 fetch，用户脚本没法稳定替换，
 * 所以干脆不在浏览器里拦截 —— 起一个只监听 127.0.0.1 的小 HTTP 服务，
 * 让 OCS 直接把题发过来，服务端调用你的大模型，再把答案按 OCS 的格式还回去。
 *
 * 用法：
 *   node server/ocs-ai-server.mjs
 *   然后浏览器打开 http://127.0.0.1:8787/  填 API
 *
 * 协议（和 OCS 的 answer-wrapper 对齐）：
 *   POST /answer  { title, options, type }  →  { question, answer }
 *   answer 是「选项原文」/判断题「对、错」/填空题多空用 === 连接
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { AiAnswerer } from '../src/answerer.js';
import { DEFAULT_CONFIG, mergeDeep, PROVIDERS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(HERE, 'config.json');

const DEFAULT_SETTINGS = {
  baseUrl: PROVIDERS.deepseek.baseUrl,
  apiKey: '',
  model: PROVIDERS.deepseek.model,
  subject: '',
  temperature: 0.2,
  maxTokens: 1024,
  timeout: 25000,
  port: 8787,
};

/* ------------------------------------------------------------------ */
/* 配置读写                                                            */
/* ------------------------------------------------------------------ */

function readSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...patch };
  // 端口不写进文件，避免用户改了文件却和启动参数打架
  const { port, ...persisted } = next;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(persisted, null, 2), 'utf8');
  return next;
}

/** 把服务端设置转成答题内核认识的 config 形状 */
function toAiConfig(settings) {
  return mergeDeep(DEFAULT_CONFIG, {
    api: {
      baseUrl: settings.baseUrl,
      apiKey: settings.apiKey,
      model: settings.model,
      temperature: Number(settings.temperature) || 0.2,
      maxTokens: Number(settings.maxTokens) || 1024,
      timeout: Number(settings.timeout) || 25000,
      jsonMode: true,
    },
    subject: settings.subject || '',
    bank: { cache: true, cacheLimit: 500, enabled: false, url: '' },
    answer: { retry: 0 },
  });
}

/** 进程内缓存：同一道题不重复烧 token（OCS 重试/重开题时很有用） */
function makeMemoryBank(limit = 500) {
  const map = new Map();
  return {
    get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      return { ...hit };
    },
    put(key, value) {
      map.set(key, { ...value, at: Date.now() });
      if (map.size > limit) {
        const oldest = [...map.entries()].sort((a, b) => (a[1].at || 0) - (b[1].at || 0))[0];
        if (oldest) map.delete(oldest[0]);
      }
    },
    clear() {
      map.clear();
    },
    size() {
      return map.size;
    },
    async queryRemote() {
      return null;
    },
  };
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  // Chrome 的 Private Network Access：公网页面请求 127.0.0.1 需要这个响应头
  'Access-Control-Allow-Private-Network': 'true',
  'Access-Control-Max-Age': '86400',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    ...CORS_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function sendHtml(res, html) {
  res.writeHead(200, { ...CORS_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体太大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function nowText() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

/* ------------------------------------------------------------------ */
/* 页面                                                                */
/* ------------------------------------------------------------------ */

function settingsPage(settings) {
  const providers = Object.entries(PROVIDERS)
    .map(([k, v]) => `<option value="${k}" data-base="${v.baseUrl}" data-model="${v.model}">${v.label}</option>`)
    .join('');
  const configured = !!settings.apiKey;
  return `<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OCS AI 题库 · 本地服务</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #14161b; color: #e8ebf0; font: 14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif; }
  .wrap { max-width: 680px; margin: 0 auto; padding: 32px 20px 60px; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .sub { color: #98a2b3; margin-bottom: 22px; font-size: 13px; }
  .card { background: #1b1f27; border: 1px solid #2b323d; border-radius: 12px; padding: 18px; margin-bottom: 16px; }
  label { display: block; color: #98a2b3; font-size: 12px; margin: 12px 0 4px; }
  input, select { width: 100%; background: #10131a; color: #e8ebf0; border: 1px solid #2b323d; border-radius: 8px; padding: 8px 10px; font: inherit; }
  input:focus, select:focus { outline: none; border-color: #4f8cff; }
  .row { display: flex; gap: 10px; }
  .row > div { flex: 1; }
  button { border: 1px solid #2b323d; background: #232a35; color: #e8ebf0; border-radius: 8px; padding: 9px 14px; font: inherit; cursor: pointer; }
  button:hover { background: #2b3441; }
  button.primary { background: #4f8cff; border-color: #4f8cff; color: #fff; font-weight: 600; }
  button.primary:hover { filter: brightness(1.08); }
  .actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  .status { margin-top: 14px; font-size: 13px; min-height: 20px; }
  .ok { color: #3ddc84; } .err { color: #ff6b6b; } .warn { color: #ffb020; }
  pre { background: #0e1014; border: 1px solid #2b323d; border-radius: 8px; padding: 12px; overflow: auto; font-size: 12px; line-height: 1.5; max-height: 260px; }
  .hint { color: #98a2b3; font-size: 12px; }
  code { background: #0e1014; padding: 1px 5px; border-radius: 4px; }
</style></head>
<body><div class="wrap">
  <h1>OCS AI 题库 · 本地服务</h1>
  <div class="sub">${configured ? '✅ 已配置 API，把下面的题库配置粘进 OCS 即可' : '⚠️ 还没配置 API Key'}</div>

  <div class="card">
    <label>服务商（只是预设，切换会覆盖下面的地址和模型）</label>
    <select id="provider">${providers}</select>
    <label>接口地址（OpenAI 兼容 base URL）</label>
    <input id="baseUrl" value="${escapeAttr(settings.baseUrl)}" placeholder="https://api.deepseek.com/v1">
    <label>API Key</label>
    <input id="apiKey" type="password" value="${escapeAttr(settings.apiKey)}" placeholder="sk-...">
    <label>模型</label>
    <input id="model" value="${escapeAttr(settings.model)}" placeholder="deepseek-chat">
    <label>科目提示（可留空，填了更准）</label>
    <input id="subject" value="${escapeAttr(settings.subject)}" placeholder="例如：马克思主义基本原理">
    <div class="row">
      <div><label>temperature</label><input id="temperature" type="number" step="0.1" min="0" max="2" value="${settings.temperature}"></div>
      <div><label>max_tokens</label><input id="maxTokens" type="number" step="64" min="64" value="${settings.maxTokens}"></div>
    </div>
    <div class="actions">
      <button class="primary" id="save">保存</button>
      <button id="test">测试连接</button>
      <button id="copy">复制 OCS 题库配置</button>
    </div>
    <div class="status" id="status"></div>
  </div>

  <div class="card">
    <label style="margin-top:0">粘到 OCS →「通用 → 全局设置 → 题库配置」里</label>
    <pre id="json"></pre>
    <div class="hint">如果 OCS 弹「域名不在白名单」的警告，点确定忽略即可（本地服务不走 GM 请求）。</div>
  </div>

  <div class="card">
    <div class="hint">
      服务只监听 <code>127.0.0.1</code>，局域网/外网都访问不到；Key 只存在本机的
      <code>server/config.json</code>。关掉这个命令行窗口服务就停了。
    </div>
  </div>
</div>
<script>
const $ = (id) => document.getElementById(id);
const statusEl = $('status');

const WRAPPER = ${JSON.stringify(
    (() => {
      const w = buildWrapperTemplate(0);
      delete w.url;
      delete w.homepage;
      return w;
    })()
  )};

function wrapperJson() {
  const w = JSON.parse(JSON.stringify(WRAPPER));
  w.url = location.origin + '/answer';
  w.homepage = location.origin + '/';
  $('json').textContent = JSON.stringify([w], null, 2);
  return w;
}
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}
function current() {
  return {
    baseUrl: $('baseUrl').value.trim(),
    apiKey: $('apiKey').value.trim(),
    model: $('model').value.trim(),
    subject: $('subject').value.trim(),
    temperature: Number($('temperature').value) || 0.2,
    maxTokens: Number($('maxTokens').value) || 1024,
  };
}
$('provider').addEventListener('change', (e) => {
  const opt = e.target.selectedOptions[0];
  $('baseUrl').value = opt.dataset.base;
  $('model').value = opt.dataset.model;
});
$('save').addEventListener('click', async () => {
  const res = await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current()) });
  const data = await res.json();
  if (data.ok) setStatus('已保存', 'ok');
  else setStatus('保存失败：' + (data.error || ''), 'err');
});
$('test').addEventListener('click', async () => {
  setStatus('测试中…', '');
  await fetch('/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(current()) });
  const res = await fetch('/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  const data = await res.json();
  if (data.ok) setStatus('连接成功 · ' + data.latency + 'ms · ' + data.model, 'ok');
  else setStatus('连接失败：' + (data.error || '未知错误'), 'err');
});
$('copy').addEventListener('click', async () => {
  const text = JSON.stringify([wrapperJson()], null, 2);
  try { await navigator.clipboard.writeText(text); setStatus('已复制', 'ok'); }
  catch { setStatus('复制失败，请手动选中下面的 JSON 复制', 'warn'); }
});
wrapperJson();
</script>
</body></html>`;
}

function escapeAttr(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/** 给页面展示、给用户复制的那段 OCS 题库配置 */
export function buildWrapperTemplate(port = 8787) {
  return {
    name: 'AI 答题（本地服务）',
    homepage: `http://127.0.0.1:${port}/`,
    url: `http://127.0.0.1:${port}/answer`,
    method: 'post',
    type: 'fetch',
    responseType: 'json',
    headers: { 'Content-Type': 'application/json' },
    data: { title: '${title}', options: '${options}', type: '${type}' },
    handler: 'return (res) => (res && res.answer ? [res.question, res.answer] : undefined)',
  };
}

/* ------------------------------------------------------------------ */
/* 服务器                                                              */
/* ------------------------------------------------------------------ */

export function createServer({ settingsProvider = readSettings, settingsWriter = writeSettings, answererFactory = null, logger = console } = {}) {
  let cached = null;
  let cachedKey = '';

  function getAnswerer() {
    const settings = settingsProvider();
    const key = `${settings.baseUrl}|${settings.apiKey}|${settings.model}|${settings.temperature}|${settings.maxTokens}`;
    if (!cached || key !== cachedKey) {
      const config = toAiConfig(settings);
      cached = answererFactory ? answererFactory(config) : new AiAnswerer({ config, bank: makeMemoryBank() });
      cachedKey = key;
    }
    return { answerer: cached, settings };
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    try {
      if (req.method === 'GET' && route === '/') {
        sendHtml(res, settingsPage(settingsProvider()));
        return;
      }

      if (req.method === 'GET' && route === '/health') {
        const s = settingsProvider();
        sendJson(res, 200, { ok: true, configured: !!s.apiKey, model: s.model, baseUrl: s.baseUrl });
        return;
      }

      if (req.method === 'GET' && route === '/wrapper.json') {
        const host = req.headers.host || `127.0.0.1:${settingsProvider().port || 8787}`;
        const port = Number(String(host).split(':')[1]) || 8787;
        sendJson(res, 200, [buildWrapperTemplate(port)]);
        return;
      }

      if (req.method === 'POST' && route === '/config') {
        const body = await readBody(req);
        const next = settingsWriter({
          baseUrl: String(body.baseUrl || '').trim(),
          apiKey: String(body.apiKey || '').trim(),
          model: String(body.model || '').trim(),
          subject: String(body.subject || '').trim(),
          temperature: Number(body.temperature) || 0.2,
          maxTokens: Number(body.maxTokens) || 1024,
        });
        cached = null;
        logger.log(`[${nowText()}] 配置已更新：${next.model} @ ${next.baseUrl}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (req.method === 'POST' && route === '/test') {
        const { answerer, settings } = getAnswerer();
        if (!settings.apiKey) {
          sendJson(res, 200, { ok: false, error: '还没填 API Key' });
          return;
        }
        try {
          const r = await answerer.ai.test();
          logger.log(`[${nowText()}] 测试连接成功 ${r.latency}ms · ${r.model}`);
          sendJson(res, 200, { ok: true, latency: r.latency, model: r.model, reply: r.reply });
        } catch (err) {
          logger.log(`[${nowText()}] 测试连接失败：${err.message}`);
          sendJson(res, 200, { ok: false, error: err.message + (err.detail ? ' · ' + String(err.detail).slice(0, 200) : '') });
        }
        return;
      }

      if (req.method === 'POST' && route === '/answer') {
        const body = await readBody(req);
        const { answerer, settings } = getAnswerer();
        if (!settings.apiKey) {
          logger.log(`[${nowText()}] 拒绝作答：没有配置 API Key`);
          sendJson(res, 200, {});
          return;
        }
        if (!/^https?:\/\//i.test(settings.baseUrl || '') || !settings.model) {
          logger.log(`[${nowText()}] 配置不完整：检查接口地址与模型名`);
          sendJson(res, 200, {});
          return;
        }
        const startedAt = Date.now();
        const result = await answerer.answer(body);
        const cost = Date.now() - startedAt;
        if (result.error) {
          logger.log(`[${nowText()}] ✗ ${String(body.title || '').slice(0, 28)} · ${result.error}`);
          sendJson(res, 200, {});
          return;
        }
        logger.log(
          `[${nowText()}] ✓ ${String(body.title || '').slice(0, 28)} → ${String(result.answer).slice(0, 40)} (${cost}ms)`
        );
        sendJson(res, 200, { question: result.question, answer: result.answer });
        return;
      }

      sendJson(res, 404, { error: 'not found' });
    } catch (err) {
      logger.error(`[${nowText()}] 处理请求出错：`, err.message);
      sendJson(res, 400, { error: err.message });
    }
  });

  return server;
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

function openBrowser(url) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore', detached: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    }
  } catch {
    /* 打不开就让用户手动点 */
  }
}

function main() {
  const logger = console;
  const args = process.argv.slice(2);
  const major = Number(String(process.versions.node).split('.')[0]);
  if (major < 18) {
    logger.error(`\n  当前 Node.js 版本是 ${process.versions.node}，太旧了。`);
    logger.error('  请到 https://nodejs.org/ 安装 LTS 版本（18 以上）后重试。\n');
    process.exit(1);
  }
  const portArg = args.find((a) => a.startsWith('--port='));
  const settings = readSettings();
  const port = Number(portArg ? portArg.split('=')[1] : settings.port || 8787);

  const server = createServer();

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`\n端口 ${port} 已被占用：可能已经开着一个了。`);
      logger.error(`直接打开 http://127.0.0.1:${port}/ 试试，或换端口：node server/ocs-ai-server.mjs --port=8788\n`);
    } else {
      logger.error('启动失败：', err);
    }
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${port}/`;
    logger.log(`\n  OCS AI 题库 已启动`);
    logger.log(`  面板： ${url}`);
    logger.log(`  题库地址： http://127.0.0.1:${port}/answer`);
    logger.log(`  配置： ${settings.apiKey ? `已填写（${settings.model}）` : '未填写，请先在面板里填 API'}`);
    logger.log(`  停止： Ctrl + C\n`);
    if (!args.includes('--no-open')) openBrowser(url);
  });

  const shutdown = () => {
    logger.log('\n已停止。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) main();
