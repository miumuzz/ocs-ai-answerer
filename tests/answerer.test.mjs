import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, mergeDeep } from '../src/config.js';
import {
  AiAnswerer,
  countBlanks,
  normalizeType,
  splitOcsOptions,
  toOcsAnswer,
} from '../src/answerer.js';
import { ANSWER_SEPARATOR } from '../src/constants.js';

const OCS_OPTIONS = 'A. 上海\nB. 北京\nC. 广州';

function makeConfig(patch = {}) {
  return mergeDeep(DEFAULT_CONFIG, { bank: { cache: false }, ...patch });
}

test('splitOcsOptions：按换行拆选项并去空行', () => {
  assert.deepEqual(splitOcsOptions(OCS_OPTIONS), ['A. 上海', 'B. 北京', 'C. 广州']);
  assert.deepEqual(splitOcsOptions('对\n错'), ['对', '错']);
  assert.deepEqual(splitOcsOptions(''), []);
  assert.deepEqual(splitOcsOptions(undefined), []);
});

test('countBlanks：数题干里的空', () => {
  assert.equal(countBlanks('中国的首都是____，最大的城市是____。'), 2);
  assert.equal(countBlanks('1+1=（ ）'), 1);
  assert.equal(countBlanks('没有下划线的题'), 1);
});

test('normalizeType：OCS 题型映射与推断', () => {
  assert.equal(normalizeType('single', ['a', 'b']), 'single');
  assert.equal(normalizeType('multiple', ['a', 'b']), 'multiple');
  assert.equal(normalizeType('judgement', ['对', '错']), 'judgement');
  assert.equal(normalizeType('completion', []), 'completion');
  assert.equal(normalizeType('line', ['a']), 'unsupported');
  assert.equal(normalizeType('unknown', ['对', '错']), 'judgement');
  assert.equal(normalizeType('unknown', []), 'completion');
  assert.equal(normalizeType('unknown', ['甲', '乙', '丙']), 'single');
});

test('toOcsAnswer：单选返回原样选项文本（不是字母）', () => {
  const r = toOcsAnswer({ type: 'single', aiAnswer: 'B', options: splitOcsOptions(OCS_OPTIONS) });
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'B. 北京');
});

test('toOcsAnswer：多选用 === 连接选项原文', () => {
  const r = toOcsAnswer({ type: 'multiple', aiAnswer: ['A', 'C'], options: splitOcsOptions(OCS_OPTIONS) });
  assert.equal(r.ok, true);
  assert.equal(r.answer, `A. 上海${ANSWER_SEPARATOR}C. 广州`);
});

test('toOcsAnswer：判断题命中选项原文', () => {
  assert.equal(toOcsAnswer({ type: 'judgement', aiAnswer: '正确', options: ['错', '对'] }).answer, '对');
  assert.equal(toOcsAnswer({ type: 'judgement', aiAnswer: '×', options: ['√', '×'] }).answer, '×');
  // 选项不是对/错字样时退回文字
  assert.equal(toOcsAnswer({ type: 'judgement', aiAnswer: '对', options: ['甲', '乙'] }).answer, '对');
});

test('toOcsAnswer：填空按空连接', () => {
  const r = toOcsAnswer({ type: 'completion', aiAnswer: ['北京', '上海'], options: [] });
  assert.equal(r.ok, true);
  assert.equal(r.answer, ['北京', '上海'].join(ANSWER_SEPARATOR));
});

test('toOcsAnswer：答案对不上选项时返回 not ok', () => {
  const r = toOcsAnswer({ type: 'single', aiAnswer: '秦始皇', options: splitOcsOptions(OCS_OPTIONS) });
  assert.equal(r.ok, false);
  const empty = toOcsAnswer({ type: 'single', aiAnswer: 'A', options: [] });
  assert.equal(empty.ok, false);
});

test('AiAnswerer：完整链路（假 AI）返回 OCS 可用的答案', async () => {
  const ai = { chat: async () => ({ content: '{"answer":"B","confidence":0.92}', usage: {} }) };
  const answerer = new AiAnswerer({ config: makeConfig(), ai, bank: fakeBank() });
  const res = await answerer.answer({ title: '中国的首都是哪座城市？', options: OCS_OPTIONS, type: 'single' });
  assert.equal(res.answer, 'B. 北京');
  assert.equal(res.source, 'AI');
  assert.equal(res.question, '中国的首都是哪座城市？');
});

test('AiAnswerer：多媒体（多选）', async () => {
  const ai = { chat: async () => ({ content: '{"answer":["A","C"],"confidence":0.8}', usage: {} }) };
  const answerer = new AiAnswerer({ config: makeConfig(), ai, bank: fakeBank() });
  const res = await answerer.answer({ title: '下列属于水果的有？', options: 'A. 苹果\nB. 白菜\nC. 香蕉', type: 'multiple' });
  assert.equal(res.answer, `A. 苹果${ANSWER_SEPARATOR}C. 香蕉`);
});

test('AiAnswerer：不支持的题型直接返回 error（不调用 AI）', async () => {
  let calls = 0;
  const ai = {
    chat: async () => {
      calls++;
      return { content: '{"answer":"A"}' };
    },
  };
  const answerer = new AiAnswerer({ config: makeConfig(), ai, bank: fakeBank() });
  const res = await answerer.answer({ title: '连线题', options: 'A\nB', type: 'line' });
  assert.match(res.error, /不支持/);
  assert.equal(calls, 0);
});

test('AiAnswerer：AI 报错时返回 error，不抛异常', async () => {
  const ai = {
    chat: async () => {
      throw new Error('401 鉴权失败');
    },
  };
  const answerer = new AiAnswerer({ config: makeConfig(), ai, bank: fakeBank() });
  const res = await answerer.answer({ title: '1+1=?', options: 'A. 1\nB. 2', type: 'single' });
  assert.match(res.error, /401/);
});

test('AiAnswerer：题干为空时不用请求接口', async () => {
  let calls = 0;
  const ai = {
    chat: async () => {
      calls++;
      return { content: '{}' };
    },
  };
  const answerer = new AiAnswerer({ config: makeConfig(), ai, bank: fakeBank() });
  const res = await answerer.answer({ title: '', options: 'A\nB', type: 'single' });
  assert.match(res.error, /题干为空/);
  assert.equal(calls, 0);
});

test('AiAnswerer：缓存命中直接返回，不再调用 AI', async () => {
  let calls = 0;
  const ai = {
    chat: async () => {
      calls++;
      return { content: '{"answer":"B"}' };
    },
  };
  const bank = fakeBank({ get: () => ({ answer: 'B. 北京', source: 'AI' }) });
  const answerer = new AiAnswerer({ config: makeConfig({ bank: { cache: true } }), ai, bank });
  const res = await answerer.answer({ title: '中国的首都是哪座城市？', options: OCS_OPTIONS, type: 'single' });
  assert.equal(res.answer, 'B. 北京');
  assert.equal(res.source, '缓存');
  assert.equal(calls, 0);
});

function fakeBank(overrides = {}) {
  return {
    get: () => null,
    put: () => {},
    clear: () => {},
    queryRemote: async () => null,
    ...overrides,
  };
}
