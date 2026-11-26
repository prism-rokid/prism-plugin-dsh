"use strict";

const crypto = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const { homedir } = require("os");
const { execFile } = require("child_process");
const { promisify } = require("util");
const { firstText } = require("./dsh_client");

const DEFAULT_CDP_PORTS = [9222, 9223, 9333];
const CDP_PAGE_OPERATION_TIMEOUT_MS = 5000;
// 进程端点来源只用于兜底，短期缓存避免 watcher 的每次 RPC 都重新枚举进程。
const PROCESS_ENDPOINT_TTL_MS = 5000;
const execFileAsync = promisify(execFile);

function cdpHttpUrl(value) {
  const raw = firstText(value);
  if (!raw) return "";
  if (raw.startsWith("ws://") || raw.startsWith("wss://")) return raw;
  return raw.replace(/\/$/, "");
}

function configuredCdpPorts(value) {
  const ports = String(value || "").split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
  return [...new Set([...ports, ...DEFAULT_CDP_PORTS])];
}

function cdpCandidates(endpoint, ports) {
  const candidates = String(endpoint || "").split(",")
    .map((item) => cdpHttpUrl(item))
    .filter(Boolean);
  for (const port of configuredCdpPorts(ports)) candidates.push(`http://127.0.0.1:${port}`);
  return [...new Set(candidates)];
}

// Chromium 只在显式启动参数中记录 --user-data-dir，并且同时支持
// --flag=value 与 --flag value。路径可能包含空格，所以值一直取到下一个
// -- 开关或行尾，不能按第一个空格截断。
function commandUserDataDir(command = "") {
  const match = String(command || "").match(/(?:^|\s)--user-data-dir(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(.+?))(?=\s+--|$)/);
  return firstText(match && match[1], match && match[2], match && match[3]);
}

function commandRemoteDebuggingPort(command = "") {
  const match = String(command || "").match(/(?:^|\s)--remote-debugging-port(?:=|\s+)(\d+)/);
  const port = Number(match && match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
}

// 只认 DeepSeek Harness 桌面主进程：Chromium 的 renderer/GPU 子进程会继承
// 调试参数，但它们没有可连接的 CDP 主页面。
function dshDesktopMainProcesses(processes) {
  return (Array.isArray(processes) ? processes : []).filter((proc) => {
    const command = String(proc && proc.command || "");
    if (!/deepseek[- _]?harness/i.test(command)) return false;
    if (/(?:^|\s)--type(?:=|\s)/.test(command)) return false;
    return /--remote-debugging-port(?:=|\s)/.test(command);
  });
}

class DesktopProbeError extends Error {
  constructor(phase, detail) {
    super(detail);
    this.phase = phase;
  }
}

function desktopExecutable(proc, platform) {
  const command = String(proc?.command || "");
  if (/(?:^|\s)--type(?:=|\s)/.test(command)) return "";
  if (platform === "win32") {
    const executable = String(proc?.executablePath || "");
    return /^deepseek harness\.exe$/i.test(path.win32.basename(executable)) ? executable : "";
  }
  const executable = String(proc?.executablePath || "");
  return /^((?:\/[^/]+)*\/DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness)$/.exec(executable)?.[1] || "";
}

function desktopPaths(platform, env, home) {
  const configured = env.PRISM_DSH_APP_PATH;
  if (platform === "win32") return [
    configured,
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Programs", "DeepSeek Harness", "DeepSeek Harness.exe"),
    env.ProgramFiles && path.win32.join(env.ProgramFiles, "DeepSeek Harness", "DeepSeek Harness.exe"),
  ].filter(Boolean);
  const executable = "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
  return [
    configured && (configured.endsWith(".app") ? path.join(configured, "Contents/MacOS/DeepSeek Harness") : configured),
    path.join("/Applications", executable),
    path.join(home, "Applications", executable),
  ].filter(Boolean);
}

function windowsProcessesFromJSON(output = "") {
  const text = String(output || "").trim();
  if (!text || text === "null") return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values
    .map((value) => ({
      pid: Number(value && (value.ProcessId ?? value.processId)),
      command: firstText(value && (value.CommandLine ?? value.commandLine)),
      ...(value?.ExecutablePath ? { executablePath: value.ExecutablePath } : {}),
    }))
    .filter((value) => value.pid && value.command);
}

async function listDesktopProcesses() {
  if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine,ExecutablePath | ConvertTo-Json -Compress";
    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      timeout: 5000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return windowsProcessesFromJSON(stdout);
  }
  // -ww 保留完整命令行，避免 ps 按终端宽度截断调试参数。
  const options = { timeout: 4000, maxBuffer: 4 * 1024 * 1024 };
  const [commands, executables] = await Promise.all([
    execFileAsync("ps", ["-ww", "-axo", "pid=,command="], options),
    execFileAsync("ps", ["-ww", "-axo", "pid=,comm="], options),
  ]);
  const rows = text => String(text || "").split("\n").map(line => /^\s*(\d+)\s+(.+?)\s*$/.exec(line)).filter(Boolean);
  const paths = new Map(rows(executables.stdout).map(match => [match[1], match[2]]));
  return rows(commands.stdout).map(match => ({ pid: Number(match[1]), command: match[2], executablePath: paths.get(match[1]) }));
}

function legacyRoute(name) {
  const routes = {
    "session.history": "session/page",
    "session.models": "session/modelCatalog",
    "session.projections": "session/projections",
  };
  return routes[name] || name.replace(/\./g, "/");
}

function normalizeLegacyValue(name, value) {
  if (name === "session.history") {
    const records = Array.isArray(value && value.records) ? value.records : [];
    return {
      ...(value && typeof value === "object" ? value : {}),
      events: records.map((record) => record && record.event ? record : { event: record }),
      hasMore: Boolean(value && value.hasMore),
    };
  }
  if (name === "session.models") {
    const catalog = value && typeof value === "object" ? value : {};
    return { ...catalog, current: catalog.current || catalog.default || {} };
  }
  if (name === "session.projections") {
    const projections = value && value.projections;
    if (projections && typeof projections === "object") return projections;
    return value && typeof value === "object" ? value : {};
  }
  return value;
}

function sessionTitle(item) {
  const value = item && item.projections && item.projections.values && item.projections.values.title;
  if (value && typeof value === "object") return firstText(value.title, value.value);
  return firstText(value);
}

function nativeQuestionAnswer(surface, input) {
  let payload;
  try { payload = JSON.parse(firstText(input)); } catch { throw new Error("DeepSeek Harness 问题回答格式无效。"); }
  const row = payload && Array.isArray(payload.answers) ? payload.answers[0] : null;
  const selected = Array.isArray(row && row.selectedOptionIds) ? row.selectedOptionIds : [];
  const options = surface && surface.questions && surface.questions[0] && surface.questions[0].options || [];
  const indexes = selected.map((value) => /^dsh-option-0-(\d+)$/.exec(firstText(value))).map((match) => match ? Number(match[1]) : -1);
  const custom = firstText(row && row.freeformText);
  if (indexes.some((index) => !Number.isInteger(index) || index < 0 || index >= options.length) || new Set(indexes).size !== indexes.length || indexes.length > 1 || custom.length > 8192 || (!indexes.length && !custom)) {
    throw new Error("DeepSeek Harness 问题选项无效。");
  }
  if (custom && !surface.questions[0].allow_custom) throw new Error("DeepSeek Harness 当前问题不支持文本回答。");
  return { indexes, custom };
}

class DshDesktopController {
  constructor(options = {}) {
    this.fetch = options.fetch || globalThis.fetch;
    this.explicitEndpoint = options.endpoint || process.env.DSH_CDP_URL || "";
    this.cdpPorts = options.ports || process.env.DSH_CDP_PORTS || "";
    this.userDataDir = options.userDataDir || process.env.PRISM_DSH_USER_DATA_DIR || "";
    this.readFile = options.readFile || fs.readFile;
    this.listProcesses = options.listProcesses || listDesktopProcesses;
    this.platform = options.platform || process.platform;
    this.appPaths = options.appPaths || desktopPaths(this.platform, process.env, homedir());
    this.stat = options.stat || fs.stat;
    this.processEndpointCache = { at: 0, endpoints: [] };
    this.pageOperationTimeoutMs = Number(options.pageOperationTimeoutMs || CDP_PAGE_OPERATION_TIMEOUT_MS);
    this.rpcFlavor = null;
    this.confirmedSessionId = "";
    this.foregroundRevision = 0;
  }

  async resolvePage() {
    const profilePorts = await this.profileCdpPorts();
    const processEndpoints = await this.processCdpEndpoints();
    const harnessEndpoints = new Set([
      ...profilePorts.map((port) => `http://127.0.0.1:${port}`),
      ...String(this.explicitEndpoint).split(",").map(cdpHttpUrl).filter(Boolean),
      ...processEndpoints,
    ]);
    const endpoints = new Set([...harnessEndpoints, ...cdpCandidates("", this.cdpPorts)]);
    let reachable = false;
    let httpStatus;
    let refused = false;
    let inaccessible = false;
    let invalidResponse = false;
    let unrelatedEndpoint = false;
    for (const endpoint of endpoints) {
      try {
        if (endpoint.startsWith("ws")) return { webSocketDebuggerUrl: endpoint, source: "环境变量" };
        const response = await this.fetch(`${endpoint}/json/list`, { signal: AbortSignal.timeout(1200) });
        if (!response.ok) { httpStatus = response.status; continue; }
        const targets = await response.json();
        if (!Array.isArray(targets)) {
          invalidResponse = true;
          continue;
        }
        const associated = harnessEndpoints.has(endpoint);
        const page = targets.find(item => item?.type === "page" && item.webSocketDebuggerUrl &&
          (/^dsh-app:\/\/app(?:[/?#]|$)/i.test(item.url || "") ||
            (associated && /^(?:DeepSeek )?Harness$/i.test(firstText(item.title)))));
        if (page) return { webSocketDebuggerUrl: page.webSocketDebuggerUrl, source: endpoint, transportVerified: true };
        reachable ||= associated;
        unrelatedEndpoint ||= !associated;
      } catch (error) {
        if (error instanceof SyntaxError) invalidResponse = true;
        else if (error?.cause?.code === "ECONNREFUSED") refused = true;
        else inaccessible = true;
      }
    }
    if (reachable) throw new DesktopProbeError("page", "CDP 已返回目标列表，但其中没有 DeepSeek Harness 控制页面。");
    const details = [
      httpStatus ? `目标列表请求返回 HTTP ${httpStatus}` : "",
      invalidResponse ? "目标列表响应无效" : "",
      unrelatedEndpoint ? "候选端口中未识别到 Harness CDP" : "",
      refused ? "端口未开放（连接被拒绝）" : "",
      inaccessible ? "端口不可访问或请求超时" : "",
    ].filter(Boolean);
    throw new DesktopProbeError("transport", `未发现 DeepSeek Harness 的 CDP 调试端点${details.length ? `（${details.join("、")}）` : ""}。`);
  }

  async profileCdpPorts() {
    const userDataDir = firstText(this.userDataDir);
    if (!userDataDir) return [];
    try {
      // Chromium 以首行保存动态 CDP 端口；该文件随 --user-data-dir 跨平台生成。
      const content = await this.readFile(require("path").join(userDataDir, "DevToolsActivePort"), "utf8");
      const port = Number(String(content).split(/\r?\n/, 1)[0]);
      return Number.isInteger(port) && port > 0 && port <= 65535 ? [port] : [];
    } catch {
      return [];
    }
  }

  /**
   * 端口文件与显式配置都失效时，从运行中的桌面主进程恢复实际端点：读取其
   * --remote-debugging-port 参数和 --user-data-dir 下的动态端口文件。多个主
   * 进程说明无法确认目标实例，此时不猜测端口。
   */
  async processCdpEndpoints() {
    const now = Date.now();
    if (now - this.processEndpointCache.at < PROCESS_ENDPOINT_TTL_MS) return this.processEndpointCache.endpoints;
    let endpoints = [];
    try {
      const mains = dshDesktopMainProcesses(await this.listProcesses())
        .filter(proc => !Object.hasOwn(proc, "executablePath") || desktopExecutable(proc, this.platform));
      if (mains.length === 1) {
        const ports = new Set();
        const port = commandRemoteDebuggingPort(mains[0].command);
        if (port) ports.add(port);
        const userDataDir = commandUserDataDir(mains[0].command);
        if (userDataDir) {
          try {
            const content = await this.readFile(require("path").join(userDataDir, "DevToolsActivePort"), "utf8");
            const filePort = Number(String(content).split(/\r?\n/, 1)[0]);
            if (Number.isInteger(filePort) && filePort > 0 && filePort <= 65535) ports.add(filePort);
          } catch {
            // 未生成端口文件时只使用命令行中的显式端口。
          }
        }
        endpoints = [...ports].map((value) => `http://127.0.0.1:${value}`);
      }
    } catch {
      endpoints = [];
    }
    this.processEndpointCache = { at: now, endpoints };
    return endpoints;
  }

  async withPage(callback) {
    const { CdpPageClient } = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
    const pageInfo = await this.resolvePage();
    const page = new CdpPageClient();
    let timer;
    let connected = false;
    let expired = false;
    const connectionPhase = pageInfo.transportVerified ? "page" : "transport";
    try {
      const operation = (async () => {
        try { await page.connectToPage(pageInfo.webSocketDebuggerUrl); }
        catch {
          throw new DesktopProbeError(connectionPhase, "无法建立 CDP 页面 WebSocket 连接。");
        }
        if (expired) return;
        connected = true;
        return callback(page, pageInfo);
      })();
      const timed = new Promise((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(connected
            ? new DesktopProbeError("page", "DeepSeek Harness CDP 页面操作超时，将在下一轮重新连接。")
            : new DesktopProbeError(connectionPhase, "DeepSeek Harness CDP 页面 WebSocket 连接超时。"));
        }, this.pageOperationTimeoutMs);
      });
      return await Promise.race([operation, timed]);
    } finally {
      if (timer) clearTimeout(timer);
      // 某些 Electron CDP 版本在远端已卡住时 close() 也不会 settle。
      // 关闭仍然要发起，但 watcher 不能等待它，否则超时没有恢复效果。
      void page.close().catch(() => undefined);
    }
  }

  async call(method, payload = {}) {
    // 每次调用均建立独立 CDP 页面连接。不能把前台 watcher 排在详情/历史读取后，
    // 否则某一次页面请求停滞会让实时快照永久只读。
    return this.callNow(method, payload);
  }

  async callNow(method, payload = {}, probe = false) {
    const name = firstText(method);
    if (!/^[a-z][a-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/.test(name)) {
      throw new Error("DeepSeek Harness RPC 方法名无效。");
    }
    if (this.rpcFlavor && !probe) return this.callWithFlavor(name, payload, this.rpcFlavor);
    try {
      const value = await this.callWithFlavor(name, payload, "modern");
      this.rpcFlavor = "modern";
      return value;
    } catch (modernError) {
      if (probe && modernError instanceof DesktopProbeError) throw modernError;
      try {
        const value = await this.callWithFlavor(name, payload, "legacy");
        this.rpcFlavor = "legacy";
        return value;
      } catch (legacyError) {
        throw new Error(`DeepSeek Harness RPC 不可用：新协议失败（${errorMessage(modernError)}）；兼容协议失败（${errorMessage(legacyError)}）。`);
      }
    }
  }

  isLegacy() {
    return this.rpcFlavor === "legacy";
  }

  async callWithFlavor(name, payload, flavor) {
    const legacy = flavor === "legacy";
    const wireMethod = legacy ? legacyRoute(name) : name;
    const legacyPayload = legacy ? await this.legacyPayload(name, payload) : payload;
    const rpcId = crypto.randomUUID();
    const request = JSON.stringify({
      type: "client-request",
      rpcId,
      method: wireMethod,
      payload: legacy ? legacyPayload : payload,
    });
    return this.withPage((page) => page.evaluate(`(async () => {
      const response = await fetch(${JSON.stringify(`/api/${wireMethod}`)}, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: ${JSON.stringify(request)},
      });
      if (!response.ok) throw new Error("Harness 页面内 RPC 请求失败：" + ${JSON.stringify(wireMethod)} + " HTTP " + response.status);
      const message = await response.json();
      if (!message || message.type !== "server-response" || message.rpcId !== ${JSON.stringify(rpcId)} || !message.result) {
        throw new Error("Harness 页面内 RPC 返回了无效信封。");
      }
      if (!message.result.ok) {
        throw new Error((message.result.error && message.result.error.message) || "Harness RPC 被拒绝。");
      }
      return message.result.value;
    })()`)).then((value) => legacy ? normalizeLegacyValue(name, value) : value);
  }

  async legacyPayload(name, payload) {
    if (name === "session.list") return { args: { _request: payload } };
    if (name === "session.history") {
      const sessionId = firstText(payload && payload.sessionId);
      let throughSeq = Number(payload && payload.throughSeq);
      if (!Number.isFinite(throughSeq)) {
        const listing = await this.callWithFlavor("session.list", {}, "legacy");
        const item = Array.isArray(listing && listing.items)
          ? listing.items.find((candidate) => candidate && candidate.sessionId === sessionId)
          : null;
        const asOfSeq = item && item.projections && item.projections.asOfSeq;
        throughSeq = typeof asOfSeq === "number" ? asOfSeq : Number(asOfSeq);
      }
      if (!Number.isFinite(throughSeq)) throughSeq = -1;
      const request = {
        address: { kind: "session", sessionId },
        throughSeq,
        ...(Number.isFinite(Number(payload && payload.beforeSeq)) ? { beforeSeq: Number(payload.beforeSeq) } : {}),
        ...(Number.isFinite(Number(payload && payload.maxMessages)) ? { maxMessages: Number(payload.maxMessages) } : {}),
      };
      return { args: { request } };
    }
    if (name === "session.models") return { args: {} };
    if (name === "session.projections") {
      return { args: { request: { sessionId: firstText(payload && payload.sessionId) } } };
    }
    if (name === "commands.execute") {
      return {
        args: {
          agentId: firstText(payload && payload.agentId),
          line: firstText(payload && payload.line),
          // Harness 当前 Typert descriptor 将命令附件字段命名为 submittedAttachments；
          // 兼容旧调用方传入的 images，但线上的字段必须严格使用新名称。
          submittedAttachments: Array.isArray(payload && payload.submittedAttachments)
            ? payload.submittedAttachments
            : (Array.isArray(payload && payload.images) ? payload.images : []),
        },
      };
    }
    if (name === "workspace.list" || name === "workspace.create") {
      throw new Error("旧版 Harness 不支持 workspace RPC。");
    }
    return { args: { request: payload } };
  }

  async diagnostics() {
    let processes;
    try { processes = await this.listProcesses(); }
    catch {
      return { State: "unavailable", Code: "desktop_process_check_failed", Summary: "无法检测 DeepSeek Harness 桌面进程", Actions: ["recheck"] };
    }
    const executables = processes.map(proc => desktopExecutable(proc, this.platform)).filter(Boolean);
    const installedFiles = await Promise.all([...new Set([...this.appPaths, ...executables])].map(async file => {
      if (!/^deepseek harness(?:\.exe)?$/i.test(path.win32.basename(file))) return false;
      try {
        const info = await this.stat(file);
        return info.isFile() && (this.platform === "win32" || (info.mode & 0o111) !== 0);
      } catch { return false; }
    }));
    const Facts = { installed: installedFiles.some(Boolean), running: executables.length > 0, transport: "cdp", transport_reachable: false };
    const Actions = ["managed_relaunch", "recheck"];
    if (!Facts.installed) return { State: "not_installed", Code: "app_not_installed", Summary: "未安装 DeepSeek Harness 桌面端", Actions: ["open_download", "locate_agent", "recheck"], Facts };
    if (!Facts.running) return { State: "not_running", Code: "not_running", Summary: "DeepSeek Harness 已安装，尚未启动", Actions, Facts };
    // 托管重启可能立即换端口，诊断时直接检查进程端点。
    this.processEndpointCache.at = 0;
    try { await this.probe(); }
    catch (error) {
      if (error instanceof DesktopProbeError && error.phase === "transport") {
        return { State: "unavailable", Code: "control_channel_unreachable", Summary: "DeepSeek Harness 已运行，但 CDP 未连通", Detail: error.message, Actions, Facts };
      }
      Facts.transport_reachable = true;
      return { State: "unavailable", Code: "cdp_page_unavailable", Summary: "DeepSeek Harness 控制页面不可用",
        Detail: error instanceof DesktopProbeError ? error.message : "CDP 页面已发现，但会话列表 RPC 握手失败。", Actions, Facts };
    }
    Facts.transport_reachable = true;
    return { State: "ready", Code: "ready", Summary: "DeepSeek Harness 已连接", Facts };
  }

  async probe() {
    await this.callNow("session.list", {}, true);
  }

  async probeApprovals() {
    // 审批是新版 mux 下行协议的一部分。旧版 Typert 路由没有对应的请求关联，
    // 因而不能只因页面可访问就错误宣称支持远程审批。
    if (this.isLegacy()) return false;
    try {
      return Boolean(await this.withPage((page) => page.evaluate(`(async () => {
        const transport = window.__DSH_TRANSPORT__;
        // 桌面页面由 Electron 代理 HTTP；下行 WebSocket 必须以 streamBaseUrl 为基址，
        // 主进程才会附加已登录的本机 Cookie。普通网页则使用自身页面基址。
        const base = transport && typeof transport.streamBaseUrl === 'string' && /^https?:/i.test(transport.streamBaseUrl)
          ? transport.streamBaseUrl : window.location.href;
        const url = new URL('/api/events.mux', base);
        url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
        return await new Promise((resolve) => {
          const socket = new WebSocket(url);
          const timer = setTimeout(() => {
            try { socket.close(); } catch {}
            resolve(false);
          }, 1500);
          socket.addEventListener('open', () => {
            clearTimeout(timer);
            try { socket.close(); } catch {}
            resolve(true);
          }, { once: true });
          socket.addEventListener('error', () => {
            clearTimeout(timer);
            try { socket.close(); } catch {}
            resolve(false);
          }, { once: true });
        });
      })()`)));
    } catch {
      return false;
    }
  }

  async readInteractionFrames(timeoutMs = 650) {
    if (this.isLegacy()) return [];
    const waitMs = Math.max(100, Math.min(Number(timeoutMs) || 650, 4000));
    return this.withPage((page) => page.evaluate(`(async () => {
      const transport = window.__DSH_TRANSPORT__;
      const base = transport && typeof transport.streamBaseUrl === 'string' && /^https?:/i.test(transport.streamBaseUrl)
        ? transport.streamBaseUrl : window.location.href;
      const url = new URL('/api/events.mux', base);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      return await new Promise((resolve) => {
        const frames = [];
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          try { socket.close(); } catch {}
          resolve(frames);
        };
        // streamBaseUrl 会让 Electron 主进程识别目标 Host 并附加授权 Cookie。
        const socket = new WebSocket(url);
        const timer = setTimeout(finish, ${JSON.stringify(waitMs)});
        socket.addEventListener('message', (event) => {
          try {
            const envelope = JSON.parse(String(event.data));
            const frame = envelope && envelope.type === 'server-request' ? envelope.payload : null;
            if (!frame || !['approval/requested', 'approval/resolved', 'question/requested', 'question/resolved'].includes(frame.type)) return;
            frames.push({ ...frame, rpcId: String(envelope.rpcId || '') });
            // 待处理的审批和问题帧都会在 mux 连接时立即重放；拿到后即可关闭，避免占用页面连接。
            if (frame.type === 'approval/requested' || frame.type === 'question/requested') finish();
          } catch {
            // 单个异常帧不能中断后续重放和实时事件。
          }
        });
        socket.addEventListener('error', finish, { once: true });
        socket.addEventListener('close', finish, { once: true });
      });
    })()`)).then((value) => Array.isArray(value) ? value : []);
  }

  // 保留旧名称，供已安装版本的内部调用和测试平滑升级。
  async readApprovalFrames(timeoutMs = 650) {
    return this.readInteractionFrames(timeoutMs);
  }

  async respondApproval({ rpcId, sessionId, approvalId, outcome }) {
    const response = await this.withPage((page) => page.evaluate(`(async () => {
      const message = {
        type: 'client-response',
        rpcId: ${JSON.stringify(firstText(rpcId))},
        result: {
          ok: true,
          value: {
            sessionId: ${JSON.stringify(firstText(sessionId))},
            approvalId: ${JSON.stringify(firstText(approvalId))},
            outcome: ${JSON.stringify(firstText(outcome))},
          },
        },
      };
      const result = await fetch('/api/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!result.ok) throw new Error('Harness 审批响应失败：HTTP ' + result.status);
      return await result.json();
    })()`));
    if (!response || response.accepted !== true) {
      throw new Error(`Harness 未接受审批响应：${firstText(response && response.reason, "unknown")}`);
    }
  }

  async respondQuestion({ rpcId, sessionId, answer, cancelled = false }) {
    const response = await this.withPage((page) => page.evaluate(`(async () => {
      const message = {
        type: 'client-response',
        rpcId: ${JSON.stringify(firstText(rpcId))},
        result: ${cancelled ? JSON.stringify({ ok: false, error: { code: "cancelled", message: "用户跳过了问题", details: {} } }) : JSON.stringify({ ok: true, value: { sessionId: firstText(sessionId), answer } })},
      };
      const result = await fetch('/api/respond', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(message),
      });
      if (!result.ok) throw new Error('Harness 问题响应失败：HTTP ' + result.status);
      return await result.json();
    })()`));
    if (!response || response.accepted !== true) {
      throw new Error(`Harness 未接受问题响应：${firstText(response && response.reason, "unknown")}`);
    }
  }

  async readQuestionSurface() {
    const raw = await this.withPage((page) => page.evaluate(`(() => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement) || node.closest('[aria-hidden="true"], [inert]')) return false;
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0;
      };
      const text = (node) => String(node && node.innerText || '').replace(/\\s+/g, ' ').trim();
      const lines = (node) => String(node && node.innerText || '').split(/\\n+/).map((item) => item.trim()).filter(Boolean);
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const radios = buttons.filter((node) => ['radio', 'checkbox'].includes(String(node.getAttribute('role') || '').toLowerCase()) || /_option(?:\\s|$)/.test(String(node.className || '')));
      const submit = buttons.find((node) => /^(提交|Submit)$/i.test(text(node)));
      if (!radios.length || !submit) return null;
      let card = null;
      for (const radio of radios) {
        let parent = radio.parentElement;
        for (let depth = 0; parent && depth < 10; depth += 1, parent = parent.parentElement) {
          if (parent.contains(submit) && [...parent.querySelectorAll('button')].some((node) => radios.includes(node))) {
            card = parent;
            break;
          }
        }
        if (card) break;
      }
      if (!card || !visible(card)) return null;
      const cardRadios = radios.filter((node) => card.contains(node));
      const cardButtons = buttons.filter((node) => card.contains(node));
      const skip = cardButtons.find((node) => /^(跳过|Skip)$/i.test(text(node))) || null;
      const textarea = [...card.querySelectorAll('textarea')].find(visible) || null;
      const title = text(card.querySelector('h1, h2, h3, h4, h5, h6')) || 'DeepSeek Harness 请求你的选择';
      const options = cardRadios.map((node, index) => {
        const values = lines(node.querySelector('[class*="optionCopy"]') || node).filter((value) => !/^\\d+$/.test(value));
        return { id: 'dsh-option-0-' + index, label: values[0] || ('选项 ' + (index + 1)), ...(values.slice(1).join(' ') ? { description: values.slice(1).join(' ') } : {}) };
      });
      const identity = JSON.stringify([title, options.map((item) => [item.label, item.description || '']), Boolean(textarea), Boolean(skip)]);
      return { identity, title, options, allow_custom: Boolean(textarea), has_skip: Boolean(skip) };
    })()`));
    if (!raw || typeof raw.identity !== "string" || !Array.isArray(raw.options) || raw.options.length === 0) return null;
    const id = `desktop-question:${crypto.createHash("sha256").update(raw.identity).digest("hex")}`;
    return {
      surface_id: id,
      capability: "user_question",
      kind: "questionnaire",
      title: raw.title || "DeepSeek Harness 问题",
      questions: [{
        id: `${id}:q:0`, question: raw.title || "DeepSeek Harness 请求你的选择", multiple: false,
        allow_custom: raw.allow_custom === true, placeholder: raw.allow_custom === true ? "输入你的答案" : "",
        options: raw.options,
      }],
      inputs: [],
      actions: [
        { action_id: "submit", label: "提交", purpose: "submit_answers", available: true, requires_input: true, accepts_input: true },
        ...(raw.has_skip ? [{ action_id: "skip", label: "跳过", purpose: "skip_questions", available: true, requires_input: false, accepts_input: false }] : []),
      ],
      _identity: raw.identity,
    };
  }

  async applyQuestionSurface(surfaceId, actionId, input = "") {
    const current = await this.readQuestionSurface();
    if (!current || current.surface_id !== firstText(surfaceId) || !current.actions.some((action) => action.action_id === firstText(actionId))) {
      throw new Error("control_target_stale: DeepSeek Harness 问题已变化。");
    }
    let answer = {};
    if (actionId === "submit") {
      answer = nativeQuestionAnswer(current, input);
    }
    const outcome = await this.withPage((page) => page.evaluate(`(async () => {
      const visible = (node) => {
        if (!(node instanceof HTMLElement) || node.closest('[aria-hidden="true"], [inert]')) return false;
        const box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0;
      };
      const text = (node) => String(node && node.innerText || '').replace(/\\s+/g, ' ').trim();
      const lines = (node) => String(node && node.innerText || '').split(/\\n+/).map((item) => item.trim()).filter(Boolean);
      const buttons = [...document.querySelectorAll('button')].filter(visible);
      const radios = buttons.filter((node) => ['radio', 'checkbox'].includes(String(node.getAttribute('role') || '').toLowerCase()) || /_option(?:\\s|$)/.test(String(node.className || '')));
      const submit = buttons.find((node) => /^(提交|Submit)$/i.test(text(node)));
      if (!radios.length || !submit) return 'stale';
      let card = null;
      for (const radio of radios) {
        let parent = radio.parentElement;
        for (let depth = 0; parent && depth < 10; depth += 1, parent = parent.parentElement) {
          if (parent.contains(submit) && [...parent.querySelectorAll('button')].some((node) => radios.includes(node))) { card = parent; break; }
        }
        if (card) break;
      }
      if (!card) return 'stale';
      const cardRadios = radios.filter((node) => card.contains(node));
      const cardButtons = buttons.filter((node) => card.contains(node));
      const cardSubmit = cardButtons.find((node) => /^(提交|Submit)$/i.test(text(node)));
      const cardSkip = cardButtons.find((node) => /^(跳过|Skip)$/i.test(text(node)));
      const cardTextarea = [...card.querySelectorAll('textarea')].find(visible);
      const labels = cardRadios.map((node, index) => {
        const values = lines(node.querySelector('[class*="optionCopy"]') || node).filter((value) => !/^\\d+$/.test(value));
        return [values[0] || ('选项 ' + (index + 1)), values.slice(1).join(' ')];
      });
      const identity = JSON.stringify([${JSON.stringify(current.title)}, labels, Boolean(cardTextarea), Boolean(cardSkip)]);
      if (identity !== ${JSON.stringify(current._identity)}) return 'stale';
      const seenKey = Symbol.for('prism.dsh.question-submissions.v1');
      const seen = window[seenKey] || (window[seenKey] = new Set());
      // 只有原生卡片确实消失后才视为已提交；上一次点击可能被 React 忽略，
      // 卡片仍在时必须允许 Panel 重试。
      if (${JSON.stringify(firstText(actionId))} === 'skip') {
        if (!cardSkip) return 'stale';
        cardSkip.click();
        return 'submitted';
      }
      for (const index of ${JSON.stringify(answer.indexes || [])}) cardRadios[index]?.click();
      if (${JSON.stringify(answer.custom || '')}) {
        if (!(cardTextarea instanceof HTMLTextAreaElement)) return 'stale';
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return 'stale';
        setter.call(cardTextarea, ${JSON.stringify(answer.custom || '')});
        cardTextarea.dispatchEvent(new Event('input', { bubbles: true }));
        cardTextarea.dispatchEvent(new Event('change', { bubbles: true }));
      }
      // React 需要一轮渲染才会解除“提交”按钮的 disabled 状态；过早 click 只会选中选项而不提交。
      for (let attempt = 0; attempt < 30 && (cardSubmit?.disabled || cardSubmit?.getAttribute('aria-disabled') === 'true'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (!cardSubmit || cardSubmit.disabled || cardSubmit.getAttribute('aria-disabled') === 'true') return 'not-ready';
      cardSubmit.click();
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (!document.contains(card) || !card.querySelector('button.ggehTG_option')) {
          seen.add(identity);
          if (seen.size > 256) seen.delete(seen.values().next().value);
          return 'submitted';
        }
      }
      return 'not-submitted';
    })()`));
    if (outcome === "not-ready") throw new Error("DeepSeek Harness 提交按钮尚未就绪，请重试。");
    if (outcome === "not-submitted") throw new Error("DeepSeek Harness 未完成问题提交，请重试。");
    if (outcome !== "submitted") throw new Error("control_target_stale: DeepSeek Harness 问题已变化或已提交。");
  }

  async readSelectedSession(page) {
    const value = await page.evaluate(`(() => {
      const current = String(window.location.hash || window.location.pathname || "");
      const fromLocation = current.match(/[a-zA-Z0-9_-]{8,}/g);
      const selected = document.querySelector('[role="treeitem"][aria-selected="true"], [role="row"][aria-selected="true"], [aria-selected="true"], [data-selected="true"], [data-active="true"]');
      const candidates = [];
      if (selected) {
        candidates.push(selected, ...selected.querySelectorAll('[data-session-id], [data-sessionid], [data-row-key], a[href]'));
        let parent = selected.parentElement;
        for (let index = 0; parent && index < 3; index += 1, parent = parent.parentElement) candidates.push(parent);
      }
      const identityNode = candidates.find((node) => node && (node.getAttribute("data-session-id") || node.getAttribute("data-sessionid") || node.getAttribute("data-row-key") || node.getAttribute("href")));
      const rowKey = String(identityNode && identityNode.getAttribute("data-row-key") || "");
      const rowSession = rowKey.match(/^session:(.+)$/);
      const href = String(identityNode && identityNode.getAttribute("href") || "");
      const hrefSession = href.match(/(?:session|conversation)[/:]([a-zA-Z0-9_-]{8,})/);
      return {
        id: String(identityNode && (identityNode.getAttribute("data-session-id") || identityNode.getAttribute("data-sessionid")) || (rowSession && rowSession[1]) || (hrefSession && hrefSession[1]) || (fromLocation ? fromLocation.at(-1) : "")),
        title: String(selected && selected.innerText || "").trim(),
      };
    })()`);
    return value && typeof value === "object" ? value : { id: firstText(value), title: "" };
  }

  async readSelectedSessionId(page) {
    return firstText((await this.readSelectedSession(page)).id);
  }

  async selectedSessionId() {
    return this.withPage(async (page) => {
      return this.readSelectedSessionId(page);
    });
  }

  async selectSession(sessionId, title = "") {
    const target = firstText(sessionId);
    if (!target) throw new Error("缺少 DeepSeek Harness 会话标识。");
    return this.withPage(async (page) => {
      const selectVisible = async () => page.evaluate(`(() => {
        const sessionId = ${JSON.stringify(target)};
        const links = Array.from(document.querySelectorAll('a[href], [data-session-id], [data-sessionid], [data-row-key], [role="treeitem"], [role="row"]'));
        const expectedTitle = ${JSON.stringify(firstText(title))};
        const item = links.find((node) => {
          const identity = String(node.getAttribute('data-session-id') || node.getAttribute('data-sessionid') || node.getAttribute('data-row-key') || node.getAttribute('href') || '');
          if (identity.includes(sessionId) || identity === 'session:' + sessionId) return true;
          return Boolean(expectedTitle) && String(node.innerText || '').includes(expectedTitle);
        });
        if (item instanceof HTMLElement) {
          item.click();
          return { changed: true, mechanism: 'session-row' };
        }
        const current = String(window.location.hash || '');
        if (current.includes(sessionId)) return { changed: true, mechanism: 'already-selected' };
        return { changed: false, mechanism: 'session-row-not-found' };
      })()`);
      let value = (await selectVisible()) || {};
      if (!value.changed) {
        const workspaces = await page.evaluate(`(() => {
          const keyed = Array.from(document.querySelectorAll('[role="treeitem"][data-row-key^="workspace:"]'))
            .map((node) => node.getAttribute('data-row-key')).filter(Boolean);
          if (keyed.length) return keyed;
          return Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded="false"]')).map((node) => node.innerText || '').filter(Boolean);
        })()`);
        for (const workspace of workspaces) {
          await page.evaluate(`(() => {
            const key = ${JSON.stringify(workspace)};
            const node = document.querySelector('[data-row-key=' + JSON.stringify(key) + ']')
              || Array.from(document.querySelectorAll('[role="treeitem"][aria-expanded="false"]')).find((item) => String(item.innerText || '') === key);
            if (node instanceof HTMLElement) node.click();
          })()`);
          await new Promise((resolve) => setTimeout(resolve, 120));
          value = (await selectVisible()) || {};
          if (value.changed) break;
        }
      }
      if (!value.changed && firstText(title)) {
        value = (await page.evaluate(`(async () => {
          const expectedTitle = ${JSON.stringify(firstText(title))};
          const searchButton = document.querySelector('button[aria-label*="搜索会话"], button[aria-label*="Search sessions"]');
          if (searchButton instanceof HTMLElement && searchButton.getAttribute('aria-expanded') !== 'true') searchButton.click();
          const input = document.querySelector('input[placeholder*="搜索会话"], input[aria-label*="搜索会话"], input[placeholder*="Search sessions"], input[aria-label*="Search sessions"]');
          if (!(input instanceof HTMLInputElement)) return { changed: false, mechanism: 'search-input-not-found' };
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (!setter) return { changed: false, mechanism: 'search-input-unavailable' };
          setter.call(input, expectedTitle);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          await new Promise((resolve) => setTimeout(resolve, 700));
          const rows = Array.from(document.querySelectorAll('[role="treeitem"]'));
          const result = rows.find((node) => String(node.innerText || '').includes(expectedTitle));
          if (!(result instanceof HTMLElement)) return { changed: false, mechanism: 'search-result-not-found' };
          result.click();
          return { changed: true, mechanism: 'session-search' };
        })()`)) || {};
      }
      if (!value.changed) throw new Error("DeepSeek Harness 桌面界面中找不到目标会话；该会话可能属于未注册工作区、已归档或是空白会话。");
      await new Promise((resolve) => setTimeout(resolve, 250));
      const selected = await this.readSelectedSession(page);
      const titleMatch = Boolean(title) && selected.title.includes(String(title).trim());
      if (selected.id !== target && !titleMatch) throw new Error(`桌面会话切换未确认，期望 ${target}，实际 ${selected.id || selected.title || "未知"}。`);
      this.confirmedSessionId = target;
      this.foregroundRevision += 1;
      return { selected: selected.id, title: selected.title, title_match: titleMatch, mechanism: value.mechanism };
    });
  }

  async verifySession(sessionId, marker = "", title = "") {
    const target = firstText(sessionId);
    return this.withPage(async (page) => {
      const selected = await this.readSelectedSession(page);
      const bodyText = await page.evaluate("String(document.body && document.body.innerText || '')");
      const titleOk = Boolean(title) && selected.title.includes(String(title).trim());
      const selectedOk = selected.id === target || titleOk;
      const markerOk = !marker || bodyText.includes(String(marker));
      return {
        visible: selectedOk && markerOk,
        selected: selected.id,
        title: selected.title,
        title_match: titleOk,
        marker_found: markerOk,
      };
    });
  }

  async *watchSession(sessionId, signal, intervalMs = 750) {
    let lastSeq = -1;
    while (!signal || !signal.aborted) {
      try {
        const listing = await this.call("session.list", {});
        const current = (listing && listing.items || []).find((item) => item && item.sessionId === sessionId);
        const history = await this.call("session.history", { sessionId, maxMessages: 100 });
        const events = Array.isArray(history && history.events) ? history.events : [];
        for (const row of events) {
          const event = row && row.event || row;
          const seq = Number(event && event.seq);
          if (!event || !Number.isFinite(seq) || seq <= lastSeq) continue;
          lastSeq = seq;
          yield { sessionId, type: "session/event", event };
        }
      } catch {
        // 页面暂时不可用时继续轮询，调用方负责在取消信号后结束订阅。
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }

  async *watchHost(signal, intervalMs = 1000) {
    let previous = new Map();
    let previousForeground = "";
    let reportedForegroundRevision = this.foregroundRevision;
    let previousQuestion = null;
    let questionRevision = 0;
    let lastFailure = "";
    while (!signal || !signal.aborted) {
      try {
        // mux 会重放尚未处理的审批请求，短连接轮询不会丢失请求，也不会长期占用
        // Electron 页面中的 WebSocket。旧版 Harness 没有该协议，直接跳过。
        if (this.rpcFlavor === "modern") {
          const interactionFrames = await this.readInteractionFrames(Math.min(650, intervalMs));
          for (const frame of interactionFrames) yield frame;
        }
        const response = await this.call("session.list", {});
        const current = new Map((Array.isArray(response && response.items) ? response.items : [])
          .filter((item) => item && item.sessionId)
          .map((item) => [item.sessionId, item]));
        // 目录投影由 Harness 持久化，且包含最新活动时间；用它作为 watcher 的首轮前台
        // 判定，避免为读取 DOM 选中态再建立一条 CDP 连接而阻塞实时快照。
        const latestSessionId = [...current.entries()]
          .filter(([, item]) => !Boolean(item && item.blank))
          .sort(([, left], [, right]) => Number(right && right.updatedAt || 0) - Number(left && left.updatedAt || 0))[0]?.[0] || "";
        const forceConfirmed = this.foregroundRevision !== reportedForegroundRevision && current.has(this.confirmedSessionId);
        const foreground = forceConfirmed ? this.confirmedSessionId : latestSessionId;
        const foregroundTransition = foreground !== previousForeground;
        const foregroundConfirmed = Boolean(foreground) && this.foregroundRevision !== reportedForegroundRevision;
        if (foregroundTransition || foregroundConfirmed) {
          if (foregroundTransition && previousForeground && current.has(previousForeground)) {
            yield { type: "host/session-foreground", sessionId: previousForeground, foreground: false, item: current.get(previousForeground) };
          }
          if (foreground && current.has(foreground)) {
            yield { type: "host/session-foreground", sessionId: foreground, foreground: true, item: current.get(foreground) };
          }
          previousForeground = foreground;
          reportedForegroundRevision = this.foregroundRevision;
        }
        for (const [sessionId, item] of current) {
          const old = previous.get(sessionId);
          if (!old) yield { type: "host/session-added", sessionId, item };
          if (!old || Boolean(old.running) !== Boolean(item.running) || old.updatedAt !== item.updatedAt) {
            yield { type: "host/session-status", sessionId, running: Boolean(item.running), foreground: sessionId === foreground, foregroundTransition: foregroundTransition && sessionId === foreground, item };
          }
        }
        for (const sessionId of previous.keys()) {
          if (!current.has(sessionId)) yield { type: "host/session-removed", sessionId };
        }
        // 某些桌面版本不会向页面的 mux WebSocket 重放 ask_user_question。
        // 先发布会话发现与前台状态，再发布问题卡，Hub 才能将交互快照关联到对应会话。
        const visibleQuestion = foreground ? await this.readQuestionSurface().catch(() => null) : null;
        const questionIdentity = visibleQuestion && visibleQuestion._identity;
        if (questionIdentity && previousQuestion && questionIdentity !== previousQuestion.identity) {
          yield { type: "question/resolved", source: "desktop-dom", sessionId: foreground, questionRpcId: previousQuestion.rpcId };
        }
        if (questionIdentity && questionIdentity !== (previousQuestion && previousQuestion.identity)) {
          const rpcId = `desktop-dom:${visibleQuestion.surface_id}:${++questionRevision}`;
          yield { type: "question/requested", source: "desktop-dom", rpcId, sessionId: foreground, surface: visibleQuestion };
        } else if (!questionIdentity && previousQuestion) {
          yield { type: "question/resolved", source: "desktop-dom", sessionId: foreground, questionRpcId: previousQuestion.rpcId };
        }
        previousQuestion = questionIdentity ? { identity: questionIdentity, surfaceId: visibleQuestion.surface_id, rpcId: previousQuestion && questionIdentity === previousQuestion.identity ? previousQuestion.rpcId : `desktop-dom:${visibleQuestion.surface_id}:${questionRevision}` } : null;
        previous = current;
        lastFailure = "";
      } catch (error) {
        const message = errorMessage(error);
        if (message !== lastFailure) {
          console.error("DeepSeek Harness 前台监听失败，将继续重试：", message);
          lastFailure = message;
        }
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
      });
    }
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

module.exports = { DshDesktopController, cdpCandidates, configuredCdpPorts, commandUserDataDir, commandRemoteDebuggingPort,
  dshDesktopMainProcesses, nativeQuestionAnswer };
