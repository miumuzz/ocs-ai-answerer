/**
 * 文本归一化与相似度。
 *
 * 这一层是「AI 答案 → 页面选项」匹配的地基：
 * 模型给的答案可能是 "A"、"AC"、"A、C"、"选项B"、整段选项原文，
 * 而页面上的选项文本可能带 "A." 前缀、全角标点、回车、图片。
 * 所以先统一成可比对的形态，再谈匹配。
 */

/** 全角转半角 + 小写 + 去空白 + 去标点，只留「可比较的骨架」 */
export function normalizeText(input) {
  let s = String(input ?? '');
  try {
    s = s.normalize('NFKC');
  } catch {
    /* 老浏览器忽略 */
  }
  return s
    .toLowerCase()
    .replace(/[\s\u00a0\u3000]+/g, '')
    .replace(/[.,;:!?'"`~^*_+=|\\/<>()[\]{}<>（）【】《》「」『』、，。；：！？“”‘’…—－·\-]/g, '');
}

/** 去掉选项前面的 A. / A、/ (A) / ① 之类编号，便于和答案原文比对 */
export function stripOptionLabel(text) {
  return String(text ?? '')
    .replace(/^\s*[（(]\s*[A-Za-z0-9]{1,2}\s*[)）]\s*/, '')
    .replace(/^\s*[A-Za-z]\s*[.．、:：)）]\s*/, '')
    .replace(/^\s*[①-⑳]\s*/, '')
    .replace(/^\s*\d{1,2}\s*[.．、:：)）]\s*/, '')
    .trim();
}

/** 去掉题干里的题号、题型、分值等噪声（超星尤其多） */
export function cleanStem(text) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/\n{2,}/g, '\n').trim();
  const patterns = [
    /^\s*第\s*\d+\s*题\s*[.、:：]?\s*/,
    /^\s*\d+\s*[.、:：)）]\s*/,
    /^\s*[（(]\s*\d+\s*[)）]\s*/,
    /[（(]\s*(?:单选题|多选题|判断题|填空题|简答题|名词解释|论述题|计算题|连线题|阅读理解|完形填空)\s*[,，]?\s*[\d.]*\s*分?\s*[)）]/g,
    /[\[【]\s*(?:单选题|多选题|判断题|填空题|简答题|名词解释|论述题|计算题|连线题)\s*[\]】]/g,
    /[（(]\s*[\d.]+\s*分\s*[)）]/g,
    /【\s*[\d.]+\s*分\s*】/g,
  ];
  for (const re of patterns) s = s.replace(re, '');
  return s.replace(/[ \t]{2,}/g, ' ').trim();
}

/** 超星部分题目用自定义字体加密，取到的会是私有区字符；提前发现并提示用户 */
export function looksEncrypted(text) {
  const s = String(text ?? '');
  if (!s) return false;
  let bad = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if ((code >= 0xe000 && code <= 0xf8ff) || code === 0xfffd) bad++;
  }
  return bad >= 2 && bad / s.length > 0.15;
}

/** 把 "AC" / "A、C" / "A,C" / "答案：A" 解析成字母数组 */
export function extractLetters(input, { maxLetter = 'J' } = {}) {
  if (Array.isArray(input)) input = input.join(',');
  let s = String(input ?? '');
  try {
    s = s.normalize('NFKC');
  } catch {
    /* ignore */
  }
  s = s.toUpperCase();
  // 判断题的常见英文答案不要被当成选项字母
  s = s.replace(/\b(TRUE|FALSE|YES|NO)\b/g, ' ');
  const tokens = s.split(/[^A-Z]+/).filter(Boolean);
  const out = [];
  for (const token of tokens) {
    if (token.length > 8) continue; // 多半是英文单词，不是答案
    for (const ch of token) {
      if (ch < 'A' || ch > maxLetter) return [];
      if (!out.includes(ch)) out.push(ch);
    }
  }
  return out;
}

const TRUE_WORDS = ['正确', '对', '是', '√', '✓', 'true', 'yes', 't', 'y', '1'];
const FALSE_WORDS = ['错误', '错', '否', '×', '✗', 'x', 'false', 'no', 'f', 'n', '0'];

/** 判断题答案归一化：返回 true / false / null */
export function parseJudgement(input) {
  if (typeof input === 'boolean') return input;
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  const s = normalizeText(raw);
  if (!s) return null;
  // 长词优先，避免 "不正确" 被 "正确" 抢先
  if (/^(不正确|不对|错误|错|×|✗|false|no|f|n|0)$/.test(s)) return false;
  if (/^(正确|对|是|√|✓|true|yes|t|y|1)$/.test(s)) return true;
  for (const w of FALSE_WORDS) if (s.includes(normalizeText(w))) return false;
  for (const w of TRUE_WORDS) if (s.includes(normalizeText(w))) return true;
  return null;
}

/** 把填空答案拆成「按空顺序」的字符串数组 */
export function splitFillAnswer(input, separators = ['#', '|||', '；', ';', '\n']) {
  if (Array.isArray(input)) {
    return input.map((x) => String(x ?? '').trim()).filter((x) => x.length > 0);
  }
  let s = String(input ?? '').trim();
  if (!s) return [];
  // 答案整体被引号包住的情况
  s = s.replace(/^["'“”](.*)["'“”]$/s, '$1').trim();
  const seps = separators.filter(Boolean).sort((a, b) => b.length - a.length);
  for (const sep of seps) {
    if (s.includes(sep)) {
      const parts = s.split(sep).map((x) => x.trim());
      if (parts.filter(Boolean).length > 1) return parts.filter(Boolean);
    }
  }
  return [s];
}

/** 二元组 Dice 系数，用来衡量两段中文/英文的相似度 */
export function diceCoefficient(a, b) {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const bigrams = new Map();
  for (let i = 0; i < a.length - 1; i++) {
    const g = a.slice(i, i + 2);
    bigrams.set(g, (bigrams.get(g) || 0) + 1);
  }
  let hit = 0;
  for (let i = 0; i < b.length - 1; i++) {
    const g = b.slice(i, i + 2);
    const count = bigrams.get(g) || 0;
    if (count > 0) {
      bigrams.set(g, count - 1);
      hit++;
    }
  }
  return (2 * hit) / (a.length - 1 + b.length - 1);
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[b.length];
}

/** 综合相似度 0~1：完全相等 > 包含 > Dice/编辑距离 */
export function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  if (short.length >= 3 && long.includes(short)) {
    return 0.82 + 0.16 * (short.length / long.length);
  }
  const dice = diceCoefficient(na, nb);
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  return Math.max(dice, lev);
}

/** 题干指纹：用于本地缓存 / 题库查询去重 */
export function questionFingerprint(stem, options = []) {
  const base = [normalizeText(cleanStem(stem)), ...(options || []).map((o) => normalizeText(stripOptionLabel(o)))].join('|');
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}
