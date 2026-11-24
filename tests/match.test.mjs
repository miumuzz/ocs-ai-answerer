import test from 'node:test';
import assert from 'node:assert/strict';

import { matchChoice, matchFill, matchJudgement } from '../src/match.js';

const opts = ['马克思', '恩格斯', '列宁', '斯大林'];

test('matchChoice：字母直接对位', () => {
  const r = matchChoice('B', opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.indexes, [1]);
  assert.equal(r.method, 'letter');
});

test('matchChoice：多选字母', () => {
  const r = matchChoice('AC', opts, { type: 'multiple' });
  assert.deepEqual(r.indexes, [0, 2]);
});

test('matchChoice：字母数组', () => {
  const r = matchChoice(['A', 'D'], opts, { type: 'multiple' });
  assert.deepEqual(r.indexes, [0, 3]);
});

test('matchChoice：选项原文', () => {
  const r = matchChoice('列宁', opts);
  assert.equal(r.ok, true);
  assert.deepEqual(r.indexes, [2]);
  assert.equal(r.method, 'text');
});

test('matchChoice：带前缀的选项原文', () => {
  const r = matchChoice('C. 列宁', opts);
  assert.deepEqual(r.indexes, [2]);
});

test('matchChoice：多选题合写文本逐个匹配', () => {
  const r = matchChoice('马克思、列宁', opts, { type: 'multiple' });
  assert.deepEqual(r.indexes, [0, 2]);
});

test('matchChoice：完全对不上时不 ok', () => {
  const r = matchChoice('秦始皇', opts);
  assert.equal(r.ok, false);
  assert.equal(r.score < 0.6, true);
});

test('matchJudgement：按选项文本', () => {
  assert.deepEqual(matchJudgement('对', ['错', '对']).indexes, [1]);
  assert.deepEqual(matchJudgement('√', ['×', '√']).indexes, [1]);
});

test('matchJudgement：两选项时按位置兜底', () => {
  const r = matchJudgement('正确', ['第一项', '第二项']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.indexes, [0]);
  assert.equal(r.method, 'position');
  assert.deepEqual(matchJudgement('错误', ['第一项', '第二项']).indexes, [1]);
});

test('matchFill：按空拆分并处理数量不符', () => {
  assert.deepEqual(matchFill('北京#上海', { blanks: 2 }).texts, ['北京', '上海']);
  const merged = matchFill('北京 上海', { blanks: 1 });
  assert.equal(merged.texts.length, 1);
  const trimmed = matchFill('甲#乙#丙', { blanks: 2 });
  assert.deepEqual(trimmed.texts, ['甲', '乙']);
  assert.ok(trimmed.note.includes('空格数'));
});
