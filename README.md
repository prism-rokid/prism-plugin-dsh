# DeepSeek Harness Prism 插件

这是一个 Prism PluginBridge v4 插件，连接本机运行的 DeepSeek Harness。

## 运行模式

- `native`：通过 Harness 的本地 HTTP RPC 和 WebSocket 事件流访问会话。支持会话列表、历史、发送消息、等待运行、停止运行、模型/推理强度切换、重命名和归档。
- `desktop`：优先在 Harness 已登录页面中通过 CDP 执行页面内 RPC，自动复用浏览器 Cookie；会话切换、可见性、桌面事件订阅也通过页面 DOM 和页面内 RPC 确认。若没有 CDP 端点，不会降级为未授权的独立 HTTP 请求。

新版 Harness 桌面切换旧会话时，插件会根据会话 `cwd` 幂等登记工作区，并通过 Harness 的 `session.create({sessionId, workspaceId})` 将未归属的旧会话挂回工作区后再点击桌面行。旧版 Typert API 没有 workspace 注册接口，插件会跳过这一步，直接按会话标题和桌面树行切换。Harness 标记为 `blank` 的会话是“新会话”占位行，不会宣称桌面可见，也不会伪造切换成功。

插件会自动探测新版点号路由和旧版 Typert 路由。旧版历史读取会转换为 `session/page`，模型目录转换为 `session/modelCatalog`，返回值再归一化为插件协议格式。

默认 API 地址为 `http://127.0.0.1:3080`，可通过 `DSH_API_BASE_URL` 覆盖。桌面应用当前通常会把 API 绑定到动态端口（例如 `64309`）。桌面应用的 HTTP 接口使用启动 URL token 换取本机 Cookie；如果 Hub 进程不是由 Harness 启动，请在插件环境中配置 `DSH_API_TOKEN`（启动 URL 的 token）或 `DSH_API_COOKIE`，插件会自动完成 Cookie 认证，不会把 token 写入日志。

默认桌面模式不需要 API token 或 Cookie：它在已登录的 Harness 页面内执行 RPC，并自动探测 `9222`、`9223`、`9333`。若安装包使用其他端口，可设置 `DSH_CDP_URL`（`/json/list` 地址或页面 WebSocket 地址；可用逗号分隔多个候选）或 `DSH_CDP_PORTS`（逗号分隔端口）。该探测只使用 Node 的 loopback HTTP 和 CDP WebSocket，在 macOS 与 Windows 上行为一致，不依赖 `lsof`、PowerShell 或 shell 命令。

Hub 支持将 DeepSeek Harness 以独立 Prism 资料目录托管启动：托管实例会通过 `DevToolsActivePort` 自动发现动态 CDP 端口。已经手动启动且暴露 CDP 的实例会保持远程可用，不会因为未托管而被标记为不可用；只有用户主动选择“重新托管”时，Hub 才会关闭并以托管模式重启该应用。

## 能力边界

插件会话详情展示 Harness 返回的 `tokenUsage`、`contextPressure` 和 `sessionStats`。Harness 当前没有稳定的公开账户额度接口，因此插件不会把会话 token 统计包装成账户套餐额度，`readAgentUsage()` 会返回空值。

Harness 的普通会话没有公开删除接口，删除操作不声明支持。支持新版 mux 协议的桌面应用会把工具执行审批同步为 Prism 的审批卡片，并支持“仅允许一次”和“拒绝”回传；`ask_user_question` 会映射为 Prism 的多题问答界面，支持单选、多选、文本补充与跳过，并按 DSH 协议回传结构化答案。旧版 Harness 或交互下行通道不可用时，插件不会展示无法执行的远程交互。Hub 传入的 PNG、JPEG、WebP、GIF 图片会读取为 base64 后交给 Harness 的 `session.prompt`；MIME 缺失时会以同一组文件扩展名识别。最多 512 KiB 的 UTF-8 文本或代码文件会以内嵌内容发送。PDF、Office、压缩包、音视频和其他二进制附件会在发送前明确拒绝，避免 Panel 显示伪成功。

## 本地验证

```bash
npm test
node index.js
```

插件运行时由 Hub 注入 `PRISM_PLUGIN_MODE=native` 或 `PRISM_PLUGIN_MODE=desktop`。当前工作区的 Harness API 未监听 `127.0.0.1:3080` 时，`probe` 会返回不可用状态，插件不会伪造在线能力。
