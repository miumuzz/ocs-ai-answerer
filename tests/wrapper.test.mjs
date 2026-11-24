import test from 'node:test';
import assert from 'node:assert/strict';

import { buildWrapperTemplate } from '../server/ocs-ai-server.mjs';

test('wrapper：生成的 OCS 题库配置字段齐全', () => {
  const w = buildWrapperTemplate(8787);
  assert.equal(w.name, 'AI 答题（本地服务）');
  assert.equal(w.url, 'http://127.0.0.1:8787/answer');
  assert.equal(w.homepage, 'http://127.0.0.1:8787/');
  assert.equal(w.method, 'post');
  assert.equal(w.type, 'fetch');
  assert.equal(w.responseType, 'json');
  assert.equal(w.headers['Content-Type'], 'application/json');
  assert.equal(w.data.title, '${title}');
  assert.equal(w.data.options, '${options}');
  assert.equal(w.data.type, '${type}');
  // 不要把 ${images} 放进去：开了图片题优化时它是 base64 数组，会把请求体撑爆
  assert.equal(w.data.images, undefined);
});

test('wrapper：端口变化时 url 跟着变', () => {
  assert.equal(buildWrapperTemplate(9000).url, 'http://127.0.0.1:9000/answer');
});

test('wrapper：handler 串能被 OCS 的 Function(handler)() 解析', () => {
  const w = buildWrapperTemplate(8787);
  // eslint-disable-next-line no-new-func
  const handler = Function(w.handler)();
  assert.equal(typeof handler, 'function');
  assert.deepEqual(handler({ question: '题干', answer: 'B. 北京' }), ['题干', 'B. 北京']);
  assert.equal(handler({}), undefined);
  assert.equal(handler({ question: '题干' }), undefined);
});

test('wrapper：可序列化成 JSON 再解析回来', () => {
  const text = JSON.stringify([buildWrapperTemplate(8787)], null, 2);
  const parsed = JSON.parse(text);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].url, 'http://127.0.0.1:8787/answer');
});
