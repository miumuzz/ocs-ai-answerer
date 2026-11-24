import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanStem,
  extractLetters,
  looksEncrypted,
  normalizeText,
  parseJudgement,
  questionFingerprint,
  similarity,
  splitFillAnswer,
  stripOptionLabel,
} from '../src/util/text.js';

test('normalizeText：全角转半角、去空白与标点', () => {
  assert.equal(normalizeText('Ａ． 选项，一'), 'a选项一');
  assert.equal(normalizeText('  Hello   World '), 'helloworld');
});

test('stripOptionLabel：去掉各种选项编号', () => {
  assert.equal(stripOptionLabel('A. 马克思'), '马克思');
  assert.equal(stripOptionLabel('（B）恩格斯'), '恩格斯');
  assert.equal(stripOptionLabel('③ 列宁'), '列宁');
  assert.equal(stripOptionLabel('马克思'), '马克思');
});

test('cleanStem：去掉题号与题型分值噪声', () => {
  assert.equal(cleanStem('1. 下列说法正确的是（ ）'), '下列说法正确的是（ ）');
  assert.equal(cleanStem('【单选题】中国的首都是（2.0分）'), '中国的首都是');
  assert.equal(cleanStem('(单选题, 2.0分) 1+1=?'), '1+1=?');
});

test('extractLetters：字母答案的各种写法', () => {
  assert.deepEqual(extractLetters('B'), ['B']);
  assert.deepEqual(extractLetters('AC'), ['A', 'C']);
  assert.deepEqual(extractLetters('答案：A、C'), ['A', 'C']);
  assert.deepEqual(extractLetters('选 A,C'), ['A', 'C']);
  assert.deepEqual(extractLetters('TRUE'), []); // 判断题英文不能被当成选项
  assert.deepEqual(extractLetters('这就是答案'), []);
});

test('parseJudgement：判断题归一化', () => {
  assert.equal(parseJudgement('对'), true);
  assert.equal(parseJudgement('√'), true);
  assert.equal(parseJudgement('True'), true);
  assert.equal(parseJudgement('错'), false);
  assert.equal(parseJudgement('×'), false);
  assert.equal(parseJudgement('不正确'), false);
  assert.equal(parseJudgement('不知道'), null);
});

test('splitFillAnswer：多空答案拆分', () => {
  assert.deepEqual(splitFillAnswer('北京#上海'), ['北京', '上海']);
  assert.deepEqual(splitFillAnswer('北京；上海；广州'), ['北京', '上海', '广州']);
  assert.deepEqual(splitFillAnswer(['甲', '乙']), ['甲', '乙']);
  assert.deepEqual(splitFillAnswer('只有一个答案'), ['只有一个答案']);
});

test('similarity：相同 / 包含 / 无关', () => {
  assert.equal(similarity('马克思', '马克思'), 1);
  assert.ok(similarity('马克思主义', '马克思主义基本原理') > 0.8);
  assert.ok(similarity('马克思', '牛顿') < 0.4);
});

test('looksEncrypted：私有区乱码识别', () => {
  assert.equal(looksEncrypted('正常题干'), false);
  assert.equal(looksEncrypted('\ue001\ue002\ue003\ue004'), true);
});

test('questionFingerprint：同题同指纹，换选项换指纹', () => {
  const a = questionFingerprint('1. 中国首都是？', ['北京', '上海']);
  const b = questionFingerprint('中国首都是？', ['北京', '上海']);
  const c = questionFingerprint('中国首都是？', ['上海', '北京']);
  assert.equal(a, b);
  assert.notEqual(a, c);
});
