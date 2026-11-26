"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createAdapter } = require("../index");
const {
  DshDesktopController, dshAppCandidates, dshDesktopProcesses, sanitizeDiagnosticText,
} = require("../dsh_cdp");

function installedStat() {
  return async () => ({ isFile: () => true, isDirectory: () => false });
}

function desktopProcess(command = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness") {
  return [{ pid: 100, command }];
}

function controller(options = {}) {
  return new DshDesktopController({
    platform: "darwin", home: "/Users/tester", stat: installedStat(),
    listProcesses: async () => desktopProcess(), fetch: async () => ({ ok: false, status: 503 }), verifyPage: async () => true,
    ...options,
  });
}

test("只有 dsh CLI 时诊断为桌面端未安装", async () => {
  const value = await new DshDesktopController({
    platform: "linux", home: "/home/tester", stat: async () => { throw new Error("不存在"); },
    listProcesses: async () => [{ pid: 1, command: "dsh-cli --version" }], fetch: async () => ({ ok: false }),
  }).diagnose();
  assert.equal(value.State, "not_installed");
  assert.equal(value.Code, "app_not_installed");
  assert.equal(value.Facts.installed, false);
});

test("桌面端未安装时不会显示进程或 CDP 错误", async () => {
  const value = await new DshDesktopController({
    platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", ProgramFiles: "C:\\Program Files" },
    stat: async () => { throw new Error("不存在"); }, listProcesses: async () => [], fetch: async () => ({ ok: false }),
  }).diagnose();
  assert.deepEqual({ state: value.State, code: value.Code, installed: value.Facts.installed, running: value.Facts.running }, { state: "not_installed", code: "app_not_installed", installed: false, running: false });
});

test("桌面端已安装但进程未运行", async () => {
  const value = await controller({ listProcesses: async () => [] }).diagnose();
  assert.equal(value.State, "not_running");
  assert.equal(value.Code, "not_running");
  assert.equal(value.Facts.installed, true);
  assert.equal(value.Facts.running, false);
});

test("进程运行但 DevToolsActivePort 不存在时诊断为 CDP 未连通", async () => {
  const value = await controller({ userDataDir: "/tmp/dsh-profile", readFile: async () => { throw new Error("文件不存在"); }, fetch: async () => { throw new Error("连接被拒绝"); } }).diagnose();
  assert.equal(value.Code, "control_channel_unreachable");
  assert.equal(value.Facts.running, true);
  assert.equal(value.Facts.transport_reachable, false);
});

test("CDP 端口不可访问时诊断为控制通道不可达", async () => {
  const value = await controller({ fetch: async () => ({ ok: false, status: 404 }) }).diagnose();
  assert.equal(value.Code, "control_channel_unreachable");
});

test("CDP 可访问但没有目标页面", async () => {
  const value = await controller({ fetch: async () => ({ ok: true, json: async () => [{ type: "service", url: "devtools://devtools" }] }) }).diagnose();
  assert.equal(value.Code, "cdp_page_unavailable");
  assert.equal(value.Facts.transport_reachable, true);
});

test("CDP 页面存在但 RPC 握手失败", async () => {
  const instance = controller({
    fetch: async () => ({ ok: true, json: async () => [{ type: "page", title: "DeepSeek Harness", url: "dsh-app://app/", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/x" }] }),
  });
  instance.probe = async () => { throw new Error("Harness 页面内 RPC 请求失败：session.list HTTP 404"); };
  const value = await instance.diagnose();
  assert.equal(value.Code, "rpc_handshake_failed");
  assert.equal(value.Facts.transport_reachable, true);
});

test("CDP 和 RPC 都正常时返回 ready 且清空旧错误", async () => {
  const instance = controller({
    fetch: async () => ({ ok: true, json: async () => [{ type: "page", title: "DeepSeek Harness", url: "dsh-app://app/", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/x" }] }),
  });
  instance.probe = async () => {};
  const value = await instance.diagnose();
  assert.deepEqual(value, {
    State: "ready", Code: "ready", Summary: "DeepSeek Harness 已连接",
    Detail: "桌面程序、进程、CDP 控制页面和 RPC 均可用。", Component: "DeepSeek Harness",
    Actions: ["recheck"], Facts: { installed: true, running: true, transport: "cdp", transport_reachable: true }, Stack: "",
  });
});

test("失败恢复为 ready 后不复用上一次诊断错误", async () => {
  let reachable = false;
  const instance = controller({
    fetch: async () => reachable
      ? { ok: true, json: async () => [{ type: "page", title: "DeepSeek Harness", url: "dsh-app://app/", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/page/x" }] }
      : { ok: false, status: 503 },
  });
  instance.probe = async () => {};
  const value = await instance.diagnose();
  assert.equal(value.Code, "control_channel_unreachable");
  reachable = true;
  const recovered = await instance.diagnose();
  assert.equal(recovered.Code, "ready");
  assert.equal(recovered.Stack, "");
  assert.equal(recovered.Detail, "桌面程序、进程、CDP 控制页面和 RPC 均可用。");
});

test("Windows、macOS 路径和进程识别不把 CLI 当作桌面端", () => {
  const windows = dshAppCandidates("win32", { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", ProgramFiles: "C:\\Program Files" }, "C:\\Users\\tester");
  assert.ok(windows.some((value) => value.endsWith("DeepSeek Harness.exe")));
  const mac = dshAppCandidates("darwin", {}, "/Users/tester");
  assert.ok(mac.some((value) => value.endsWith("DeepSeek Harness.app")));
  assert.deepEqual(dshDesktopProcesses([
    { pid: 1, command: "DeepSeek Harness.exe --remote-debugging-port=9222" },
    { pid: 2, command: "dsh-cli --remote-debugging-port=9222" },
    { pid: 3, command: "DeepSeek Harness Helper --type=renderer" },
  ]).map((value) => value.pid), [1]);
});

test("诊断堆栈会脱敏并限制长度", () => {
  const value = sanitizeDiagnosticText("Authorization: Bearer secret Cookie: session=secret /Users/fengling/private " + "x".repeat(5000));
  assert.doesNotMatch(value, /secret/);
  assert.match(value, /<已脱敏>/);
  assert.ok(value.length <= 4097);
});

test("Probe 超时返回可识别诊断 Code", async () => {
  const desktop = new DshDesktopController({
    diagnosticTimeoutMs: 10, stat: async () => new Promise(() => {}),
  });
  desktop.diagnose = DshDesktopController.prototype.diagnose.bind(desktop);
  const value = await desktop.diagnose();
  assert.equal(value.Code, "diagnostic_timeout");
});

test("Probe 保留旧字段并返回结构化 Diagnostics", async () => {
  const adapter = createAdapter({ desktop: { call() {}, async diagnose() { return { State: "not_running", Code: "not_running", Summary: "已安装，尚未启动", Detail: "未启动", Component: "DeepSeek Harness", Actions: ["recheck"], Facts: { installed: true, running: false, transport: "cdp", transport_reachable: false }, Stack: "" }; } }, client: {} });
  const value = await adapter.probe();
  assert.equal(value.Available, false);
  assert.equal(value.UnavailableReason, "未启动");
  assert.equal(value.Diagnostics.Code, "not_running");
});
