import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJsonObject, parseModelOutput, repairJson, stripCodeFence } from '../src/ai/parse.js';

test('stripCodeFence：剥掉 ```json 包裹', () => {
  assert.equal(stripCodeFence('```json\n{"answer":"A"}\n```'), '{"answer":"A"}');
  assert.equal(stripCodeFence('{"answer":"A"}'), '{"answer":"A"}');
});

test('extractJsonObject：从带解释的文本里截出对象', () => {
  const text = '好的，我认为答案是：{"answer":"B","confidence":0.9} 以上。';
  assert.equal(extractJsonObject(text), '{"answer":"B","confidence":0.9}');
});

test('extractJsonObject：字符串里的花括号不会误判', () => {
  const text = '{"answer":"他说 {x} 是符号","confidence":0.8}';
  assert.equal(extractJsonObject(text), text);
});

test('repairJson：处理单引号与尾逗号', () => {
  const repaired = repairJson("{'answer':'A',}");
  assert.deepEqual(JSON.parse(repaired), { answer: 'A' });
});

test('parseModelOutput：标准 JSON', () => {
  const r = parseModelOutput('{"answer":"B","confidence":0.9,"reason":"常识"}', 'single');
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'B');
  assert.equal(r.confidence, 0.9);
  assert.equal(r.reason, '常识');
});

test('parseModelOutput：带代码块与前后废话', () => {
  const r = parseModelOutput('题目答案是：\n```json\n{"answer":["A","C"],"confidence":95}\n```\n供参考', 'multiple');
  assert.equal(r.ok, true);
  assert.deepEqual(r.answer, ['A', 'C']);
  assert.equal(r.confidence, 0.95);
});

test('parseModelOutput：中文引号 + 尾逗号', () => {
  const r = parseModelOutput('{“answer”:“对”,“confidence”:0.8,}', 'judgement');
  assert.equal(r.ok, true);
  assert.equal(r.answer, '对');
});

test('parseModelOutput：判断题布尔值', () => {
  const r = parseModelOutput('{"answer":false,"confidence":0.7}', 'judgement');
  assert.equal(r.ok, true);
  assert.equal(r.answer, '错');
});

test('parseModelOutput：多选题只给了字母字符串', () => {
  const r = parseModelOutput('{"answer":"BD"}', 'multiple');
  assert.deepEqual(r.answer, ['B', 'D']);
});

test('parseModelOutput：非 JSON，退化为「答案：B」', () => {
  const r = parseModelOutput('经过分析，答案：B。', 'single');
  assert.equal(r.ok, true);
  assert.equal(r.answer, 'B');
});

test('parseModelOutput：彻底无法解析', () => {
  const r = parseModelOutput('我不知道这道题。', 'single');
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
