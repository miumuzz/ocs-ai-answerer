# OCS AI 题库（本地服务版）

给 [OCS 网课助手](https://github.com/ocsjs/ocsjs) 加一个**用你自己大模型 API 答题**的题库。

不买题库、不搭云服务器、不改 OCS：在本机起一个只监听 `127.0.0.1` 的小服务，OCS 把题目发过来，服务调用你的模型，把答案按 OCS 的格式还回去。

```
OCS ──POST http://127.0.0.1:8787/answer──▶ 本地服务 ──▶ 大模型 API
     ◀── {question, answer} ─────────────────────────────┘
```

- **零依赖**：只用 Node 内置模块，不用 `npm install`
- **零配置服务器**：双击 `start.bat` 就有配置页，填 API 即可
- **不碰浏览器**：不注入脚本、不改 `fetch`、不需要 `@connect`，不存在 `Failed to fetch`
- **支持**：单选、多选、判断、填空（含多空）；连线/完形/阅读理解会返回「未搜到」，交给 OCS 其它题库或人工

> 只支持 OCS 的题库接口，不修改 OCS 本体。OCS 负责刷课、点选项、翻页、提交，这个服务只负责出答案。

---

## 快速开始

### 1. 装 Node.js（只需一次）

到 <https://nodejs.org/> 下载 **LTS**（18 以上），一路「下一步」。

### 2. 启动

**Windows：双击 `server/start.bat`**

其他系统：

```bash
node server/ocs-ai-server.mjs
# 换端口：node server/ocs-ai-server.mjs --port=8788
# 不自动开浏览器：--no-open
```

看到这样的输出就好了（黑窗口别关，关了服务就停）：

```
  OCS AI 题库 已启动
  面板： http://127.0.0.1:8787/
  题库地址： http://127.0.0.1:8787/answer
  停止： Ctrl + C
```

### 3. 配置 API

浏览器打开 <http://127.0.0.1:8787/>：

1. 选服务商（自动带出地址和模型），或手动填
2. **地址、Key、模型三者要匹配**（见下表）
3. 点「测试连接」，显示 `连接成功 · 832ms · deepseek-chat` 即通
4. 点「保存」→ 写入 `server/config.json`（本机文件，已被 `.gitignore` 排除）

| 服务商 | 地址（base URL） | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 智谱 | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 通义 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5:7b` |

> 任何 OpenAI 兼容接口都行，包括中转站；只需要 base URL + Key + 模型名。

### 4. 接进 OCS

配置页点 **「复制 OCS 题库配置」**，然后：

OCS 面板 → **通用 → 全局设置 → 题库配置** → 粘贴 → 保存。

```json
[
  {
    "name": "AI 答题（本地服务）",
    "homepage": "http://127.0.0.1:8787/",
    "url": "http://127.0.0.1:8787/answer",
    "method": "post",
    "type": "fetch",
    "responseType": "json",
    "headers": { "Content-Type": "application/json" },
    "data": { "title": "${title}", "options": "${options}", "type": "${type}" },
    "handler": "return (res) => (res && res.answer ? [res.question, res.answer] : undefined)"
  }
]
```

- OCS 弹「域名不在白名单」的警告：**点确定忽略**。那条检查只针对 `GM_xmlhttpRequest`，本地服务走的是普通 fetch。
- 改端口后，JSON 里的 `url` 也要跟着改。

### 5. 开始

回到作业页，让 OCS 开始答题。黑窗口会实时打印：

```
[12:45:01] ✓ 新时代党中央创造性提出… → A (1832ms)
[12:45:04] ✓ 下列属于水果的有？ → A. 苹果===C. 香蕉 (2104ms)
[12:45:06] ✗ 连线题… · 暂不支持的题型：line
```

---

## 工作原理

1. OCS 把当前题拼成 `{ title, options, type }`，POST 到 `http://127.0.0.1:8787/answer`
2. 服务用内置提示词请求你的模型，要求只返回 JSON：`{"answer":"B","confidence":0.9}`
3. 解析 JSON（带容错：代码块、尾逗号、中文引号、散文兜底），把答案对齐到 OCS 发来的选项文本
4. 返回 `{ question, answer }`，由 OCS 自己点选项 / 填框 / 翻页

答案格式（关键）：

| 题型 | 返回什么 | 例子 |
| --- | --- | --- |
| 单选 | **选项原文**（不是字母） | `B. 北京` |
| 多选 | 选中的选项原文，用 `===` 连接 | `A. 苹果===C. 香蕉` |
| 判断 | 选项里的「对/错」原文，找不到就 `对`/`错` | `对` |
| 填空 | 各空答案用 `===` 连接 | `北京===上海` |
| 不支持 | 返回 `{}`，OCS 视为「未搜到」 | — |

选择「选项原文」而不是字母，是因为 OCS 的匹配器优先按选项文本归一化比对，回显它自己发来的那串文本命中率最高。

---

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 配置页（填 API、测试、复制题库配置） |
| POST | `/config` | 保存 `{baseUrl, apiKey, model, subject, temperature, maxTokens}` |
| POST | `/test` | 用当前配置发一次最小请求，验证 Key/地址/模型 |
| POST | `/answer` | OCS 题库接口：`{title, options, type}` → `{question, answer}` |
| GET | `/health` | `{ok, configured, model, baseUrl}` |
| GET | `/wrapper.json` | 当前端口对应的 OCS 题库配置 |

安全：

- 只监听 `127.0.0.1`，局域网和外网访问不到
- API Key 只写在本机 `server/config.json`，不上传、不写日志
- 无遥测、无第三方请求（除了你自己配置的模型接口）
- 服务没有鉴权，同机其它程序也能调用 —— 本地工具的常态，介意就关掉窗口

---

## 排错

| 现象 | 处理 |
| --- | --- |
| 双击 bat 报一堆「不是内部或外部命令」 | 旧版 bat 换行/编码问题，用仓库里的纯 ASCII + CRLF 版本 |
| 双击一闪而过 | 没装 Node。命令行执行 `node -v` 确认 |
| `Node.js 版本太旧` | 装 LTS（18+） |
| 端口被占用 | 已经开着一个了；或 `start.bat --port=8788` 换端口（题库 url 同步改） |
| 浏览器打不开 `127.0.0.1:8787` | 服务没起来，看黑窗口报错 |
| OCS 报 `Failed to fetch` | 确认服务在跑（浏览器开 `/health`）；确认题库 `url` 是 `http://` 且端口一致 |
| OCS 报题库请求超时 | 服务端单次 AI 25 秒、不重试；换更快模型或调小 `max_tokens`（`config.json` 里的 `timeout` 也可改） |
| 大量「未作答」 | 看黑窗口 `✗` 行：`401` 是 Key/余额；`模型没有返回可解析的答案` 换更强模型；`匹配不到选项` 多半是选项被平台做成图片 |
| 答案不准 | 填「科目」；换更强的模型；降低 `temperature` |

---

## 开发

```bash
npm test          # 61 个测试，零依赖（node:test）
npm start         # 等同 node server/ocs-ai-server.mjs
```

测试覆盖：文本归一化与相似度、答案↔选项匹配、模型输出容错解析、OpenAI 兼容客户端（含 401/JSON 模式降级）、本地服务全部路由与 CORS 预检、OCS 题库配置生成。

不想用 `start.bat` 的话，`node server/ocs-ai-server.mjs` 效果一样。

### 目录

```
.
├── server/
│   ├── start.bat            Windows 双击启动
│   ├── ocs-ai-server.mjs    HTTP 服务 + 配置页（零依赖）
│   ├── config.example.json  配置示例（手动改配置时参考）
│   └── config.json          你的配置（首次保存生成，已 gitignore）
├── src/
│   ├── answerer.js          {title,options,type} → AI → OCS 答案格式
│   ├── constants.js         答案分隔符
│   ├── config.js            默认配置、服务商预设
│   ├── match.js             答案 ↔ 选项匹配（字母/文本/位置）
│   ├── bank.js              答案缓存（服务端用内存实现）
│   ├── store.js             GM/localStorage 兜底存储（浏览器场景复用）
│   ├── ai/
│   │   ├── client.js        OpenAI 兼容请求、重试、错误人话化
│   │   ├── prompt.js        系统提示词
│   │   └── parse.js         JSON 容错解析
│   ├── net/request.js       GM_xmlhttpRequest / fetch 封装
│   └── util/{text,misc}.js  文本工具
└── tests/                   node:test
```

### 加新题型 / 改提示词

- 提示词：`src/ai/prompt.js`
- 答案格式与题型映射：`src/answerer.js` 的 `normalizeType` / `toOcsAnswer`
- 想支持连线题：OCS 的 `line` 题型需要按 DOM 顺序给配对，可以在 `toOcsAnswer` 里加分支，返回 `A===B===C` 形式，并在 OCS 侧确认解析

---

## 题库是什么？

**题库 = 「题目 → 答案」的数据库 + 查询接口**，本质是查表；大模型是现场推理。

| | 题库 | 大模型 |
| --- | --- | --- |
| 命中时 | 接近 100% 准 | 80~95%，会一本正经胡说 |
| 覆盖 | 只覆盖收录过的题 | 任何题都能答 |
| 成本 | 按次/按月买 | 按 token，1000 题约一块钱 |
| 风险 | 题库可能过期、来源存疑 | 图片题、乱码题抓瞎 |

本项目就是把「大模型」包装成 OCS 眼里的一个题库，所以它和真题库可以同时存在：OCS 会把多个题库的答案都收上来，再按自己的匹配算法择优。

---

## 已知限制

- 图片题：纯文本模型看不到图，只能按选项文字猜
- 连线题 / 完形填空 / 阅读理解：不处理，返回「未搜到」
- 超星字体加密题（题干显示为方块/私有区字符）：无法识别，建议手动
- 服务是单进程内存缓存，重启后缓存清空
- 没有做 HTTPS / 鉴权，仅限本机使用

---

## 许可

MIT。见 [LICENSE](LICENSE)。

OCS 的 answer-wrapper 协议（`AnswererWrapper`、`handler` 字符串、`${title}` 占位符）参考了 [ocsjs/ocsjs](https://github.com/ocsjs/ocsjs)（MIT）的公开源码，本项目的实现代码为独立编写。

本项目仅供学习与自测使用。请遵守所在学校的学术诚信规定，使用风险自负。
