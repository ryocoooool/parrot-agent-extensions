# parrot-agent-extensions

面向 Claude Code 和 Pi 的语言辅助扩展。parrot-translate 将外文提示词翻成英文，回复和思考内容按需译回你的语言。

> **这是一个分支（fork）。** 原项目是 [jhao0413/parrot-agent-extensions](https://github.com/jhao0413/parrot-agent-extensions)。本分支的改动集中在 **Claude Code 插件**（[`claude/parrot-translate`](claude/parrot-translate/README.md)），Pi 扩展与上游保持一致。

![parrot-translate 效果](docs/screenshot.png)

## 本分支的改动（Claude Code）

- **三种显示方式**：`/translate` 在「双语对照 / 只显示你的语言 / 只显示英文」之间切换，用户消息和回复一起切；新增 `display` 配置，取代原来的 `show_by_default`
- **输入时实时英文预览**：草稿里有外文时，停顿片刻（`live_delay_ms`，默认 1.5 秒）后在输入框上方完整显示英文，直接回车发出的就是这段英文
- **发送前修改英文**：`ctrl+x tab` 把英文换进主输入框直接改，改完可以恢复原文、发送英文，或保存为这份草稿的译文
- 预览框高度固定，翻译中和译好来回切换时不再上下跳动
- 安装源指向本分支

## Claude Code 插件功能一览

- **回复翻译**：Claude 的英文回复在后台翻成你的语言（`lang`），每段原文下面跟译文；代码块不翻
- **出站英文**：你输入的提示词发出前改写成地道英文，外文就翻译，英文只修语法；页面上显示「原文在上、英文在下」的对照
- **实时预览与修改**：输入时上方显示完整英文，可以换进输入框修改后再发
- **三种显示方式**：`/translate both | native | english`
- **安全放行**：错误信息、堆栈、JSON、日志、diff 等技术性内容原样放行；`@文件` 引用、代码、路径、URL 不改
- **翻译服务三选一**：微软免费接口（默认，免 key）、本会话模型、OpenAI 兼容接口（如本地 llama.cpp）
- **不影响上下文**：译文和对照只在显示层，模型收到、会话保存的始终是英文

完整说明见 [Claude Code 安装与使用](claude/parrot-translate/README.md)。

## Claude Code 安装、更新与卸载

需要 Claude Code v2.1.287+（mods API）。

**安装**

```bash
claude plugin marketplace add ryocoooool/parrot-agent-extensions
```

```bash
claude plugin install parrot-translate@parrot-agent-extensions
```

装好后开一个新会话即生效。本分支的 marketplace 名与上游相同（`parrot-agent-extensions`）。之前添加过上游的，先移除再添加，否则装到的是上游版本：

```bash
claude plugin marketplace remove parrot-agent-extensions
```

**更新**：先刷新 marketplace，再更新插件，然后开新会话。

```bash
claude plugin marketplace update parrot-agent-extensions
```

```bash
claude plugin update parrot-translate@parrot-agent-extensions
```

**卸载**

```bash
claude plugin uninstall parrot-translate@parrot-agent-extensions
```

```bash
claude plugin marketplace remove parrot-agent-extensions
```

再按需清理 `~/.claude/settings.json` 里 `pluginConfigs` 下的 `parrot-translate@…` 配置，以及 `~/.claude/keybindings.json` 里的 `command:translate` 绑定。详见[卸载](claude/parrot-translate/README.md#卸载)。

## Pi 安装

```bash
pi install npm:pi-parrot-translate
```

重启 Pi，或在已有会话中运行 `/reload`。Pi 扩展来自上游，完整说明见 [Pi 安装与使用](pi/README.md)。

## 致谢

- 感谢原作者 [jhao0413](https://github.com/jhao0413) 创建 parrot-agent-extensions：翻译管线、出站改写、Pi 扩展等核心功能都来自原项目，本分支在此基础上修改
- 感谢 [Linux.do 社区](https://linux.do) 的支持与帮助

## 贡献者

- [jhao0413](https://github.com/jhao0413)：原作者
- Zekun Yang（[@ryocoooool](https://github.com/ryocoooool)）：本分支维护者，Claude Code 插件改动
- [Claude](https://claude.com/claude-code)（Anthropic）：通过 Claude Code 参与本分支的设计与实现
