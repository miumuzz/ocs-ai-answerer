/**
 * 「答案 → 选项」匹配。
 *
 * 模型可能给 A / AC / ["A","C"] / 选项原文 / 一整句话。
 * 这里先按字母对位，再按文本相似度兜底，最后才是位置兜底（判断题）。
 */

import { extractLetters, parseJudgement, similarity, splitFillAnswer, stripOptionLabel } from './util/text.js';

/** 统一选项形态：允许字符串数组或 {label,text} 数组 */
export function normalizeOptions(options = []) {
  return options.map((opt, i) => {
    const label = typeof opt === 'string' ? String.fromCharCode(65 + i) : opt.label || String.fromCharCode(65 + i);
    const text = typeof opt === 'string' ? opt : String(opt.text ?? '');
    return { label: String(label).toUpperCase(), text, index: i };
  });
}

function letterToIndex(letter, options) {
  const idx = options.findIndex((o) => o.label === letter);
  if (idx !== -1) return idx;
  const code = letter.charCodeAt(0) - 65;
  return code >= 0 && code < options.length ? code : -1;
}

export function answersToText(answerRaw) {
  if (Array.isArray(answerRaw)) return answerRaw.map((x) => String(x ?? ''));
  if (answerRaw === null || answerRaw === undefined) return [];
  return [String(answerRaw)];
}

/**
 * 选择题匹配
 * @param {any} answerRaw
 * @param {Array<string|{label?:string,text:string}>} options
 * @param {{type?:'single'|'multiple', threshold?:number}} opts
 */
export function matchChoice(answerRaw, options, { type = 'single', threshold = 0.6 } = {}) {
  const opts = normalizeOptions(options);
  if (!opts.length) return { indexes: [], letters: [], score: 0, method: 'none', ok: false };

  // 1) 字母对位
  const letters = Array.isArray(answerRaw) && answerRaw.every((x) => typeof x === 'string' && /^[A-Za-z]$/.test(x.trim()))
    ? answerRaw.map((x) => x.trim().toUpperCase())
    : extractLetters(answerRaw);

  if (letters.length) {
    const indexes = [];
    for (const letter of letters) {
      const idx = letterToIndex(letter, opts);
      if (idx !== -1 && !indexes.includes(idx)) indexes.push(idx);
    }
    if (indexes.length) {
      const picked = type === 'multiple' ? indexes : [indexes[0]];
      return {
        indexes: picked,
        letters: picked.map((i) => opts[i].label),
        score: 1,
        method: 'letter',
        ok: true,
      };
    }
  }

  // 2) 文本相似度（多选题的答案常是「甲、丙」这种合写，先拆开再逐个比对）
  const answerTexts = answersToText(answerRaw)
    .flatMap((t) => String(t).split(/[、,，;；/|+\n]+/))
    .map((t) => stripOptionLabel(t))
    .filter(Boolean);
  if (!answerTexts.length) return { indexes: [], letters: [], score: 0, method: 'none', ok: false };

  const scored = opts.map((opt) => {
    const optText = stripOptionLabel(opt.text);
    let best = 0;
    for (const t of answerTexts) best = Math.max(best, similarity(t, optText));
    return { index: opt.index, label: opt.label, score: best };
  });
  scored.sort((a, b) => b.score - a.score);

  if (type === 'multiple') {
    const hit = scored.filter((s) => s.score >= threshold);
    const picked = (hit.length ? hit : [scored[0]]).map((s) => s.index).sort((a, b) => a - b);
    return {
      indexes: picked,
      letters: picked.map((i) => opts[i].label),
      score: hit.length ? hit[hit.length - 1].score : scored[0].score,
      method: 'text',
      ok: hit.length > 0,
    };
  }

  const top = scored[0];
  return {
    indexes: [top.index],
    letters: [top.label],
    score: top.score,
    method: 'text',
    ok: top.score >= threshold,
  };
}

/** 判断题：优先认选项文本，其次按「对在前、错在后」的位置兜底 */
export function matchJudgement(answerRaw, options) {
  const opts = normalizeOptions(options);
  if (!opts.length) return { indexes: [], letters: [], score: 0, method: 'none', ok: false };

  const target = parseJudgement(answerRaw);
  if (target === null) return { indexes: [], letters: [], score: 0, method: 'none', ok: false };

  for (const opt of opts) {
    const verdict = parseJudgement(stripOptionLabel(opt.text));
    if (verdict === target) {
      return { indexes: [opt.index], letters: [opt.label], score: 1, method: 'text', ok: true };
    }
  }

  if (opts.length === 2) {
    const idx = target ? 0 : 1;
    return { indexes: [idx], letters: [opts[idx].label], score: 0.5, method: 'position', ok: true };
  }

  return { indexes: [], letters: [], score: 0, method: 'none', ok: false };
}

/** 填空题：按分隔符拆成多空 */
export function matchFill(answerRaw, { blanks = 0, separators = ['#', '|||', '；', ';', '\n'] } = {}) {
  let texts = splitFillAnswer(answerRaw, separators);
  if (!texts.length) return { texts: [], ok: false, note: '答案为空' };

  if (blanks > 0 && texts.length !== blanks) {
    if (blanks === 1 && texts.length > 1) {
      return { texts: [texts.join(' ')], ok: true, note: `答案被拆成 ${texts.length} 段，已合并为 1 空` };
    }
    return {
      texts: texts.slice(0, blanks),
      ok: true,
      note: `空格数 ${blanks}，答案段数 ${texts.length}，已按顺序截断/补齐`,
    };
  }

  return { texts, ok: true, note: '' };
}
