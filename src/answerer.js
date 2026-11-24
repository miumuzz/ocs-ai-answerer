/**
 * AI 题库的「答题内核」。
 *
 * OCS 发来的是一段 {title, options, type}：
 *   title   —— 题干（超星可能带题号/分值，OCS 已做过清洗）
 *   options —— 选项，用换行拼接（没有选项时为空字符串，比如填空题）
 *   type    —— OCS 判定的题型：single / multiple / judgement / completion / line / fill / reader / unknown
 *
 * 我们要回的是「能直接命中 OCS 选项的答案」：
 *   选择题 → 原样返回选项文本（不是字母！OCS 的匹配器按选项文本比对最稳）
 *   多选   → 选中的选项文本用 '===' 连接
 *   判断题 → 返回选项里的「对/错」原文，找不到就返回 对 / 错
 *   填空   → 各空答案用 '===' 连接
 * 答不出来就返回 ok:false，让 OCS 认为「这个题库没搜到」，继续走其它题库或标记未答。
 */

import { AIClient } from './ai/client.js';
import { buildMessages, buildRepairMessages } from './ai/prompt.js';
import { parseModelOutput } from './ai/parse.js';
import { matchChoice } from './match.js';
import { AnswerBank } from './bank.js';
import { parseJudgement, questionFingerprint, splitFillAnswer } from './util/text.js';
import { truncate } from './util/misc.js';
import { ANSWER_SEPARATOR } from './constants.js';

const TYPE_MAP = {
  single: 'single',
  multiple: 'multiple',
  judgement: 'judgement',
  completion: 'completion',
  short: 'short',
};

const UNSUPPORTED = new Set(['line', 'fill', 'reader']);

/** 把 OCS 的 options 字符串（换行拼接）拆成数组 */
export function splitOcsOptions(options) {
  if (Array.isArray(options)) return options.map((o) => String(o ?? '').trim()).filter(Boolean);
  return String(options ?? '')
    .split(/\r?\n/)
    .map((o) => o.trim())
    .filter(Boolean);
}

/** 数一数题干里有几个空 */
export function countBlanks(title) {
  const t = String(title ?? '');
  const runs = t.match(/[_＿]{2,}|（\s*）|\(\s*\)/g);
  if (runs && runs.length) return runs.length;
  return 1;
}

/** OCS 的题型 + 兜底推断 */
export function normalizeType(type, options) {
  const t = String(type || '').toLowerCase();
  if (UNSUPPORTED.has(t)) return 'unsupported';
  if (TYPE_MAP[t]) return TYPE_MAP[t];
  if (!options.length) return 'completion';
  if (options.length === 2) {
    const verdicts = options.map((o) => parseJudgement(o));
    if (verdicts[0] !== null && verdicts[1] !== null && verdicts[0] !== verdicts[1]) return 'judgement';
  }
  return 'single';
}

/**
 * AI 答案 → OCS 能用的答案字符串
 * @returns {{ok:boolean, answer?:string, detail?:string}}
 */
export function toOcsAnswer({ type, aiAnswer, options }) {
  if (type === 'completion' || type === 'short') {
    const texts = splitFillAnswer(aiAnswer).filter(Boolean);
    if (!texts.length) return { ok: false, detail: '填空答案为空' };
    return { ok: true, answer: texts.join(ANSWER_SEPARATOR) };
  }

  if (type === 'judgement') {
    const target = parseJudgement(aiAnswer);
    if (target === null) return { ok: false, detail: '判断题答案无法识别' };
    const hit = options.find((opt) => parseJudgement(opt) === target);
    return { ok: true, answer: hit || (target ? '对' : '错') };
  }

  if (!options.length) return { ok: false, detail: '没有选项' };

  if (type === 'multiple') {
    const r = matchChoice(aiAnswer, options, { type: 'multiple', threshold: 0.6 });
    if (!r.ok || !r.indexes.length) return { ok: false, detail: '多选答案匹配不到选项' };
    const texts = r.indexes.map((i) => options[i]).filter(Boolean);
    return { ok: true, answer: texts.join(ANSWER_SEPARATOR) };
  }

  const r = matchChoice(aiAnswer, options, { type: 'single', threshold: 0.6 });
  if (!r.ok || !r.indexes.length) return { ok: false, detail: '单选答案匹配不到选项' };
  return { ok: true, answer: options[r.indexes[0]] };
}

export class AiAnswerer {
  constructor({ config, log = () => {}, ai = null, bank = null }) {
    this.config = config;
    this.log = log;
    this.ai = ai || new AIClient(config, log);
    this.bank = bank || new AnswerBank(config, log);
    this.stats = { asked: 0, cache: 0, failed: 0, ok: 0 };
  }

  /**
   * @param {{title?:string, options?:string, type?:string}} payload
   * @returns {Promise<{question:string, answer?:string, error?:string, source?:string}>}
   */
  async answer(payload) {
    const title = String(payload && payload.title ? payload.title : '').trim();
    const options = splitOcsOptions(payload && payload.options);
    const type = normalizeType(payload && payload.type, options);
    const question = title;

    if (!title) return { question, error: '题干为空' };
    if (type === 'unsupported') {
      this.stats.failed++;
      return { question, error: `暂不支持的题型：${(payload && payload.type) || 'unknown'}` };
    }

    const fingerprint = questionFingerprint(title, options);
    if (this.config.bank.cache) {
      const cached = this.bank.get(fingerprint);
      if (cached && cached.answer) {
        this.stats.cache++;
        return { question, answer: cached.answer, source: '缓存' };
      }
    }

    const promptQuestion = {
      type,
      stem: title,
      options: options.map((text, i) => ({ label: String.fromCharCode(65 + i), text })),
      blanks: type === 'completion' ? countBlanks(title) : 0,
    };

    const messages = buildMessages(promptQuestion, { subject: this.config.subject || '' });
    let parsed = null;
    try {
      const res = await this.ai.chat(messages, { maxTokens: Math.max(256, Number(this.config.api.maxTokens) || 1024) });
      this.stats.asked++;
      parsed = parseModelOutput(res.content, type);

      if (!parsed.ok) {
        const repaired = await this.ai.chat(buildRepairMessages(messages, res.content, parsed.error || 'JSON 不合法'), {
          maxTokens: 256,
        });
        this.stats.asked++;
        parsed = parseModelOutput(repaired.content, type);
      }
    } catch (err) {
      this.stats.failed++;
      return { question, error: (err && err.message ? err.message : String(err)).slice(0, 160) };
    }

    if (!parsed || !parsed.ok) {
      this.stats.failed++;
      return { question, error: '模型没有返回可解析的答案' };
    }

    const converted = toOcsAnswer({ type, aiAnswer: parsed.answer, options });
    if (!converted.ok) {
      this.stats.failed++;
      this.log('warn', `答案无法落到选项：${converted.detail}（原始答案 ${truncate(String(parsed.answer), 40)}）`);
      return { question, error: converted.detail };
    }

    this.stats.ok++;
    if (this.config.bank.cache) {
      this.bank.put(fingerprint, { answer: converted.answer, type, stem: truncate(title, 120), source: 'AI' });
    }
    this.log('ok', `[${type}] ${truncate(title, 30)} → ${truncate(converted.answer, 40)}`);
    return { question, answer: converted.answer, source: 'AI', confidence: parsed.confidence };
  }
}
