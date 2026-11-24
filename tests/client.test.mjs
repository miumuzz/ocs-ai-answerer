import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, mergeDeep, resolveChatUrl } from '../src/config.js';
import { AIClient } from '../src/ai/client.js';

function makeConfig(patch = {}) {
  return mergeDeep(DEFAULT_CONFIG, {
    api: { baseUrl: 'https://api.test.local/v1', apiKey: '  sk-abc  ', model: ' test-model ' },
    ...patch,
  });
}

/** 用全局 GM_xmlhttpRequest 桩替代真实网络，记录每次请求 */
function stubGM(responder) {
  const calls = [];
  const prev = globalThis.GM_xmlhttpRequest;
  globalThis.GM_xmlhttpRequest = (opts) => {
    calls.push({ url: opts.url, headers: opts.headers, body: opts.data ? JSON.parse(opts.data) : null });
    const result = responder(opts, calls.length - 1);
    setTimeout(() => {
      if (result.error) opts.onerror(result.error);
      else opts.onload(result);
    }, 0);
    return { abort() {} };
  };
  return {
    calls,
    restore() {
      globalThis.GM_xmlhttpRequest = prev;
    },
  };
}

const okBody = (content = '可用') => ({
  status: 200,
  responseText: JSON.stringify({ model: 'test-model', choices: [{ message: { content } }], usage: {} }),
});

test('resolveChatUrl：各种 base 写法都能补成 chat/completions', () => {
  assert.equal(resolveChatUrl('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveChatUrl('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(resolveChatUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(
    resolveChatUrl('https://open.bigmodel.cn/api/paas/v4'),
    'https://open.bigmodel.cn/api/paas/v4/chat/completions'
  );
  assert.equal(
    resolveChatUrl('https://x.example.com/v1/chat/completions'),
    'https://x.example.com/v1/chat/completions'
  );
  assert.equal(resolveChatUrl(''), '');
});

test('test()：不发送 response_format，且 Key/模型名会去掉首尾空格', async () => {
  const gm = stubGM(() => okBody());
  try {
    const client = new AIClient(makeConfig());
    const r = await client.test();
    assert.equal(r.model, 'test-model');
    assert.equal(gm.calls.length, 1);
    assert.equal(gm.calls[0].body.response_format, undefined);
    assert.equal(gm.calls[0].body.model, 'test-model');
    assert.equal(gm.calls[0].headers.Authorization, 'Bearer sk-abc');
    assert.equal(gm.calls[0].url, 'https://api.test.local/v1/chat/completions');
  } finally {
    gm.restore();
  }
});

test('test()：401 时给出人话错误', async () => {
  const gm = stubGM(() => ({ status: 401, responseText: '{"error":{"message":"invalid api key"}}' }));
  try {
    const client = new AIClient(makeConfig());
    await assert.rejects(() => client.test(), /鉴权失败|401/);
  } finally {
    gm.restore();
  }
});

test('chat()：jsonMode 生效时带 response_format；接口不认时自动去掉重试', async () => {
  const gm = stubGM((opts, index) => {
    if (index === 0) return { status: 400, responseText: '{"error":"response_format is not supported"}' };
    return okBody('{"answer":"B"}');
  });
  try {
    const client = new AIClient(makeConfig({ api: { jsonMode: true } }));
    const res = await client.chat([{ role: 'user', content: '题目 json' }], { retry: 0 });
    assert.equal(res.content, '{"answer":"B"}');
    assert.equal(gm.calls.length, 2);
    assert.deepEqual(gm.calls[0].body.response_format, { type: 'json_object' });
    assert.equal(gm.calls[1].body.response_format, undefined);
  } finally {
    gm.restore();
  }
});
