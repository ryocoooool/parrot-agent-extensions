/**
 * parrot-translate — Claude 的英文回复自动翻成配置的目标语言；发出的提示词保证是地道英文。
 *
 * 行为：回复稳定约 1.5s 后后台翻好缓存；/translate（可绑快捷键）在三种显示方式间切换，
 * 同时作用于用户消息和回复：双语对照（逐段穿插 `> ` 译文）/ 只显示你的语言 / 只显示英文。
 * 出站：prompt.submit 时把提示词改写成英文（其他语言忠实翻译；英文只修语法，
 * 不改意思），模型与 transcript 收到的都是英文；用户消息行渲染成双语对照。
 * 粘贴的技术性内容（错误信息/堆栈/JSON/日志/diff）两侧都不送翻，原样放行。
 * 实时预览：输入含外文时停顿 0.8s 后台翻译，输入框上方显示可编辑的英文（ctrl+x tab 进入）；
 * 回车发出的就是这份英文（含手改），不再二次请求。
 *
 * 翻译服务（/config 里换，见 plugin.json 的 userConfig）：
 *  - microsoft（默认）：Edge 免费接口（与 parrot 扩展同款），无需 key
 *  - session：$.model.complete 走本会话凭证跑一次独立补全（默认 haiku），免配置、质量更好、耗 token
 *  - openai：OpenAI 兼容接口（本地 llama.cpp 等）
 *
 * 注：hooks module 只能 import 相对路径和 "claude-code"，所以没有外部依赖。
 */
const MAX_CHARS = 3000 // 单次请求的字符上限（微软同款留余量；出站超长段也按它切块）
const MODEL_TIMEOUT = 30_000
const MAX_TOKENS = 16_000 // 单次补全输出上限：3000 字符块的重写远用不满，防静默截断
const MAP_CAP = 500 // cache / outboundMap 条目上限（FIFO 淘汰最旧，防长会话无限增长）

/** userConfig 传入的配置（register 时初始化） */
const cfg = { display: 'both', outbound: true, lang: 'zh-Hans', provider: 'microsoft', model: 'haiku', baseUrl: 'http://127.0.0.1:8021/v1', apiKey: '', livePreview: true, liveDelay: 1500 }

/**
 * 页面显示方式（/translate 循环切换；初始值来自 display 配置），用户消息与回复共用：
 *  - both：双语对照（用户消息：原文 + 发出的英文；回复：英文 + 译文）
 *  - native：只显示你的语言（用户消息：原文；回复：译文）
 *  - english：只显示英文（模型实际看到的内容）
 */
const DISPLAY_MODES = ['both', 'native', 'english']
let mode = 'both'
const modeLabel = (m) => m === 'both' ? '双语对照' : m === 'english' ? '只显示英文' : /^zh/i.test(cfg.lang) ? '只显示中文' : `只显示${langName()}`

/** 原文 -> { state: 'pending'|'done'|'skip'|'error', md?, native? }，按消息块缓存 */
const cache = new Map()

/** 发出的英文 -> 用户原话：UserMessage 渲染层做双语对照（不落盘、不进上下文） */
const outboundMap = new Map()

/** Map.set + FIFO 上限。代价：滚回很早的消息会丢缓存（回复侧重翻一次）或丢双语对照（回落英文行） */
function putCapped(map, key, val) {
  if (!map.has(key) && map.size >= MAP_CAP) map.delete(map.keys().next().value)
  map.set(key, val)
}

function putOutboundMap(en, orig) {
  const old = outboundMap.get(en)
  if (old === undefined) {
    putCapped(outboundMap, en, orig)
  } else if (old !== orig) {
    // 渲染层只给文本、不给稳定 message id；同一英文来自不同原文时无法安全归属。
    // 标成 ambiguous，避免把旧消息重标成最新原文。
    putCapped(outboundMap, en, null)
  }
}

/**
 * 防抖调度：流式期间每次渲染都会重置 1.5s 计时器，文本稳定（流结束）后才真正去翻。
 * 不依赖 turn.start/turn.complete —— 实测它们不一定触发，一旦不触发整条管线就死掉。
 */
let stableTimer = null
const seen = new Set() // 待调度的原文（一次稳定后批量调度）

/* ---------------- 目标语言（用户语言，/config 可换） ---------------- */

/** 常见微软语言码 -> 英文名（提示词用）；不在表里就直接用码本身 */
const LANG_NAMES = {
  'zh-Hans': 'Simplified Chinese', 'zh-Hant': 'Traditional Chinese',
  en: 'English', ja: 'Japanese', ko: 'Korean', fr: 'French', de: 'German',
  es: 'Spanish', it: 'Italian', pt: 'Portuguese', ru: 'Russian', ar: 'Arabic',
  hi: 'Hindi', th: 'Thai', vi: 'Vietnamese', id: 'Indonesian', tr: 'Turkish',
  nl: 'Dutch', pl: 'Polish', uk: 'Ukrainian',
}
const langName = () => LANG_NAMES[cfg.lang] ?? cfg.lang
/** 同一语言（比主子标签：zh-Hans 与 zh-Hant 都算 zh） */
const sameLang = (a, b) =>
  !!a && !!b && String(a).toLowerCase().split('-')[0] === String(b).toLowerCase().split('-')[0]

/* ---------------- 微软（Edge 免费接口，同 parrot microsoft.ts） ---------------- */

/* 宿主有时会把 JSON 响应预解析成对象塞进 text（类型声明说是 string，别信）；两头都兼容 */
function parseBody(res) {
  return typeof res.text === 'string' ? JSON.parse(res.text) : res.text
}

async function msFetch($, text, to = cfg.lang) {
  const qs = new URLSearchParams({ from: '', to, isEnterpriseClient: 'false' })
  const res = await $.http.fetch(`https://edge.microsoft.com/translate/translatetext?${qs}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([text]),
  })
  if (!res.ok) throw new Error(`microsoft HTTP ${res.status}`)
  const body = parseBody(res)
  if (!Array.isArray(body) || body.length !== 1) throw new Error('microsoft bad response')
  const out = body[0].translations?.[0]?.text
  if (typeof out !== 'string' || !out.trim()) throw new Error('microsoft empty translation')
  return { out, from: body[0].detectedLanguage?.language ?? '' }
}

/* ---------------- 模型（$.model.complete，走本会话凭证） ---------------- */

const MODEL_SYSTEM = () =>
  `Translate the user message into ${langName()}. ` +
  'Preserve the markdown structure exactly: lists, headings, tables, inline code, emphasis, links. ' +
  'Keep code, identifiers, file paths, commands and URLs unchanged. ' +
  `If the message is already entirely in ${langName()}, return it exactly unchanged. ` +
  'Return ONLY the translation, no preamble, no notes.'

async function modelFetch($, text, system) {
  const r = await $.model.complete({
    model: cfg.model,
    system: system ?? MODEL_SYSTEM(),
    prompt: text,
    maxTokens: MAX_TOKENS,
    timeoutMs: MODEL_TIMEOUT,
  })
  if (!r.isAnswered) throw new Error(`model did not answer (${r.reason ?? 'unknown'})`)
  return { out: r.text.trim(), from: '' }
}

/* ---------------- OpenAI 兼容（本地 llama.cpp / 远端兼容服务） ---------------- */

const OPENAI_SYSTEM = () =>
  `Translate into ${langName()}. Keep code, identifiers, file paths, commands and URLs unchanged. ` +
  `If it is already entirely in ${langName()}, return it exactly unchanged. ` +
  'Preserve the markdown structure. Return ONLY the translation.'

/** 剥掉推理模型可能带的 <think>...</think>（哪怕为空） */
function stripThink(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
}

async function openaiFetch($, text, system) {
  const base = cfg.baseUrl.replace(/\/+$/, '')
  const payload = JSON.stringify({
    model: cfg.model,
    stream: false,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system ?? OPENAI_SYSTEM() },
      { role: 'user', content: text },
    ],
  })
  // 宿主的 $.http.fetch 连 localhost 会被 reset（SSRF 防护），curl 直连没问题
  const args = ['curl', '-s', '--max-time', '120', '-X', 'POST', `${base}/chat/completions`,
    '-H', 'Content-Type: application/json', '--data-binary', payload]
  if (cfg.apiKey) args.push('-H', `Authorization: Bearer ${cfg.apiKey}`)
  const r = await $.process.run(args)
  if (r.exitCode !== 0) throw new Error(`openai curl exit ${r.exitCode}`)
  const body = JSON.parse(r.stdout)
  if (body?.choices?.[0]?.finish_reason === 'length') throw new Error('openai truncated (finish_reason=length)')
  const en = stripThink(String(body?.choices?.[0]?.message?.content ?? ''))
  if (!en) throw new Error('openai empty completion')
  return { out: en, from: '' }
}

/** 段落是否是 CJK 为主（zh 系目标翻译前先本地判断，省 token） */
function isMostlyZh(s) {
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length
  const letters = (s.match(/[A-Za-z]/g) || []).length
  return cjk > 0 && cjk >= letters
}

/**
 * 回复侧：段落是否已经是目标语言为主。只有 zh 系目标有可靠的本地判断（CJK 字符好数）；
 * 其他目标语言没有便宜的本地判断，交给接口的源语言检测 / 提示词的「已是目标语言
 * 则原样返回」约定（见 translateProse 的逐块比对）。
 */
function isMostlyTarget(s) {
  return /^zh/i.test(cfg.lang) ? isMostlyZh(s) : false
}

/**
 * 段落是否是「技术性粘贴」：错误信息、堆栈、JSON、日志、diff、十六进制/表格等。
 * 这些内容翻译/改写只会帮倒忙，两侧（出站与回复）都直接跳过；要百分之百确保
 * 原样，用 ``` 围栏包住（围栏在结构层就不送翻）。规则各自独立、偏保守，
 * 像散文的内容一条都不该命中。
 */
function looksTechnical(s) {
  const t = s.trim()
  if (!t) return false
  // JSON（或接近 JSON：粘贴时头尾缺行很常见）
  if (/^[[{]/.test(t)) {
    try { JSON.parse(t); return true } catch { /* 不完整，看下面的规则 */ }
    if ((t.match(/":\s/g) || []).length >= 2) return true
  }
  // 堆栈：JS 的 at fn (file:1:2) / Python 的 Traceback + File "...", line N
  if (/^\s*at\s+[\w$.#<>-]+\s*\(.*:\d+:\d+\)/m.test(t)) return true
  if (/Traceback \(most recent call last\)|File ".*", line \d+/.test(t)) return true
  // 日志行：时间戳或等级开头的行
  if (/^\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/m.test(t)) return true
  if (/^\[?(ERROR|WARN|WARNING|INFO|DEBUG|FATAL|CRITICAL|TRACE|NOTICE)[\]:]/m.test(t)) return true
  if (/^\[?(error|exception|panic)\]?:/im.test(t)) return true // Error:/Exception: 等常见报错前缀（标题大小写）
  if (/^npm (ERR!|WARN)/m.test(t)) return true
  // diff / patch
  if (/^(diff --git |@@ -\d+(,\d+)? \+\d+(,\d+)? @@|--- a\/|\+\+\+ b\/)/m.test(t)) return true
  // 符号密度：Unicode 字母/组合符号占非空白字符不到 35%。
  const ns = t.replace(/\s/g, '')
  const word = (ns.match(/[\p{L}\p{M}]/gu) || []).length
  return ns.length >= 40 && word / ns.length < 0.35
}

/* ---------------- 管线 ---------------- */

/** Preserve raw text while recognizing code relative to list and blockquote containers. */
function splitParas(text) {
  const paras = []
  const lists = new Map()
  let previousQuoteDepth = 0
  let prose = ""
  let code = ""
  let fence
  let indented
  const flushProse = () => {
    if (prose) paras.push({ text: prose })
    prose = ""
  }
  const flushCode = () => {
    if (code) paras.push({ code })
    code = ""
  }
  // Expand tabs only in the parsing view. The original bytes always form the output.
  const viewLine = (body, allowLists, maxQuotes = Infinity) => {
    let rest = ""
    for (const ch of body) rest += ch === "\t" ? " ".repeat(4 - rest.length % 4) : ch
    let quoteDepth = 0
    let listIndent = 0
    // Lists and quotes can alternate at any depth, e.g. "- > - ```".
    while (true) {
      let quote
      while (quoteDepth < maxQuotes && (quote = rest.match(/^ {0,3}> ?/))) {
        rest = rest.slice(quote[0].length)
        quoteDepth++
      }
      const stack = lists.get(quoteDepth) ?? []
      lists.set(quoteDepth, stack)
      const blank = !rest.trim()
      const indent = rest.match(/^ */)[0].length
      if (!blank) while (stack.length && stack[stack.length - 1] > indent) stack.pop()
      listIndent = stack[stack.length - 1] ?? 0
      let offset = 0
      let marker
      while (allowLists && (marker = rest.match(/^( *)([-+*]|\d{1,9}[.)])( +|$)/)) &&
        marker[1].length <= (offset ? 0 : listIndent) + 3) {
        const padding = marker[3].length > 4 ? 1 : marker[3].length || 1
        const width = marker[1].length + marker[2].length + padding
        offset += width
        listIndent = offset
        stack.push(listIndent)
        rest = rest.slice(width)
      }
      if (!offset) rest = rest.slice(listIndent)
      if (quoteDepth >= maxQuotes || !/^ {0,3}> ?/.test(rest)) break
    }
    if (quoteDepth < previousQuoteDepth) {
      for (const depth of lists.keys()) if (depth > quoteDepth) lists.delete(depth)
    }
    previousQuoteDepth = quoteDepth
    return { body: rest, quoteDepth, listIndent, blank: !rest.trim() }
  }
  const inContainer = (line, start) =>
    line.quoteDepth >= start.quoteDepth && (line.blank || line.listIndent >= start.listIndent)
  for (const raw of text.match(/[^\n]*(?:\n|$)/g)?.filter(Boolean) ?? []) {
    const body = raw.replace(/\r?\n$/, "")
    // Once code starts, further quote markers belong to its literal contents.
    let line = viewLine(body, !fence && !indented, (fence ?? indented)?.quoteDepth)
    if (fence) {
      if (inContainer(line, fence)) {
        code += raw
        if (fence.closing.test(line.body)) { flushCode(); fence = undefined }
        continue
      }
      flushCode()
      fence = undefined
      line = viewLine(body, true)
    }
    if (indented) {
      if (inContainer(line, indented) && (line.blank || /^ {4}/.test(line.body))) {
        code += raw
        continue
      }
      flushCode()
      indented = undefined
      line = viewLine(body, true)
    }
    const opening = line.body.match(/^ {0,3}(`{3,}|~{3,})(.*)$/)
    if (opening && !(opening[1][0] === "`" && opening[2].includes("`"))) {
      flushProse()
      code = raw
      fence = { ...line, closing: new RegExp(`^ {0,3}${opening[1][0]}{${opening[1].length},}[ ]*$`) }
    } else if (/^(`+)[^\n]*\1[ ]*$/.test(line.body)) {
      // Pi's Mermaid renderer emits standalone inline-code rows.
      flushProse()
      paras.push({ code: raw })
    } else if (!line.blank && /^ {4}/.test(line.body) && !prose.trim()) {
      code = raw
      indented = line
    } else if (line.blank) {
      flushProse()
      paras.push({ code: raw })
    } else {
      prose += raw
    }
  }
  flushProse()
  flushCode()
  return paras
}

/** 固定并发跑一批任务（worker 内部自行 try/catch，单条失败不外溢） */
async function runPool(items, size, worker) {
  let cursor = 0
  const run = async () => {
    while (cursor < items.length) await worker(items[cursor++])
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run))
}

/** Bound requests while retaining every separator and avoiding split surrogate pairs. */
function chunkParagraph(s, max = MAX_CHARS) {
  const chunks = []
  for (let start = 0; start < s.length;) {
    let end = Math.min(start + max, s.length)
    if (end < s.length) {
      const newline = s.lastIndexOf('\n', end - 1)
      const space = s.lastIndexOf(' ', end - 1)
      const boundary = newline >= start ? newline : space
      if (boundary >= start) end = boundary + 1
      else if (/[\uD800-\uDBFF]/.test(s[end - 1])) end--
    }
    chunks.push(s.slice(start, end))
    start = end
  }
  return chunks.length ? chunks : [s]
}

function preserveWhitespace(source, replacement) {
  return (source.match(/^\s*/)?.[0] ?? '') + replacement.trim() + (source.match(/\s*$/)?.[0] ?? '')
}

function quoteTranslation(text, translation) {
  const trailing = text.match(/\s*$/)?.[0] ?? ""
  return text.slice(0, text.length - trailing.length) + "\n\n" +
    translation.trimEnd().split("\n").map((line) => `> ${line}`).join("\n") + trailing
}

const fetchOne = ($, text, opts = {}) =>
  cfg.provider === 'session'
    ? modelFetch($, text, opts.system)
    : cfg.provider === 'openai'
      ? openaiFetch($, text, opts.system)
      : msFetch($, text, opts.to)

/** 一段散文按长度切块翻译；源语言已是目标语言的块原样保留 */
async function translateProse($, text) {
  if (looksTechnical(text)) return null
  if (cfg.provider !== 'microsoft' && isMostlyTarget(text)) return null

  const out = []
  let any = false
  for (const chunk of chunkParagraph(text)) {
    const r = await fetchOne($, chunk)
    // 微软的检测是逐请求返回的：只能跳过当前块，不能因为某一块是目标语言就跳过整段。
    if (cfg.provider === 'microsoft' && sameLang(r.from, cfg.lang)) {
      out.push(chunk)
      continue
    }
    // 模型判定「已是目标语言」会原样返回：该块保持原文、不算翻过
    if (r.out.trim() && r.out.trim() !== chunk.trim()) {
      out.push(preserveWhitespace(chunk, r.out))
      any = true
    } else {
      out.push(chunk)
    }
  }
  return any ? out.join('') : null
}

/**
 * 翻一个消息块，逐段穿插：每段原文下面直接跟它自己的 `> ` 译文；
 * 代码块/原始分隔符不送翻且原样拼回。返回 { md, errors }。
 * 全部跳过（已是目标语言/无散文）时 md 为 null。
 * 段落并行翻（并发 4）：本地 llama.cpp 有连续 batching，串行会让长回复等几十秒。
 */
async function translateBlock($, text) {
  const paras = splitParas(text)
  await runPool(paras, 4, async (p) => {
    if (p.text === undefined) return
    try {
      const translation = await translateProse($, p.text)
      if (translation) p.translation = translation
    } catch (err) {
      p.error = err
      diag($, `translate paragraph error len=${p.text.length}: ${String((err && err.message) || err).slice(0, 150)}`)
    }
  })

  const errors = paras.filter((p) => p.error).length
  if (!paras.some((p) => p.translation)) return { md: null, native: null, errors }
  // md 双语逐段穿插；native 只留译文（没译的段——已是目标语言/技术内容/失败——保留原文）
  const md = paras.map((p) => p.code ?? p.separator ?? (p.translation ? quoteTranslation(p.text, p.translation) : p.text)).join('')
  const native = paras.map((p) => p.code ?? p.separator ?? p.translation ?? p.text).join('')
  return { md, native, errors }
}

/* ---------------- 出站：保证发给模型的一定是英文 ---------------- */

const OUT_UNCHANGED_INSTRUCTION =
  'If nothing needs changing, return the original text exactly unchanged. Never replace it with an assessment such as "No changes are needed". '

const OUT_MODEL_SYSTEM = () =>
  'The message is a prompt on its way to a coding agent. Rewrite it into natural, grammatically correct English: ' +
  'if it is in another language, translate it faithfully without changing the meaning; if it is already in English, ' +
  'fix only grammar, spelling and typography errors. Never change the meaning, tone or technical content. ' +
  `The author's first language is ${langName()}; keep the English plain and idiomatic. ` +
  'Preserve the markdown structure; keep code, identifiers, file paths, commands, flags and URLs unchanged. ' +
  OUT_UNCHANGED_INSTRUCTION +
  'Return ONLY the rewritten text, no preamble, no notes.'

const OUT_OPENAI_SYSTEM = () =>
  'Rewrite the prompt into natural, grammatically correct English: translate it faithfully if it is in another ' +
  'language, or fix only grammar/spelling/typo errors if it is already English. Never change the meaning. ' +
  `The author's first language is ${langName()}. ` +
  'Keep code, identifiers, file paths, commands and URLs unchanged. Preserve the markdown structure. ' +
  OUT_UNCHANGED_INSTRUCTION + 'Return ONLY the rewritten text.'

/** 数非拉丁字母（任意文字系统），出站校验用 */
function nonLatinLetterCount(s) {
  const prose = s.replace(/(`+)[\s\S]*?\1|“[^”]*”|‘[^’]*’|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '')
  return (prose.match(/(?!\p{Script=Latin})\p{L}/gu) ?? []).length
}

const asciiTokens = (s) => s.toLowerCase().match(/[a-z0-9]+(?:'[a-z0-9]+)?/g) || []

const EN_FUNCTION_WORDS = new Set([
  'the', 'this', 'that', 'these', 'those', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'to', 'of',
  'and', 'with', 'for', 'it', 'you', 'your', 'my', 'please',
])

/** 保守英文判断：函数词至少两个，或常见编程祈使句/问候。避免把法/西等拉丁语言套英文重合约束。 */
function isLikelyEnglish(s) {
  const tokens = asciiTokens(s)
  let hits = 0
  for (const t of tokens) if (EN_FUNCTION_WORDS.has(t) && ++hits >= 2) return true
  const t = s.trim().toLowerCase()
  return /^(please\s+)?(fix|check|review|implement|add|remove|update|explain|translate|write|show|help|hello|hi)\b/.test(t)
}

function hasMetaPreamble(output) {
  return /^(?:(?:sure[,!.]?\s+)?here(?:'s| is) (?:the |your )?(?:translation|rewritten|corrected|revised)(?: text| prompt)?\s*:|(?:the|your) (?:(?:provided|given|input|original) )?(?:text|prompt|message|sentence) (?:contains|is (?:already|grammatically|correct|natural))|no (?:changes|corrections|edits) (?:are |were )?(?:needed|required|necessary))/i.test(output.trim())
}

/**
 * 出站改写结果校验：翻译服务可能不翻译、只做源语言润色，或返回元评论。
 * 只有输出真的像「这段话的英文改写」才认：
 *  - 任意非拉丁输入/混合输入 → 输出的非拉丁字母须降到一半以下，且包含 ASCII 英文字母；
 *  - 可能是英文且不含非拉丁正文的输入 → 输出须与输入按完整 token 多重集至少重合一半，长度在合理范围；
 *  - 其他拉丁源语言不套英文重合约束，允许法/西/德等正确翻译成英文时零重合。
 */
function okRewrite(input, output) {
  const inp = input.trim()
  const out = output.trim()
  if (!out) return false
  const foreign = nonLatinLetterCount(inp)
  const resultForeign = nonLatinLetterCount(out)
  if (foreign ? resultForeign >= Math.max(1, foreign / 2) : resultForeign > 0) return false
  const code = inp.match(/(`+)[\s\S]*?\1/g) ?? []
  if (code.some(span => !out.includes(span))) return false
  if (inp === out) return true
  if (!/[A-Za-z]/.test(out)) return false
  if (hasMetaPreamble(out)) return false

  // Translating foreign prose can add English words beyond the original ASCII prefix.
  if (foreign || !isLikelyEnglish(inp)) return true
  const ti = asciiTokens(inp)
  if (ti.length === 0) return true
  const to = asciiTokens(out)
  const counts = new Map()
  for (const t of ti) counts.set(t, (counts.get(t) || 0) + 1)
  let hit = 0
  for (const t of to) {
    const n = counts.get(t) || 0
    if (n > 0) {
      hit++
      counts.set(t, n - 1)
    }
  }
  // 修语法是轻改：词重合要过半，词数也得在 0.6–1.5 倍之间（元评论动辄长出三倍）
  return hit / ti.length >= 0.5 && to.length >= ti.length * 0.6 && to.length <= ti.length * 1.5
}

/** 校验失败重试：用明确系统提示分开「翻译成英文」和「只修英文语法」，不复用首轮混合提示。 */
const OUT_TRANSLATE_RETRY_SYSTEM = () =>
  'Translate the user message into English faithfully. Do not polish it in the source language. ' +
  'Preserve markdown structure, code, identifiers, file paths, commands, flags and URLs unchanged. ' +
  OUT_UNCHANGED_INSTRUCTION + 'Return ONLY the English translation, no preamble, no notes.'

const OUT_GRAMMAR_RETRY_SYSTEM = () =>
  'Fix only grammar, spelling and typography errors in this English prompt. Do not translate, explain, summarize or add notes. ' +
  'Preserve markdown structure, code, identifiers, file paths, commands, flags and URLs unchanged. ' +
  OUT_UNCHANGED_INSTRUCTION + 'Return ONLY the corrected text.'

/** Hide file mentions from providers, including quoted paths containing spaces. */
function protectFileReferences(text) {
  let prefix = 'PARROT_FILE_REF_'
  while (text.includes(prefix)) prefix = '_' + prefix
  const refs = []
  const masked = text.replace(/(?<![\p{L}\p{N}_@])@(?:"(?:\\.|[^"\r\n])*"|'(?:\\.|[^'\r\n])*'|[^\s`"'<>()[\]{},;!?，。；！？、]+)/gu, (match) => {
    // Sentence punctuation is not part of an unquoted path.
    const ref = /^@["']/.test(match) ? match : match.replace(/[.:]+$/, '')
    if (ref.length < 2) return match
    const token = '`' + prefix + refs.length + '`'
    refs.push({ token, ref })
    return token + match.slice(ref.length)
  })
  return { masked, restore(output) {
    const tokens = output.match(new RegExp('`' + prefix + '\\d+`', 'g')) ?? []
    if (tokens.length !== refs.length || tokens.some((token, i) => token !== refs[i].token)) {
      throw new Error('outbound rewrite changed file references')
    }
    return output.replace(new RegExp('`' + prefix + '\\d+`', 'g'), token => refs.find(ref => ref.token === token).ref)
  } }
}

/** Rewrite outbound prose while restoring file mentions exactly. */
async function ensureEnglishProse($, text) {
  const protectedText = protectFileReferences(text)
  const result = await rewriteEnglishProse($, protectedText.masked)
  return result === null ? null : protectedText.restore(result)
}

async function rewriteEnglishProse($, text) {
  if (looksTechnical(text)) return null // 粘贴的错误信息/JSON/日志等原样放行
  if (cfg.provider === 'microsoft') {
    // 超长段按行边界切块逐块送翻；检测出英文的块只保留该块（免费接口没有语法检查能力）
    const out = []
    let any = false
    for (const chunk of chunkParagraph(text)) {
      const r = await msFetch($, chunk, 'en')
      if (/^en(-|$)/i.test(r.from) && !nonLatinLetterCount(chunk)) {
        out.push(chunk)
        continue
      }
      const en = r.out.trim()
      if (!okRewrite(chunk, en)) throw new Error('microsoft did not return an English translation')
      if (en !== chunk.trim()) { out.push(preserveWhitespace(chunk, en)); any = true } else out.push(chunk)
    }
    return any ? out.join('') : null
  }
  const system = nonLatinLetterCount(text)
    ? OUT_TRANSLATE_RETRY_SYSTEM()
    : cfg.provider === 'session' ? OUT_MODEL_SYSTEM() : OUT_OPENAI_SYSTEM()
  const out = []
  let any = false
  for (const chunk of chunkParagraph(text)) {
    const likelyEnglish = isLikelyEnglish(chunk)
    let en = (await fetchOne($, chunk, { system })).out.trim()
    // 不认的改写：输出还是源语言（只润色没翻译）、非拉丁原样返回、英文输入收到元评论。
    // 用明确系统提示重试一次，仍不过就放行该段原文——绝不让废话冒充英文发出。
    const invalid = (candidate) => !okRewrite(chunk, candidate)
    if (invalid(en)) {
      diag($, `outbound suspect in="${chunk.slice(0, 40)}" out="${en.slice(0, 40)}"`)
      const retrySystem = likelyEnglish && nonLatinLetterCount(chunk) === 0 ? OUT_GRAMMAR_RETRY_SYSTEM() : OUT_TRANSLATE_RETRY_SYSTEM()
      const retry = (await fetchOne($, chunk, { system: retrySystem })).out.trim()
      if (retry && !invalid(retry)) {
        en = retry
        diag($, `outbound retry ok out="${retry.slice(0, 40)}"`)
      } else {
        diag($, `outbound retry failed; fallback original len=${chunk.length}`)
        throw new Error('outbound retry did not return an English rewrite')
      }
    }
    if (en && en !== chunk.trim()) { out.push(preserveWhitespace(chunk, en)); any = true } else out.push(chunk)
  }
  return any ? out.join('') : null
}

/** 出站整块：代码/分隔符不动，散文段并发处理；返回 { text, changed, errors }（没改动时 text 即原文） */
async function outboundBlock($, text) {
  const paras = splitParas(text)
  await runPool(paras, 4, async (p) => {
    if (p.text === undefined) return
    try {
      const en = await ensureEnglishProse($, p.text)
      if (en) p.en = preserveWhitespace(p.text, en)
    } catch (err) {
      p.error = err
      diag($, `outbound paragraph error len=${p.text.length}: ${String((err && err.message) || err).slice(0, 150)}`)
    }
  })

  let any = false
  let errors = 0
  const out = paras.map((p) => {
    if (p.code !== undefined) return p.code
    if (p.separator !== undefined) return p.separator
    if (p.error) errors++
    if (p.en) any = true
    return p.en ?? p.text
  }).join('')
  return { text: any ? out : text, changed: any, errors }
}

/** 诊断：写 /tmp/pt-live.log（只记关键转移，保留最近 60 条） */
const dbg = []
function diag($, msg) {
  dbg.push(`${new Date().toISOString().slice(11, 23)} ${msg}`)
  if (dbg.length > 60) dbg.shift()
  $.fs.write('/tmp/pt-live.log', dbg.join('\n') + '\n').catch(() => {})
}

function scheduleOne($, text) {
  if (cache.has(text)) return
  putCapped(cache, text, { state: 'pending' })
  diag($, `schedule len=${text.length}`)
  translateBlock($, text)
    .then(({ md, native, errors }) => {
      const state = md ? 'done' : errors ? 'error' : 'skip'
      putCapped(cache, text, { state, md, native, errors })
      diag($, `done len=${text.length} state=${state} errors=${errors}${md ? ' md=' + md.length : ''}`)
      if (mode !== 'english') {
        $.ui.invalidate('ui.render')
        if (state === 'done' && errors) $.ui.toast(`部分译文就绪（${errors} 段失败，见 /tmp/pt-live.log）`)
        else if (state === 'done') $.ui.toast('译文就绪')
        else if (state === 'error') $.ui.toast('翻译失败，见 /tmp/pt-live.log')
      }
    })
    .catch((err) => {
      putCapped(cache, text, { state: 'error', errors: 1 })
      diag($, `error len=${text.length}: ${String((err && err.message) || err).slice(0, 150)}`)
      if (mode !== 'english') $.ui.toast('翻译失败，见 /tmp/pt-live.log')
    })
}

/**
 * 审阅中的英文 { orig }：点「编辑英文」后英文替换了输入框里的草稿，orig 是原草稿。
 * 回车原样发出输入框里的英文（用户可能改过），不再二次改写
 */
let review = null

/* ---------------- 实时预览：输入时在输入框上方显示英文 ---------------- */

/** 停顿多久才翻（ms）：太短会在打字途中思考的间隙就去翻，预览跟着来回跳 */
const LIVE_DELAY_DEFAULT = 1500
/** 草稿 -> outboundBlock 结果 + state（done / same / error）；回车时命中就不再请求 */
const liveCache = new Map()
let liveDraft = '' // 正在预览的草稿；空 = 不显示
let liveLast = '' // 最近一次译好的英文：新译文出来前先显示它，免得闪烁
let liveTimer = null
let liveRunning = false
/** 「发送英文」经 $.prompt.submit 发出的文本：它的来源会被标成本插件，提交钩子据此改回用户本人 */
let reviewSending = null
/**
 * 上方区域是否握着键盘（在选按钮），只用来换提示语：焦点落到本插件的按钮上时置真。
 * Esc 交还键盘没有事件，所以握着期间每 300ms 探测一次（见 watchHold）
 */
let bandFocused = false
const BAND_KEYS = ['live-edit', 'review-revert', 'review-send', 'review-save']
let bandId = '' // 上方区域的 requestId，$.ui.focus 用
let lastFocusKey = '' // 焦点最近落在哪个按钮上
let holdTimer = null
let probing = false // 探测本身也会触发 ui.focus，钩子据此不把它当成用户操作
/** 探测用的、从不绘制的按钮名：握着键盘时引擎最多等 3 秒才拒绝，没握着时立刻拒绝 */
const PROBE_KEY = '__parrot_probe__'

/**
 * 上方区域还握着键盘吗：请求聚焦本插件的按钮，没握着时引擎拒绝（that site does not hold the keyboard）。
 * 用焦点当前所在的按钮探测：再聚焦一次原地不动、立刻有结果；不知道在哪个上就用从不绘制的 PROBE_KEY，握着时要等满 3 秒
 */
async function probeHold($, key) {
  if (!bandId) return true
  probing = true
  try {
    const r = await $.ui.focus({ requestId: bandId, key })
    return !/does not hold/.test(r?.deny ?? '')
  } catch {
    return true
  } finally {
    probing = false
  }
}

function drawnBandKeys() {
  if (review) return ['review-revert', 'review-send', 'review-save']
  return liveDraft && liveCache.get(liveDraft)?.state === 'done' ? ['live-edit'] : []
}

function setBandFocused($, focused) {
  if (focused === bandFocused) return
  bandFocused = focused
  $.ui.invalidate('ui.render')
  if (focused) watchHold($)
  else if (holdTimer) { holdTimer.cancel(); holdTimer = null }
}

function watchHold($) {
  if (holdTimer) holdTimer.cancel()
  holdTimer = $.clock.after(300, async () => {
    holdTimer = null
    if (!bandFocused) return
    const held = await probeHold($, drawnBandKeys().includes(lastFocusKey) ? lastFocusKey : PROBE_KEY)
    if (!bandFocused) return
    if (held) watchHold($)
    else setBandFocused($, false)
  })
}

/** 只预览含非拉丁文字的草稿（纯英文无需翻译）；斜杠命令不预览 */
function onDraftEdit($, text) {
  const wanted = cfg.livePreview && !text.trimStart().startsWith('/') && nonLatinLetterCount(text) ? text : ''
  if (wanted === liveDraft) return
  const wasShown = !!liveDraft
  liveDraft = wanted
  if (!wanted) liveLast = ''
  if (liveTimer) { liveTimer.cancel(); liveTimer = null }
  if (wanted && !liveCache.has(wanted)) armLive($)
  if (wanted || wasShown) $.ui.invalidate('ui.render')
}

function armLive($) {
  liveTimer = $.clock.after(cfg.liveDelay, () => { liveTimer = null; runLive($) })
}

/** 同一时间只跑一次翻译（省额度）；跑完草稿又变了就重新防抖 */
async function runLive($) {
  if (liveRunning || !liveDraft || liveCache.has(liveDraft)) return
  liveRunning = true
  const draft = liveDraft
  try {
    const r = await outboundBlock($, draft)
    const state = r.changed && r.text.trim() ? 'done' : r.errors ? 'error' : 'same'
    putCapped(liveCache, draft, { ...r, state })
    if (state === 'done' && liveDraft) liveLast = r.text
  } catch (err) {
    putCapped(liveCache, draft, { state: 'error' })
    diag($, `live error: ${String((err && err.message) || err).slice(0, 150)}`)
  } finally {
    liveRunning = false
  }
  if (draft === liveDraft) $.ui.invalidate('ui.render')
  else if (liveDraft && !liveCache.has(liveDraft) && !liveTimer) armLive($)
}

function clearLive($) {
  onDraftEdit($, '')
}

/** 「编辑英文」（ctrl+x tab 落到它上面即触发，或点击）：英文替换输入框里的草稿，直接在输入框里改；上方换成原文 + 三个按钮 */
async function startReview($) {
  const draft = liveDraft
  const r = liveCache.get(draft)
  if (!draft || r?.state !== 'done') return
  const filled = await $.prompt.fill({ text: r.text, mode: 'replace' })
  if (!filled.isFilled) return
  review = { orig: draft }
  clearLive($)
  $.ui.invalidate('ui.render')
  diag($, `review start len=${draft.length}`)
  // 从上方区域进来的：「编辑英文」没了，焦点放到默认的「恢复原文」上（位置确定，探测才不用等；误按回车也不会发出）
  if (bandFocused) {
    lastFocusKey = 'review-revert'
    if (!(await probeHold($, 'review-revert'))) setBandFocused($, false)
  }
}

/** 输入框里（改过的）英文；改的时候又写进了外文就先照常转成英文 */
async function reviewedEnglish($) {
  let text = (await $.prompt.read()).text
  if (text.trim() && nonLatinLetterCount(text)) {
    const r = await outboundBlock($, text).catch(() => null)
    if (r?.changed && r.text.trim()) text = r.text
  }
  return text
}

/** 「发送英文」：发出输入框里（改过的）英文 */
async function sendReview($) {
  if (!review) return
  const { orig } = review
  const text = await reviewedEnglish($)
  if (!text.trim() || !review) return
  review = null
  $.ui.invalidate('ui.render')
  await $.prompt.fill({ text: '', mode: 'replace' })
  if (text.trim() !== orig.trim()) putOutboundMap(text, orig)
  reviewSending = text
  diag($, `review send len=${text.length}`)
  await $.prompt.submit({ text }).catch((err) => {
    diag($, `review send error: ${String((err && err.message) || err).slice(0, 150)}`)
  })
}

/**
 * 「保存译文」：改过的英文存成这份草稿的译文，输入框换回原草稿，上方预览显示改后的英文；
 * 之后直接回车发出的就是它（草稿再改就重新翻译，回到同一份草稿仍用存下的译文）
 */
async function saveReview($) {
  if (!review) return
  const { orig } = review
  const text = await reviewedEnglish($)
  if (!text.trim() || !review) return
  review = null
  const prev = liveCache.get(orig)
  putCapped(liveCache, orig, { ...prev, text, changed: true, state: 'done', edited: true })
  await $.prompt.fill({ text: orig, mode: 'replace' })
  onDraftEdit($, orig)
  $.ui.invalidate('ui.render')
  $.ui.toast('译文已保存，回车发送')
  diag($, `review save len=${text.length}`)
}

/** 「恢复原文」：放弃英文和对它的修改，原草稿放回输入框（实时预览命中缓存，立刻显示英文） */
async function revertReview($) {
  if (!review) return
  const { orig } = review
  review = null
  await $.prompt.fill({ text: orig, mode: 'replace' })
  onDraftEdit($, orig)
  $.ui.invalidate('ui.render')
}

function renderLive($, e, next) {
  if (e.props?.hasSurvey) return next(e)
  bandId = e.requestId || bandId
  const { Box, Text, Button } = $.ui.resolve(e)
  if (review && Button) {
    // 英文已在输入框里改；上方显示原文对照。ctrl+x tab 后按数字键或回车选，桌面端直接点
    return h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true, wrap: 'wrap' }, `原文 ▸ ${review.orig}`),
      h(Box, { flexDirection: 'row', gap: 2 },
        // 默认（autoFocus、排第一）是「恢复原文」：最不会出错的选项
        h(Button, { key: 'review-revert', label: '恢复原文', hotkey: '1', plain: true, autoFocus: true, onPress: () => { void revertReview($) } }),
        h(Button, { key: 'review-send', label: '发送英文', hotkey: '2', plain: true, onPress: () => { void sendReview($) } }),
        h(Button, { key: 'review-save', label: '保存译文', hotkey: '3', plain: true, onPress: () => { void saveReview($) } }),
        h(Text, { dimColor: true }, bandFocused ? 'Esc 回输入框修改' : 'ctrl+x tab 选择')))
  }
  if (!liveDraft) return next(e)
  const draft = liveDraft
  const r = liveCache.get(draft)
  if (r?.state === 'done' && Button) {
    // 只读，完整显示自动换行，方便和草稿逐句对照
    return h(Box, { flexDirection: 'column' },
      h(Text, { wrap: 'wrap' }, `EN ▸ ${r.text}${r.errors ? `（${r.errors} 段翻译失败，保留原文）` : ''}`),
      h(Box, { flexDirection: 'row', gap: 2 },
        h(Button, { key: 'live-edit', label: '编辑英文', plain: true, autoFocus: true, onPress: () => { void startReview($) } }),
        h(Text, { dimColor: true }, 'ctrl+x tab 编辑 · 直接回车即发送这段英文')))
  }
  const body = !r ? (liveLast ? `${liveLast} …` : '翻译中…')
    : r.state === 'done' ? r.text
      : r.state === 'same' ? '（无需翻译，原样发送）' : '（英文预览失败，见 /tmp/pt-live.log）'
  // 各状态都是两行，翻译中 <-> 译好来回切时预览框高度不变，不会上下跳
  const status = !r ? (liveLast ? '草稿有改动，停顿后更新英文' : '停顿后翻译') : r.state === 'same' ? '回车原样发送' : '回车时会重试'
  return h(Box, { flexDirection: 'column' },
    h(Text, { dimColor: true, wrap: 'wrap' }, `EN ▸ ${body}`),
    h(Text, { dimColor: true }, status))
}

function onRenderText($, text) {
  seen.add(text)
  if (stableTimer) stableTimer.cancel()
  stableTimer = $.clock.after(1500, () => {
    stableTimer = null
    const texts = [...seen]
    seen.clear()
    for (const t of texts) scheduleOne($, t)
  })
}

export function register(on, options) {
  if (stableTimer) stableTimer.cancel()
  stableTimer = null
  seen.clear()
  cache.clear()
  outboundMap.clear()
  review = null
  reviewSending = null
  bandFocused = false
  bandId = ''
  lastFocusKey = ''
  probing = false
  if (holdTimer) holdTimer.cancel()
  holdTimer = null
  if (liveTimer) liveTimer.cancel()
  liveTimer = null
  liveCache.clear()
  liveDraft = ''
  liveLast = ''
  liveRunning = false

  // userConfig（/config 面板或 settings.json 的 pluginConfigs["parrot-translate@inline"]）
  cfg.display = DISPLAY_MODES.includes(options?.display) ? options.display : 'both'
  cfg.outbound = options?.outbound !== false
  cfg.lang = typeof options?.lang === 'string' && options.lang.trim() ? options.lang.trim() : 'zh-Hans'
  // 旧值 model（≤0.4.1）兼容：映射为 session
  const providerRaw = typeof options?.provider === 'string' ? options.provider.trim() : ''
  cfg.provider = providerRaw === 'model' ? 'session' : ['session', 'openai'].includes(providerRaw) ? providerRaw : 'microsoft'
  cfg.model = typeof options?.model === 'string' && options.model.trim() ? options.model.trim() : 'haiku'
  cfg.baseUrl = typeof options?.base_url === 'string' && options.base_url.trim() ? options.base_url.trim() : 'http://127.0.0.1:8021/v1'
  cfg.apiKey = typeof options?.api_key === 'string' ? options.api_key : ''
  cfg.livePreview = options?.live_preview !== false
  const delay = Number(options?.live_delay_ms)
  cfg.liveDelay = Number.isFinite(delay) && delay > 0 ? Math.min(Math.max(Math.round(delay), 300), 10000) : LIVE_DELAY_DEFAULT
  mode = cfg.display

  on('session.start', async ($, e, next) => {
    outboundMap.clear()
    review = null
    await $.command.register({ name: 'translate', description: 'Cycle the display of prompts and replies: bilingual, your language only, English only', argumentHint: '[both|native|english]' })
    diag($, `loaded provider=${cfg.provider} model=${cfg.model} baseUrl=${cfg.baseUrl} display=${cfg.display} outbound=${cfg.outbound} lang=${cfg.lang}`)
    return next(e)
  })

  on('command.run', { command: 'translate' }, async ($, e) => {
    const arg = (e?.args || '').trim().toLowerCase()
    if (arg && !DISPLAY_MODES.includes(arg)) return { text: `用法：/translate [${DISPLAY_MODES.join('|')}]` }
    mode = arg || DISPLAY_MODES[(DISPLAY_MODES.indexOf(mode) + 1) % DISPLAY_MODES.length]
    diag($, `display=${mode}`)
    // 等待反馈：还有段在翻时直接告诉用户，免得对着空白狂按
    const pending = [...cache.values()].filter((e) => e.state === 'pending').length
    const error = [...cache.values()].filter((e) => e.state === 'error' || e.errors).length
    const note = mode === 'english' ? '' : pending ? `（还有 ${pending} 块在翻译）` : error ? '（部分翻译失败，见 /tmp/pt-live.log）' : ''
    $.ui.toast(`显示：${modeLabel(mode)}${note}`)
    $.ui.invalidate('ui.render')
    return {}
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const text = e.props?.text
    if (!text || !text.trim()) return next(e)

    // 默认就翻（与显示无关）：防抖 1.5s，文本稳定后才调度（见 onRenderText）。
    // onRenderText 只登记防抖，不会同步写 cache，这里不必重读。
    const entry = cache.get(text)
    if (!entry) onRenderText($, text)

    if (mode === 'english') return next(e)

    // 诊断：显示译文时记录每次渲染到达，用于排查「切了显示但没重画」
    diag($, `render len=${text.length} state=${entry ? entry.state : 'none'}`)
    if (!entry || entry.state !== 'done') return next(e)

    // 缓存里已拼好双语 / 纯译文两版，直接替换显示文本（只影响渲染，不落盘不进上下文）
    return next({ ...e, props: { ...e.props, text: mode === 'native' ? entry.native : entry.md } })
  })

  // 输入时更新实时预览；审阅英文时清空输入框就是放弃审阅（之后的提交回到自动改写）
  on('prompt.edit', async ($, e, next) => {
    const r = await next(e)
    const text = r?.text ?? ''
    setBandFocused($, false)
    if (!text.trim() && review) {
      review = null
      $.ui.invalidate('ui.render')
    }
    onDraftEdit($, text)
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => renderLive($, e, next))

  // 焦点落到本插件的按钮上 = 正在上方选择（换提示语）；落到「编辑英文」（它是唯一的按钮，autoFocus）就直接开始编辑，省一次回车
  on('ui.focus', { component: 'AbovePrompt' }, async ($, e, next) => {
    const r = await next(e)
    if (r?.deny || probing) return r
    if (BAND_KEYS.includes(e.element)) lastFocusKey = e.element
    setBandFocused($, BAND_KEYS.includes(e.element))
    if (e.element === 'live-edit') void startReview($)
    return r
  })

  // 「发送英文」走 $.prompt.submit，来源被标成本插件；改回用户本人，模型照常当用户的话读
  on('prompt.submit', { origin: { kind: 'plugin' } }, async ($, e, next) => {
    if (reviewSending === null || e.text !== reviewSending) return next(e)
    reviewSending = null
    const r = await next(e)
    if (r?.drop !== undefined) return r
    const { origin, ...rest } = r
    return rest
  })

  // 出站：本机敲 Enter 的提示词改写成英文再进会话（插件/peer/通知的提交不动）
  on('prompt.submit', { origin: { kind: 'composer' } }, async ($, e, next) => {
    const text = e.text ?? ''
    if (text.startsWith('/')) return next(e)
    const reviewed = review
    review = null
    setBandFocused($, false)
    const live = liveCache.get(text)
    clearLive($)
    // 审阅过的英文（可能已手改）原样发出；改的时候又写进了非拉丁文字就照常走自动改写
    if (reviewed && text.trim() && !nonLatinLetterCount(text)) {
      if (text.trim() !== reviewed.orig.trim()) putOutboundMap(text, reviewed.orig)
      diag($, `outbound reviewed len=${text.length}`)
      return next(e)
    }
    // outbound 关掉时不做自动改写，只认用户审阅后保存的译文（明确要发英文）
    if ((!cfg.outbound && !live?.edited) || !text.trim()) return next(e)
    try {
      // 实时预览已译好：发出的就是输入框上方显示的英文，不再请求
      if (live?.state !== 'done' && cfg.provider !== 'microsoft' && text.length > 120) $.ui.toast('正在把提示词转成英文…')
      const { text: en, changed, errors } = live?.state === 'done' ? live : await outboundBlock($, text)
      if (!changed || !en.trim()) {
        if (errors) $.ui.toast('提示词英文转换失败，已原样发送（见 /tmp/pt-live.log）')
        return next(e)
      }
      if (errors) $.ui.toast(`提示词已部分转成英文（${errors} 段保留原文，见 /tmp/pt-live.log）`)
      putOutboundMap(en, text) // 先入映射再 next，跟上的重渲染直接能画对照；冲突时标 ambiguous
      diag($, `outbound len=${text.length} -> ${en.length} errors=${errors}`)
      // 模型与落盘都是英文；屏幕上的用户行跟着变英文，由下面的渲染钩子画成双语对照
      return next({ ...e, text: en })
    } catch (err) {
      diag($, `outbound error: ${String((err && err.message) || err).slice(0, 150)}`)
      return next(e) // 任何失败都原样放行，绝不拦提示词
    }
  })

  // 用户消息行：双语对照（原文在上，实际发出的英文 `> ` 引用在下）/ 只显示原文 / 只显示英文。
  // 只影响渲染：上下文和 transcript 里始终是英文。
  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const text = e.props?.text
    const orig = text ? outboundMap.get(text) : undefined
    if (orig === undefined || orig === null || mode === 'english') return next(e)
    const quote = text.split('\n').map((l) => `> ${l}`).join('\n')
    const shown = mode === 'native' ? orig : `${orig}\n\n${quote}`
    return next({ ...e, props: { ...e.props, text: shown } })
  })
}
