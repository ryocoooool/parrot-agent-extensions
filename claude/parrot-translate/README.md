# parrot-translate (Claude Code)

> 本分支基于 [jhao0413/parrot-agent-extensions](https://github.com/jhao0413/parrot-agent-extensions) 修改，改动见[根 README](../../README.md#本分支的改动claude-code)。感谢原作者 [jhao0413](https://github.com/jhao0413)。

写给想用英文跟模型对话的非英语用户。

Claude 的英文回复在后台翻成你配置的语言，译文跟在对应的原文段落后面。你输入的提示词在发出前会被改写成英文：是外文就翻译，已经是英文就只修语法，意思不变。发出后保留原文和英文的对照。`/translate` 在「双语对照 / 只显示中文 / 只显示英文」之间切换整个页面。输入时输入框上方实时显示完整英文，`ctrl+x tab` 可以把英文换进输入框改好再发。

译文和对照都只在显示层，整个对话上下文里始终只有英文。

## 安装与更新

需要 Claude Code v2.1.287+（mods API）。

### 安装

1. 添加本分支的 marketplace：
   ```bash
   claude plugin marketplace add ryocoooool/parrot-agent-extensions
   ```
2. 安装插件：
   ```bash
   claude plugin install parrot-translate@parrot-agent-extensions
   ```
3. 开一个新会话，插件即生效。默认配置（微软翻译、目标语言简体中文）无需改动就能用，要调整见下面的「配置」，配置键是 `parrot-translate@parrot-agent-extensions`

本分支的 marketplace 名与上游 `jhao0413/parrot-agent-extensions` 相同。之前添加过上游的，先移除再执行第 1 步，否则装到的是上游版本：

```bash
claude plugin marketplace remove parrot-agent-extensions
```

### 更新

1. 刷新 marketplace：
   ```bash
   claude plugin marketplace update parrot-agent-extensions
   ```
2. 更新插件：
   ```bash
   claude plugin update parrot-translate@parrot-agent-extensions
   ```
3. 开新会话，已打开的会话仍是旧版本

各版本需要注意的变化：

- **0.3.0**：输入框上方的英文改为只读并完整显示；修改英文改为 `ctrl+x tab` 换进主输入框里改（恢复原文 / 发送英文 / 保存译文）；新增 `live_delay_ms`，实时预览默认停顿 1.5 秒才翻
- **0.2.0**：`show_by_default` 被 `display` 取代，原来设为 `false` 的改成 `"display": "english"`

### 本地开发与测试

改仓库里的代码时不用安装，直接从目录加载（改动在下次启动生效，配置键是 `parrot-translate@inline`）：

```bash
claude --plugin-dir /path/to/parrot-agent-extensions/claude/parrot-translate
```

已经装了 marketplace 版的，两份会同时加载。只在这个会话里关掉 marketplace 版，不影响其他会话：

```bash
claude --plugin-dir /path/to/parrot-agent-extensions/claude/parrot-translate --settings '{"enabledPlugins":{"parrot-translate@parrot-agent-extensions":false}}'
```

`claude plugin disable parrot-translate@parrot-agent-extensions` 也行，但它改的是全局设置，之后新开的会话（包括桌面端）都会没有插件，测完记得 `claude plugin enable` 回来。

### 发布新版本

1. 改 `.claude-plugin/plugin.json` 的 `version`（已安装的机器靠版本号识别更新，不改的话 `claude plugin update` 拿不到新代码）
2. 跑测试和校验：
   ```bash
   (cd pi && npm install && npm test)
   ```
   ```bash
   claude plugin validate claude/parrot-translate
   ```
3. 提交并推送到 `main`，其他机器按上面的「更新」执行

## 配置

`/config` 面板可以直接改，或者改 `~/.claude/settings.json`（键名与安装方式对应，marketplace 装的就是 `@parrot-agent-extensions`）：

```json
{
  "pluginConfigs": {
    "parrot-translate@parrot-agent-extensions": {
      "options": {
        "display": "both",
        "outbound": true,
        "lang": "zh-Hans",
        "provider": "microsoft",
        "model": "haiku"
      }
    }
  }
}
```

值要包在 `"options"` 里，直接写在插件名下面不生效。

| 选项 | 默认 | 说明 |
|---|---|---|
| `display` | `both` | 页面显示方式，用户消息和回复共用：`both` 双语对照、`native` 只显示你的语言、`english` 只显示英文，见「显示方式」。取代旧的 `show_by_default`（原来设为 `false` 的改成 `english`） |
| `outbound` | `true` | 出站链路总开关 |
| `live_preview` | `true` | 输入时在输入框上方显示完整英文，可一键换进输入框修改，见「实时预览与修改」 |
| `live_delay_ms` | `1500` | 停止输入多久才开始实时翻译（300–10000）；打字时常停下来想的可以调大 |
| `lang` | `zh-Hans` | 你的语言，微软语言码：`zh-Hant`、`ja`、`ko`、`fr`、`de`、`es`、`ru` 等 |
| `provider` | `microsoft` | 翻译服务，见下 |
| `model` | `haiku` | `session` / `openai` 用的模型；填别名 haiku / sonnet 或完整 id |
| `base_url` | `http://127.0.0.1:8021/v1` | `openai` 的接口地址 |
| `api_key` | 空 | `openai` 用；本地 llama.cpp 随便填，不校验 |

provider 三选一：

- `microsoft`：Edge 免费接口，同 parrot 扩展那套，免 key、快。只会翻译，英文输入没有语法检查，会原样放行
- `session`：`$.model.complete` 走本会话凭证，免配置，质量更好，耗 token。旧值 `model` 仍被接受
- `openai`：OpenAI 兼容端点，本地 llama.cpp 或远端服务

以使用本地 index-translate-2b 模型为例：

```json
"pluginConfigs": {
  "parrot-translate@parrot-agent-extensions": {
    "options": {
      "provider": "openai",
      "model": "index-translate-2b",
      "base_url": "http://127.0.0.1:8021/v1",
      "api_key": "sk-local"
    }
  }
}
```

同一段 5000 字符的回复：微软 ~3s；haiku ~32s、译文更自然；index-translate-2b ~46s、免费，代码块保留得干净。

## 出站

`prompt.submit` 在提示词进会话之前改写它：外文翻成英文，英文只修语法、拼写、排版，没有问题就原样放行。代码围栏、标识符、文件路径、命令、URL 不碰，散文段并发 4 路。改写完成 turn 才开始，`session` / `openai` 下内容较长会先 toast 提示；任何一步失败都不拦提示词，原文照发。

改写结果会拒绝源语言润色、未翻译的非拉丁文字和元评论，混合输入也会校验，代码和引用里的外文允许保留。可能是英文且不含非拉丁正文的输入按完整词数检查改写幅度，混合语言翻译与法语等其他拉丁语言不套英文词重合规则。含非拉丁正文的输入首轮用明确的英文翻译指令；其他输入同时说明外文翻译与英文语法修正，避免短英文片段被当成外文，失败后再重试一次；仍失败则保留该段原文并提示查看日志。报错前缀（`Error:`、`Exception:`、`panic:` 等）归入技术性内容，两侧原样跳过。诊断日志会记录重试与失败原因。

粘贴的技术性内容会自动识别、原样放行：错误信息、堆栈、JSON、日志、diff（两侧都适用，回复侧同样不送翻）；俄文、阿拉伯文等 Unicode 正文正常翻译。反引号或 `~~~` 围栏（包括更长、未闭合的围栏）及缩进代码块在结构层保护，列表和引用里的代码同样保护；列表续段按容器内的相对缩进识别为正文。超长段落切成 ≤3000 字符的块再送，保留原有分隔符；每块独立检测语言，英文前缀不会让后面的外文跳过。输出被截断时视为失败、放行原文。

只拦本机敲 Enter 的提交（`origin.kind === 'composer'`）；斜杠命令、插件、peer、通知的提交不碰。原来做手动检查的 parrot-grammar 已退役，被这条链路取代。

屏幕上的对照默认是「原文在上、实际发出的英文引用在下」，用 `/translate` 切换显示方式（见下）。`session` / `openai` 的改写提示词会带上 `lang` 作为作者语言背景，帮模型译得更地道；出站目标始终是英文，不随 `lang` 变。

## 显示方式

`/translate` 在三种方式之间循环，用户消息和回复一起切换，已显示的内容立即重画：

| 方式 | 你发的消息 | Claude 的回复 |
|---|---|---|
| `both` 双语对照 | 原文在上，发出的英文 `> ` 引用在下 | 每段英文下面跟 `> ` 译文 |
| `native` 只显示中文（你的 `lang`） | 原文 | 只有译文 |
| `english` 只显示英文 | 发出的英文 | 英文原文 |

也可以直接指定：`/translate both`、`/translate native`、`/translate english`。初始方式由 `display` 配置。切换时还有段在翻译或有失败会在提示里注明。

只改显示：模型收到、transcript 里存的始终是英文。`native` 下没有译文的内容（代码块、已是目标语言的段落、技术性内容、翻译失败的段落）保留原样。你发的消息的原文只在本次会话的内存里，重开会话后只显示英文；同一句英文对应过两种不同原文时也只显示英文，不会标错。

想绑快捷键，在 `~/.claude/keybindings.json` 的 `Chat` 里加 `"ctrl+x ctrl+v": "command:translate"`。注意 `ctrl+y` 现在是 Claude Code 自带的 `chat:defaultToNewerModel`，要用它得自己覆盖。

## 实时预览与修改（发送前改英文）

输入框里出现中文等非拉丁文字时，停顿 1.5 秒（`live_delay_ms`）后在后台翻译，输入框上方完整显示 `EN ▸` 英文（只读，长句自动换行）。继续输入时先保留上一版英文（末尾带 `…`），新译文出来后替换。直接回车，发出的就是上方这段英文。

想先改英文再发：

1. 按 `ctrl+x tab`（Claude Code 默认的「聚焦输入框上方区域」），或直接点「编辑英文」
2. 英文替换掉输入框里的草稿，上方改为显示 `原文 ▸` 对照，并给出三个选项
3. 按 `Esc` 回到输入框，直接改英文
4. 改完后：
   - 「1 恢复原文」（默认，`ctrl+x tab` 后焦点在它上面）：放弃英文和修改，原草稿放回输入框
   - 在输入框里回车，或「2 发送英文」：原样发出输入框里的英文
   - 「3 保存译文」：改后的英文存为这份草稿的译文，输入框换回原草稿，上方预览显示改后的英文；之后直接回车发出的就是它

细节：

- 选项需要先 `ctrl+x tab` 聚焦上方区域，再按数字键或方向键 + 回车；桌面端可直接点
- 上方的提示随键盘位置变化：在输入框时提示 `ctrl+x tab`，在上方选择时提示 `Esc` 返回。`Esc` 交还键盘时插件收不到通知，所以在上方选择期间每 300ms 探测一次焦点，按 `Esc` 后提示约 0.3 秒内换回来
- 发出的英文不再二次改写；用户消息行照样显示「原文在上、发出的英文在下」
- 改英文时又写进了中文等非拉丁文字，发送时会照常转成英文
- 审阅时清空输入框就是放弃审阅，之后的提交回到自动改写
- 保存的译文跟着草稿走：草稿再改会重新翻译，改回同一份草稿仍用保存的译文
- `outbound` 关掉时不做自动改写，但审阅过的英文（在输入框里发出的、或「保存译文」存下的）仍按英文发出
- 纯英文、斜杠命令、空输入不预览，也不请求
- 每个草稿最多请求一次（有缓存），同一时间只跑一个翻译请求，连续输入只翻最后停下来的版本
- 预览失败会在上方提示，回车时照常重试
- 翻译服务和出站一样；`session` 会多一些 token 消耗，不想要就把 `live_preview` 设为 `false`

## 行为细节

- 翻译默认一直在后台做（`english` 方式下也是），`/translate` 只管显示；译文按消息块缓存，翻一次后切换即时；缓存和双语对照各保留最近 500 条，更早的滚回时会重翻/回落英文行
- 防抖 1.5s：流式渲染期间计时器不断重置，回复稳定约 1.5 秒后才真正去翻。没有依赖 `turn.start` / `turn.complete`，实测这对事件不一定触发，一旦不触发整条管线就死掉
- 按空行分段，列表、标题整段翻；代码块不送翻也不插译文；长段按空行切块，单块 ≤3000 字符
- 已是目标语言的块跳过：微软靠接口的 `detectedLanguage` 和 `lang` 比对；`session` / `openai` 对 `zh` 系目标先本地数 CJK 字符，省一次调用；其他语言靠提示词约定「已是目标语言则原样返回」再逐块比对
- 诊断日志在 `/tmp/pt-live.log`，保留最近 60 条，排查看它
- 显示译文（`both` / `native`）时翻完会 toast「译文就绪」，失败会提示看日志

## 不影响上下文

译文只改渲染层：`ui.render` 的 `AssistantMessage` 站点改的是「这块怎么画」，存储和发给模型走另一条路，`session.append` 才能改落盘，本插件没用它。实测：transcript `.jsonl` 里搜不到屏幕上出现过的译文句子，原文能搜到；下一轮请求不含译文，不占 token；`$.model.complete` 是无历史的独立补全，也不进会话。出站改写发生在进会话之前，落盘的是英文，原文同样只活在渲染层，重开会话后对照就没有了。

## 实现备注

- hooks module 只能 import 相对路径和 `"claude-code"`，无外部依赖
- 微软路径的 `parseBody` 兼容宿主把 JSON 预解析成对象塞进 `text` 的情况
- 本地地址必须走 curl：`$.http.fetch` 连 `127.0.0.1` 会被 reset（SSRF 防护），`openai` 改用 `$.process.run` + curl 直连
- OpenAI 兼容输出会剥 `<think>...</think>`
- 配置由 `register(on, options)` 第二参传入，`plugin.json` 的 `userConfig` 声明

## 卸载

1. 卸载插件：
   ```bash
   claude plugin uninstall parrot-translate@parrot-agent-extensions
   ```
2. 移除 marketplace（不再需要本分支的源时）：
   ```bash
   claude plugin marketplace remove parrot-agent-extensions
   ```
3. 按需清理残留配置：
   - `~/.claude/settings.json` 里 `pluginConfigs` 下的 `parrot-translate@parrot-agent-extensions`，本地开发用过的还有 `parrot-translate@inline`
   - `~/.claude/keybindings.json` 里 `command:translate` 的绑定
   - 诊断日志 `/tmp/pt-live.log`
