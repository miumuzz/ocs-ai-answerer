import test from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../server/ocs-ai-server.mjs';

function setup(overrides = {}) {
  const settings = {
    baseUrl: 'https://api.test.local/v1',
    apiKey: 'sk-test',
    model: 'test-model',
    subject: '',
    temperature: 0.2,
    maxTokens: 512,
    timeout: 10000,
    port: 8787,
    ...overrides,
  };

  const calls = [];
  const fakeAnswerer = {
    config: { api: { baseUrl: settings.baseUrl, apiKey: settings.apiKey, model: settings.model } },
    ai: {
      test: async () => ({ latency: 12, model: 'test-model', reply: '可用' }),
    },
    answer: async (body) => {
      calls.push(body);
      if (!body || !body.title) return { question: '', error: '题干为空' };
      return { question: body.title, answer: 'B. 北京' };
    },
  };

  const saved = [];
  const server = createServer({
    settingsProvider: () => settings,
    settingsWriter: (patch) => {
      saved.push(patch);
      Object.assign(settings, patch);
      return settings;
    },
    answererFactory: () => fakeAnswerer,
    logger: { log() {}, error() {} },
  });

  return { server, settings, calls, saved, fakeAnswerer };
}

async function start(server) {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return `http://127.0.0.1:${port}`;
}

test('server：GET / 返回配置页', async () => {
  const { server } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/');
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /OCS AI 题库/);
    assert.match(html, /apiKey/);
  } finally {
    server.close();
  }
});

test('server：POST /answer 返回 OCS 需要的 {question, answer}', async () => {
  const { server, calls } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '中国的首都？', options: 'A. 上海\nB. 北京', type: 'single' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { question: '中国的首都？', answer: 'B. 北京' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].type, 'single');
  } finally {
    server.close();
  }
});

test('server：没有答案时返回 {}，OCS 会当作未搜到', async () => {
  const { server } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '', options: '', type: 'single' }),
    });
    assert.deepEqual(await res.json(), {});
  } finally {
    server.close();
  }
});

test('server：OPTIONS 预检带 CORS 与 Private-Network 头（Chrome 访问 localhost 必须）', async () => {
  const { server } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/answer', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://mooc1.chaoxing.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), '*');
    assert.equal(res.headers.get('access-control-allow-private-network'), 'true');
    assert.match(res.headers.get('access-control-allow-methods') || '', /POST/);
    assert.match(res.headers.get('access-control-allow-headers') || '', /content-type/i);
  } finally {
    server.close();
  }
});

test('server：POST /config 保存设置并让答题器重建', async () => {
  const { server, saved } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseUrl: 'https://api.deepseek.com/v1', apiKey: 'sk-new', model: 'deepseek-chat' }),
    });
    assert.deepEqual(await res.json(), { ok: true });
    assert.equal(saved.length, 1);
    assert.equal(saved[0].model, 'deepseek-chat');
    assert.equal(saved[0].apiKey, 'sk-new');
  } finally {
    server.close();
  }
});

test('server：POST /test 返回真实接口的测试结果', async () => {
  const { server } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.equal(data.model, 'test-model');
    assert.equal(data.latency, 12);
  } finally {
    server.close();
  }
});

test('server：/health 与 /wrapper.json 可用，且 url 端口随请求变化', async () => {
  const { server } = setup();
  const base = await start(server);
  const port = new URL(base).port;
  try {
    const health = await (await fetch(base + '/health')).json();
    assert.equal(health.ok, true);
    assert.equal(health.configured, true);

    const wrapper = await (await fetch(base + '/wrapper.json')).json();
    assert.equal(wrapper[0].url, `http://127.0.0.1:${port}/answer`);
    assert.equal(wrapper[0].method, 'post');
    assert.equal(wrapper[0].type, 'fetch');
    assert.equal(wrapper[0].handler.includes('[res.question, res.answer]'), true);
  } finally {
    server.close();
  }
});

test('server：坏 JSON 不会把服务打挂', async () => {
  const { server } = setup();
  const base = await start(server);
  try {
    const res = await fetch(base + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not json',
    });
    assert.equal(res.status, 400);
    const still = await fetch(base + '/health');
    assert.equal(still.status, 200);
  } finally {
    server.close();
  }
});

test('server：没填 Key 时拒绝作答（返回 {}）', async () => {
  const { server } = setup({ apiKey: '' });
  const base = await start(server);
  try {
    const res = await fetch(base + '/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: '题', options: 'A. 1\nB. 2', type: 'single' }),
    });
    assert.deepEqual(await res.json(), {});
  } finally {
    server.close();
  }
});
