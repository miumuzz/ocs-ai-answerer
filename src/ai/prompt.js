/** 提示词：把「一道题」变成模型一次就能答对的请求。 */

export const SYSTEM_PROMPT = [
  '你是一个严谨的中国高校网课答题引擎，服务于自动化答题脚本。',
  '你的唯一任务：根据题干与选项，给出这道题的标准答案。',
  '',
  '硬性规则：',
  '1. 只输出一个 JSON 对象。不要 markdown 代码块、不要 ```json、不要任何解释性前后缀。',
  '2. 选择题：answer 必须是选项字母（如 "B"）；多选题 answer 必须是字母数组（如 ["A","C"]）。',
  '3. 判断题：answer 只能是 "对" 或 "错"。',
  '4. 填空题：answer 必须是与空格数量一致的字符串数组，按空格从前到后排列。',
  '5. 简答/论述/名词解释：answer 是一段可直接提交的中文答案，控制在 200 字以内，分点用 1. 2. 3.。',
  '6. 必须作答。即使信息不足，也给出最可能的答案，并在 confidence 里如实给出 0~1 的把握程度，禁止拒绝回答或返回空答案。',
  '7. 不要输出题干之外编造的内容；选项里没有的说法不要写进答案。',
  '8. 输出字段固定为：answer、confidence、reason（reason 不超过 40 字，便于人工复核）。',
].join('\n');

const TYPE_LABEL = {
  single: '单选题',
  multiple: '多选题',
  judgement: '判断题',
  completion: '填空题',
  short: '简答题',
  unknown: '未知题型',
};

function schemaHint(type) {
  switch (type) {
    case 'multiple':
      return '{"answer":["A","C"],"confidence":0.9,"reason":"判断依据"}';
    case 'judgement':
      return '{"answer":"对","confidence":0.95,"reason":"判断依据"}';
    case 'completion':
      return '{"answer":["第一空","第二空"],"confidence":0.8,"reason":"判断依据"}';
    case 'short':
      return '{"answer":"要点一；要点二；要点三","confidence":0.7,"reason":"判断依据"}';
    case 'single':
    default:
      return '{"answer":"B","confidence":0.9,"reason":"判断依据"}';
  }
}

function formatOptions(options = []) {
  return options
    .map((opt, i) => {
      const label = opt.label || String.fromCharCode(65 + i);
      const text = String(opt.text || '').replace(/\s+/g, ' ').trim();
      return `${label}. ${text}`;
    })
    .join('\n');
}

/**
 * @param {{type:string, stem:string, options?:{label?:string,text:string}[], blanks?:number, images?:string[]}} q
 * @param {{subject?:string, blankHint?:boolean}} opts
 */
export function buildQuestionPrompt(q, opts = {}) {
  const type = q.type || 'unknown';
  const lines = [];
  if (opts.subject) lines.push(`【课程/科目】${opts.subject}`);
  lines.push(`【题型】${TYPE_LABEL[type] || '未知题型'}`);
  lines.push(`【题干】${String(q.stem || '').trim()}`);
  if (q.options && q.options.length) {
    lines.push('【选项】');
    lines.push(formatOptions(q.options));
  }
  if (type === 'completion') {
    const n = Number(q.blanks || 0);
    lines.push(n > 0 ? `【空格数量】${n} 个空，请返回 ${n} 个答案` : '【空格数量】未知，请按题干顺序返回字符串数组');
  }
  if (type === 'multiple') lines.push('【提示】本题为多选题，通常有 2~4 个正确选项，不要只给一个。');
  if (q.images && q.images.length) {
    lines.push(`【说明】题干包含图片（${q.images.length} 张），你无法直接查看图片，请依据文字部分与常识给出最可能答案。`);
  }
  lines.push('');
  lines.push('请严格按此 JSON 结构输出：');
  lines.push(schemaHint(type));
  return lines.join('\n');
}

export function buildMessages(question, opts = {}) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildQuestionPrompt(question, opts) },
  ];
}

/** 模型没按 JSON 输出时，追加一轮「纠正」对话，比整题重问更省 token */
export function buildRepairMessages(messages, rawOutput, errorMessage) {
  return [
    ...messages,
    { role: 'assistant', content: String(rawOutput || '').slice(0, 1200) },
    {
      role: 'user',
      content: [
        `你上面的输出无法被解析（${errorMessage}）。`,
        '现在只输出一个合法 JSON 对象，不要任何其它字符：',
        '{"answer":...,"confidence":0~1,"reason":"..."}',
      ].join('\n'),
    },
  ];
}
