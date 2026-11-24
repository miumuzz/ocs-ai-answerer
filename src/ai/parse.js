/**
 * 模型输出解析。
 *
 * 现实情况：即使要求「只输出 JSON」，模型仍可能返回 ```json 包裹、多余解释、
 * 中文引号、尾逗号，或者干脆「答案：B」。这里逐层兜底，尽量不让一道题白丢。
 */

import { extractLetters } from '../util/text.js';

/** 去掉 ```json ... ``` 包裹 */
export function stripCodeFence(text) {
  let s = String(text ?? '').trim();
  const fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  return s;
}

/** 从任意文本里截出第一个「括号配对」的 JSON 对象 */
export function extractJsonObject(text) {
  const s = String(text ?? '');
  const start = s.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

/** 常见小毛病的修补：中文引号、尾逗号、单引号 key */
export function repairJson(raw) {
  return String(raw ?? '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/([{,]\s*)'([^']+)'\s*:/g, '$1"$2":')
    .replace(/:\s*'([^']*)'/g, ': "$1"');
}

function tryParse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    /* next */
  }
  try {
    return JSON.parse(repairJson(raw));
  } catch {
    return null;
  }
}

function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

function toConfidence(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(String(value).replace('%', ''));
  if (!Number.isFinite(n)) return null;
  if (n > 1 && n <= 100) return Math.min(1, n / 100);
  return Math.max(0, Math.min(1, n));
}

/** 把对象里的各种答案写法统一成 { answer, confidence, reason } */
export function normalizeAnswerObject(obj, type = 'unknown') {
  if (!obj || typeof obj !== 'object') return null;
  let answer = pick(obj, ['answer', '答案', 'correct', 'correctAnswer', 'result', 'value']);
  if (answer === undefined) return null;

  const confidence = toConfidence(pick(obj, ['confidence', 'conf', 'score', '把握', '置信度']));
  const reason = String(pick(obj, ['reason', 'explain', 'explanation', '解析', '理由']) || '').slice(0, 120);

  if (type === 'multiple') {
    if (typeof answer === 'string' && /^[A-Ja-j,\s、，]+$/.test(answer.trim())) {
      answer = extractLetters(answer);
    } else if (!Array.isArray(answer)) {
      answer = [answer];
    }
  }

  if (type === 'judgement' && typeof answer === 'boolean') answer = answer ? '对' : '错';

  if (typeof answer === 'string') answer = answer.trim();
  if (Array.isArray(answer)) answer = answer.map((x) => String(x ?? '').trim()).filter(Boolean);

  return { answer, confidence, reason };
}

/**
 * 解析模型输出。
 * @returns {{ok:boolean, answer:any, confidence:number|null, reason:string, error?:string, raw:string}}
 */
export function parseModelOutput(text, type = 'unknown') {
  const raw = String(text ?? '');
  const body = stripCodeFence(raw);

  const candidates = [body, extractJsonObject(body), extractJsonObject(raw)].filter(Boolean);
  for (const candidate of candidates) {
    const parsed = tryParse(candidate);
    if (parsed && typeof parsed === 'object') {
      const normalized = normalizeAnswerObject(parsed, type);
      if (normalized) return { ok: true, ...normalized, raw };
    }
  }

  // 兜底一：回答里带 "answer": "B"
  const m = body.match(/"answer"\s*:\s*("([^"]*)"|\[[^\]]*\]|[\w\u4e00-\u9fa5]+)/);
  if (m) {
    let value = m[1].trim();
    if (value.startsWith('[')) {
      try {
        value = JSON.parse(repairJson(value));
      } catch {
        value = value.replace(/[[\]"']/g, '');
      }
    } else value = value.replace(/^"|"$/g, '');
    return { ok: true, answer: value, confidence: null, reason: '', raw };
  }

  // 兜底二：纯文本 "答案：B" / "答案是我认为 A 和 C"
  const zh = body.match(/(?:答案|正确答案|answer)\s*[:：为是]\s*([^\n。；;]{1,60})/i);
  if (zh) {
    const letters = extractLetters(zh[1]);
    const answer = type === 'multiple' ? letters : letters[0] ?? zh[1].trim();
    if (answer && (Array.isArray(answer) ? answer.length : answer)) {
      return { ok: true, answer, confidence: null, reason: '', raw };
    }
  }

  return { ok: false, answer: null, confidence: null, reason: '', error: '模型没有返回可解析的答案', raw };
}
