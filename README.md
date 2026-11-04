# dsh

DeepSeek Harness desktop-automation plugin for Prism PluginBridge.

This release uses the public `@rokid-prism/pluginbridge-plugin-sdk` package and
the Hub-managed Node 22 runtime. The recommended mode is `desktop`: it controls
the already logged-in DeepSeek Harness window through CDP and does not require
copying Harness cookies or tokens into the plugin.

## 本地问题分析与贡献

仓库默认带有 [`prism-plugin-maintainer`](.agents/skills/prism-plugin-maintainer/SKILL.md)，用于本地分析、修复和验证插件问题，无法解决时整理脱敏 Issue 草稿。支持 `.agents/skills` 的智能体可发现它，其他客户端可要求智能体直接阅读该文件。默认不发布；先准备 diff、检查结果、目标和正文供审阅，用户可一次授权 commit、推送与 PR 整条流程，或明确授权无法解决时自动提交 Issue。范围内已有授权不重复询问。公开提交和数据处理说明见 [SDK README](https://github.com/Rokid-Prism/prism-plugin-sdk#本地问题分析与贡献-skill)。

## Current behavior

- enumerates DeepSeek Harness sessions and exposes their native IDs, titles, working directories, running state, model, permission and session statistics
- reads Harness history and projects it into Prism turns, retaining user messages and final assistant output while filtering Harness-injected prompt content and intermediate assistant steps
- selects an existing session from the visible Harness desktop sidebar and verifies the selected native session before returning success
- creates a new Harness session from a Prism draft and sends the first message through the Harness RPC contract
- sends text, supported images and UTF-8 text/code files to Harness; image and text attachments are converted to the descriptor expected by the current Typert gateway
- switches model and reasoning effort through Harness controls when the current model catalog exposes those options
- switches supported permission presets through the Harness command contract
- interrupts a running Harness session, waits for completion and publishes foreground/session status changes to Hub
- reads and publishes Harness token usage, context pressure and session statistics when available
- maps native tool approvals to Prism approval events and sends allow-once or reject responses back to Harness
- maps native `ask_user_question` cards to Prism `questionnaire` surfaces, including single choice, multiple choice, free text and skip actions
- reads native Harness question cards directly from the desktop DOM as a CDP fallback when the mux event stream is unavailable; Panel responses operate the native option and submit controls
- publishes reverse-sync session and foreground updates for Hub, desktop Panel and remote clients

## Current limits

- desktop CDP mode is the supported path for a logged-in Harness desktop application; the native HTTP/WebSocket mode requires an explicit Harness launch token or cookie
- Harness does not currently expose a stable account quota or subscription endpoint to this plugin; session token statistics are not presented as account quota
- Harness does not expose a stable ordinary-session delete operation, so delete is intentionally unsupported
- approval and question delivery depend on the native Harness UI remaining visible and structurally compatible; unsupported UI variants fail closed instead of inventing a remote surface
- the CDP selectors are verified against current DeepSeek Harness desktop builds; future UI changes may require selector updates
- full Windows desktop-control regression still needs to be run on a Windows machine, although endpoint discovery and filesystem handling avoid macOS-only shell commands

## Configuration

普通用户优先在 Prism Desktop 的插件页配置应用路径、数据目录和托管启动，不需要手工复制登录信息或执行一次性的 shell `export`。

开发者模式下可用的环境变量：

- `PRISM_PLUGIN_MODE`: `desktop`（默认）或 `native`
- `DSH_CDP_URL`: 一个 `/json/list` 地址或页面 WebSocket 地址；支持逗号分隔多个候选
- `DSH_CDP_PORTS`: CDP 端口候选列表；默认探测 `9222`、`9223`、`9333`
- `PRISM_DSH_USER_DATA_DIR`: Chromium/Electron 用户数据目录；插件会读取其中的 `DevToolsActivePort`
- `DSH_API_BASE_URL`: native 模式的 Harness API 地址，默认 `http://127.0.0.1:3080`
- `DSH_API_TOKEN`: native 模式使用的 Harness 启动 URL token
- `DSH_API_COOKIE`: native 模式使用的已认证 Cookie

desktop 模式优先使用 Harness 页面内的 RPC 和页面授权上下文。插件不会把
token、Cookie 或签名 URL 写入日志，也不会在没有 CDP 授权时伪造在线状态。
CDP 端口探测使用 Node 的 loopback HTTP/CDP WebSocket，在 macOS 和 Windows
上采用同一套逻辑，不依赖 `lsof`、PowerShell 或其他平台命令。

## Control-path notes

- session selection、发送消息、模型/推理/权限切换、审批和问题回答都必须作用于当前已确认的 Harness 桌面会话
- 桌面控制优先使用页面内 RPC；会话切换和问题/审批交互使用 CDP DOM 读取与原生控件操作，并在操作前重新校验目标身份
- `ask_user_question` 通过标准 `interactive_surface` 发布；Panel 只提交当前 surface 的 opaque `surface_id` 和 `action_id`，插件再映射为 Harness 原生选项索引和提交动作
- native HTTP/WebSocket 路径只在配置了有效授权时启用；收到 `401 Unauthorized` 不会尝试猜测或绕过认证
- 附件只允许 Harness 当前已验证的图片和文本/code 类型；PDF、Office、压缩包、音视频及其他二进制文件会在发送前明确拒绝
- 交互 surface、审批和前台详情均由真实 Harness 状态驱动；插件不维护会话内容的影子状态，也不通过深链或系统剪贴板伪造桌面操作

## Local verification

```bash
npm test
npm run validate-manifest
node index.js
```

Hub 运行插件时会注入 `PRISM_PLUGIN_MODE=desktop` 或
`PRISM_PLUGIN_MODE=native`。desktop 模式下 Harness 必须已经登录并暴露 CDP
端点；native 模式下必须同时提供可用的 API 授权。
