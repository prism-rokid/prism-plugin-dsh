"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const { createAdapter, historyTurns, textOf } = require("../index");
const { DshClient } = require("../dsh_client");
const { DshDesktopController } = require("../dsh_cdp");

// 使用可实际解码的图像，覆盖 Harness 的图像准入而非仅验证 base64 编码结构。
const VALID_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test("CDP 通过桌面认证 WebSocket mux 接收 ask_user_question", async () => {
  const question = {
    type: "server-request",
    rpcId: "rpc-question-sse",
    method: "question/requested",
    payload: {
      type: "question/requested",
      sessionId: "s-question-sse",
      questions: [{ id: "task", header: "下一步", question: "选择任务", options: [{ label: "审查" }], multiSelect: false }],
    },
  };
  const socketURLs = [];
  class FakeSocket {
    constructor(url) {
      socketURLs.push(String(url));
      this.listeners = new Map();
      queueMicrotask(() => this.emit("message", { data: JSON.stringify(question) }));
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener);
      this.listeners.set(type, listeners);
    }
    emit(type, value) {
      for (const listener of this.listeners.get(type) || []) listener(value);
    }
    close() {}
  }
  const controller = new DshDesktopController();
  controller.rpcFlavor = "modern";
  controller.withPage = async (callback) => callback({
    async evaluate(source) {
      return new Function("WebSocket", "window", `return ${source}`)(FakeSocket, {
        location: { href: "dsh-app://app/" },
        __DSH_TRANSPORT__: { streamBaseUrl: "http://dsh.local/" },
      });
    },
  });

  const frames = await controller.readInteractionFrames(100);
  assert.deepEqual(socketURLs, ["ws://dsh.local/api/events.mux"]);
  assert.deepEqual(frames, [{
    type: "question/requested", rpcId: "rpc-question-sse", sessionId: "s-question-sse",
    questions: question.payload.questions,
  }]);
});

function event(type, seq, data, time = 1700000000000) {
  return { event: { type, seq, time, data } };
}

function fakeClient() {
  const calls = [];
  let prompted = false;
  const summaries = [{ sessionId: "s-1", updatedAt: 1700000000000, running: false, blank: false, cwd: "/tmp/demo", projections: { asOfSeq: 3, values: { title: "测试会话", tokenUsage: { inputTokens: 12, outputTokens: 8 }, contextPressure: { ratio: 0.2 } } } }];
  const events = [
    event("turn/start", 0, { turn: 1 }),
    event("user/message", 1, { turn: 1, id: "u-1", role: "user", content: [{ type: "text", text: "你好" }] }),
    event("assistant/message", 2, { turn: 1, message: { id: "a-1", role: "assistant", content: [{ type: "text", text: "你好，我是 Harness。" }] }, usage: { inputTokens: 12, outputTokens: 8 } }),
    event("turn/end", 3, { turn: 1, reason: { kind: "completed" } }),
  ];
  return {
    baseUrl: "http://127.0.0.1:3080",
    calls,
    async probe() {},
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "session.list") return { items: summaries };
      if (method === "session.history") return { events: (prompted ? [...events, event("assistant/message", 4, { turn: 1, message: { id: "a-2", role: "assistant", content: [{ type: "text", text: "继续回答" }] } })] : events), projections: { asOfSeq: 3, values: summaries[0].projections.values }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "DeepSeek Chat", reasoning: { efforts: [{ id: "standard", name: "标准" }] } }] }], failures: [] };
      if (method === "session.prompt") prompted = true;
      return { accepted: true };
    },
  };
}

test("manifest 为两个运行模式声明稳定权限控制", async () => {
  const manifest = await fs.readFile(path.join(__dirname, "..", "pluginbridge-plugin.yaml"), "utf8");
  for (const mode of ["desktop", "native"]) {
    const block = manifest.match(new RegExp(`  ${mode}:\\n((?:    [^\\n]+\\n)*)`));
    assert.ok(block, `缺少 ${mode} 运行模式控制声明`);
    assert.match(block[1], /^    permission: stable$/m, `${mode} 模式必须发布稳定权限选项`);
  }
});

test("Harness history is grouped into complete Prism turns", () => {
  const turns = historyTurns([
    event("turn/start", 0, { turn: 1 }),
    event("user/message", 1, { turn: 1, id: "u", source: { kind: "user" }, content: [{ type: "text", text: "问题" }] }),
    event("user/message", 2, { turn: 1, id: "u-context", source: { kind: "time-context" }, content: [{ type: "text", text: "内部时间上下文" }] }),
    event("assistant/message", 3, { turn: 1, message: { id: "a-tool", source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }, content: [{ type: "reasoning", text: "内部思考" }, { type: "tool-call", name: "shell" }] } }),
    event("assistant/message", 4, { turn: 1, message: { id: "a-middle", source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }, content: [{ type: "text", text: "中间步骤" }] } }),
    event("assistant/message", 5, { turn: 1, message: { id: "a", source: { kind: "model", provider: "deepseek", model: "deepseek-chat" }, content: [{ type: "reasoning", text: "内部思考" }, { type: "text", text: "答案" }] } }),
  ]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].messages.length, 2);
  assert.equal(turns[0].messages[0].Content, "问题");
  assert.equal(turns[0].messages[1].Content, "答案");
});

test("实时历史流在初始页结束后继续推送 Harness 回复", async () => {
  let events = [
    event("turn/start", 1, { turn: 1 }),
    event("user/message", 2, { turn: 1, id: "u-live", role: "user", content: [{ type: "text", text: "请回复" }] }),
  ];
  const client = {
    async call(method) {
      if (method === "session.history") return { events, hasMore: false };
      throw new Error(`未预期的请求：${method}`);
    },
  };
  const adapter = createAdapter({ client, desktop: {} });
  const controller = new AbortController();
  const iterator = adapter.readHistoryStream(
    { NativeSessionID: "s-live" },
    { stream_id: "history-live", limit: 20, live: true },
    controller.signal,
  )[Symbol.asyncIterator]();

  const initial = await iterator.next();
  assert.equal(initial.value.type, "turn");
  assert.equal(initial.value.source, "initial");
  const pageEnd = await iterator.next();
  assert.equal(pageEnd.value.type, "page_end");

  events = [...events, event("assistant/message", 3, {
    turn: 1,
    message: { id: "a-live", role: "assistant", content: [{ type: "text", text: "Harness 已回复" }] },
  })];
  const update = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("实时历史流未收到 Harness 回复")), 1500)),
  ]);
  assert.equal(update.value.type, "turn");
  assert.equal(update.value.source, "live");
  assert.equal(update.value.operation, "replace");
  assert.equal(update.value.turn.messages.at(-1).Content, "Harness 已回复");

  controller.abort();
  await iterator.return();
});

test("adapter lists, reads detail, and switches model through Harness RPC", async () => {
  const client = fakeClient();
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}), selectSession: async () => ({}) } });
  const listed = await adapter.listSessions();
  assert.equal(listed[0].NativeSessionID, "s-1");
  assert.equal(listed[0].Title, "测试会话");
  const detail = await adapter.readDetail(listed[0]);
  assert.deepEqual(detail.token_usage, { inputTokens: 12, outputTokens: 8 });
  assert.equal(detail.model, "deepseek-chat");
  assert.equal(detail.current_model.model, "deepseek-chat");
  assert.equal(detail.current_model.target.option_id, "deepseek:deepseek-chat");
  assert.equal(detail.model_options[0].target.option_id, "deepseek:deepseek-chat");
  await adapter.controlSession({ session: listed[0], action: "model.switch", target: { option_id: "deepseek:deepseek-chat" } });
  assert.ok(client.calls.some((call) => call.method === "session.selectModel"));
});

test("权限详情映射 Harness 投影并通过原生命令 RPC 切换", async () => {
  const calls = [];
  const desktop = {
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "session.list") return { items: [{ sessionId: "s-permission", running: false, projections: { values: { title: "权限会话" } } }] };
      if (method === "session.history") return {
        events: [], hasMore: false,
        projections: { values: { permissions: {
          currentValue: "workspace-write",
          options: [
            { value: "read-only", name: "Read only" },
            { value: "workspace-write", name: "Workspace write" },
            { value: "danger-full-access", name: "Full access" },
          ],
        } } },
      };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      if (method === "commands.execute") return { commandId: "command-permission", result: { kind: "success" } };
      throw new Error(`未预期的请求：${method}`);
    },
    
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const detail = await adapter.readDetail({ NativeSessionID: "s-permission" });
  assert.equal(detail.current_permission.id, "workspace-write");
  assert.deepEqual(detail.permission_options.map((option) => option.id), ["read-only", "workspace-write", "danger-full-access"]);
  assert.equal(detail.actions.find((action) => action.id === "permission.switch").available, true);
  const result = await adapter.controlSession({ session: { NativeSessionID: "s-permission" }, action: "permission.switch", target: { option_id: "danger-full-access" } });
  assert.deepEqual(calls.find((call) => call.method === "commands.execute"), {
    method: "commands.execute",
    payload: { agentId: "s-permission", line: "/permission danger-full-access", submittedAttachments: [] },
  });
  assert.equal(calls.some((call) => call.method === "session.prompt"), false);
  assert.equal(result.details_confirmed, true);
});

test("审批请求会转换为 Hub 标准审批事件，并能回传允许一次", async () => {
  const calls = [];
  const desktop = {
    async probe() {},
    async probeApprovals() { return true; },
    async respondApproval(payload) { calls.push(payload); },
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-approval", running: true, projections: { values: { title: "审批会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      throw new Error(`未预期的请求：${method}`);
    },
    async *watchHost() {
      yield { type: "approval/requested", rpcId: "rpc-approval", sessionId: "s-approval", approvalId: "approval-1", toolName: "bash", callId: "call-1", reason: "需要执行命令" };
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  assert.equal((await adapter.probe()).CanApproval, true);
  const iterator = adapter.subscribePlugin(new AbortController().signal);
  const requested = (await iterator.next()).value;
  assert.equal(requested.Type, "approval.required");
  assert.equal(requested.Status, "waiting_approval");
  assert.equal(requested.Payload.approval_request_id, "approval-1");
  assert.deepEqual(requested.Payload.actions.map((action) => action.id), ["allowed-once", "rejected"]);
  assert.equal(requested.Payload.detail_snapshot.run.approval_blocked, true);

  await adapter.resolveApproval({ Session: { NativeSessionID: "s-approval" }, ApprovalRequestID: "approval-1", ActionID: "allow-once" });
  assert.deepEqual(calls, [{ rpcId: "rpc-approval", sessionId: "s-approval", approvalId: "approval-1", outcome: "allowed-once" }]);
});

test("审批最终事件会清除 Hub 详情中的审批状态", async () => {
  const desktop = {
    async call() { return { items: [] }; },
    async *watchHost() {
      yield { type: "approval/requested", rpcId: "rpc-approval", sessionId: "s-approval", approvalId: "approval-1", toolName: "write" };
      yield { type: "approval/resolved", rpcId: "rpc-approval", sessionId: "s-approval", approvalId: "approval-1", outcome: "rejected" };
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const iterator = adapter.subscribePlugin(new AbortController().signal);
  await iterator.next();
  const resolved = (await iterator.next()).value;
  assert.equal(resolved.Type, "approval.resolved");
  assert.equal(resolved.Payload.detail_snapshot.approval, null);
  assert.equal(resolved.Payload.detail_snapshot.run.approval_blocked, false);
});

test("审批回传成功后会立即清除 Panel 审批卡片，不依赖瞬时 mux 广播", async () => {
  const desktop = {
    async probe() {},
    async probeApprovals() { return true; },
    async respondApproval() {},
    async call() { return { items: [] }; },
    async *watchHost(signal) {
      yield { type: "approval/requested", rpcId: "rpc-approval", sessionId: "s-approval", approvalId: "approval-1", toolName: "write" };
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  await adapter.probe();
  const controller = new AbortController();
  const iterator = adapter.subscribePlugin(controller.signal);
  assert.equal((await iterator.next()).value.Type, "approval.required");
  await adapter.resolveApproval({ Session: { NativeSessionID: "s-approval" }, ApprovalRequestID: "approval-1", ActionID: "rejected" });
  const resolved = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("审批完成事件未及时送达")), 500)),
  ]);
  assert.equal(resolved.value.Type, "approval.resolved");
  assert.equal(resolved.value.Payload.detail_snapshot.approval, null);
  controller.abort();
});

test("ask_user_question 会映射为 Panel 问题界面并回传结构化回答", async () => {
  const responses = [];
  const desktop = {
    async probe() {},
    async probeApprovals() { return true; },
    async respondQuestion(payload) { responses.push(payload); },
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-question", running: true, projections: { values: { title: "提问会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      throw new Error(`未预期的请求：${method}`);
    },
    async *watchHost(signal) {
      yield {
        type: "question/requested", rpcId: "rpc-question", sessionId: "s-question",
        questions: [
          { id: "task", header: "选择任务", question: "现在做什么？", options: [{ label: "审查代码" }, { label: "运行测试" }] },
          { id: "notes", question: "补充说明", multiSelect: true, options: [{ label: "需要报告" }, { label: "需要截图" }] },
        ],
      };
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const controller = new AbortController();
  const iterator = adapter.subscribePlugin(controller.signal);
  const requested = (await iterator.next()).value;
  const surface = requested.Payload.detail_snapshot.interactive_surface;
  assert.equal(requested.Type, "dsh.question.requested");
  assert.equal(surface.kind, "questionnaire");
  assert.equal(surface.questions[0].options[0].id, "dsh-option-0-0");
  assert.equal(requested.Payload.detail_snapshot.desktop_foreground, true);

  const result = await adapter.controlSession({
    session: { NativeSessionID: "s-question" }, action: "interactive.surface.apply",
    target: {
      surface_id: surface.surface_id, action_id: "submit",
      input: JSON.stringify({ answers: [
        { selectedOptionIds: ["dsh-option-0-1"], freeformText: "" },
        { selectedOptionIds: ["dsh-option-1-0", "dsh-option-1-1"], freeformText: "也请给出结论" },
      ] }),
    },
  });
  assert.deepEqual(responses, [{
    rpcId: "rpc-question", sessionId: "s-question",
    answer: { answers: [
      { id: "task", selected: ["运行测试"] },
      { id: "notes", selected: ["需要报告", "需要截图"], custom: "也请给出结论" },
    ] },
  }]);
  assert.equal(result.details.interactive_surface, null);
  const resolved = await Promise.race([
    iterator.next(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("问题完成事件未及时送达")), 500)),
  ]);
  assert.equal(resolved.value.Type, "dsh.question.resolved");
  assert.equal(resolved.value.Payload.detail_snapshot.interactive_surface, null);
  controller.abort();
});

test("桌面原生问题卡会发布为 Panel 问题并回写原生控件", async () => {
  const applied = [];
  const nativeSurface = {
    surface_id: "desktop-question:card-1", capability: "user_question", kind: "questionnaire", title: "还要继续调用弹层吗？",
    questions: [{ id: "desktop-question:card-1:q:0", question: "还要继续调用弹层吗？", multiple: false, allow_custom: true, placeholder: "输入你的答案", options: [
      { id: "dsh-option-0-0", label: "继续调用" }, { id: "dsh-option-0-1", label: "停止" },
    ] }],
    inputs: [], actions: [
      { action_id: "submit", label: "提交", purpose: "submit_answers", available: true, requires_input: true, accepts_input: true },
      { action_id: "skip", label: "跳过", purpose: "skip_questions", available: true, requires_input: false, accepts_input: false },
    ], _identity: "card-1",
  };
  const desktop = {
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-native-question", running: true, projections: { values: { title: "原生提问会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      throw new Error(`未预期的请求：${method}`);
    },
    async applyQuestionSurface(...args) { applied.push(args); },
    async *watchHost(signal) {
      yield { type: "question/requested", source: "desktop-dom", sessionId: "s-native-question", surface: nativeSurface };
      await new Promise((resolve) => signal?.addEventListener("abort", resolve, { once: true }));
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const controller = new AbortController();
  const iterator = adapter.subscribePlugin(controller.signal);
  const requested = (await iterator.next()).value;
  const surface = requested.Payload.detail_snapshot.interactive_surface;
  assert.equal(surface.capability, "user_question");
  assert.equal(surface.questions[0].options[0].label, "继续调用");
  await adapter.controlSession({
    session: { NativeSessionID: "s-native-question" }, action: "interactive.surface.apply",
    target: { surface_id: surface.surface_id, action_id: "submit", input: JSON.stringify({ answers: [{ selectedOptionIds: ["dsh-option-0-0"], freeformText: "" }] }) },
  });
  assert.deepEqual(applied, [[surface.surface_id, "submit", JSON.stringify({ answers: [{ selectedOptionIds: ["dsh-option-0-0"], freeformText: "" }] })]]);
  controller.abort();
});

test("CDP 原生问题卡读取会生成稳定的 questionnaire", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  controller.withPage = async (callback) => callback({
    async evaluate() {
      return { identity: "native-card", title: "请选择", options: [{ id: "dsh-option-0-0", label: "继续" }], allow_custom: true, has_skip: true };
    },
  });
  const surface = await controller.readQuestionSurface();
  assert.equal(surface.kind, "questionnaire");
  assert.equal(surface.capability, "user_question");
  assert.equal(surface.questions[0].options[0].label, "继续");
  assert.equal(surface.actions[1].action_id, "skip");
});

test("Panel 的原生问题选项 ID 会映射为桌面选项索引", () => {
  const { nativeQuestionAnswer } = require("../dsh_cdp");
  const answer = nativeQuestionAnswer({
    questions: [{ allow_custom: true, options: [{ id: "dsh-option-0-0", label: "继续调用" }, { id: "dsh-option-0-1", label: "停止" }] }],
  }, JSON.stringify({ answers: [{ selectedOptionIds: ["dsh-option-0-0"], freeformText: "" }] }));
  assert.deepEqual(answer, { indexes: [0], custom: "" });
});

test("原生问题提交失败时不会把卡片提前标记为已提交", async () => {
  const { DshDesktopController } = require("../dsh_cdp");
  const controller = new DshDesktopController();
  controller.readQuestionSurface = async () => ({ surface_id: "desktop-question:test", title: "问题", _identity: "identity", questions: [{ allow_custom: true, options: [{ id: "dsh-option-0-0", label: "继续" }] }], actions: [{ action_id: "submit" }] });
  controller.withPage = async (callback) => callback({ evaluate: async () => "not-submitted" });
  await assert.rejects(() => controller.applyQuestionSurface("desktop-question:test", "submit", JSON.stringify({ answers: [{ selectedOptionIds: ["dsh-option-0-0"], freeformText: "" }] })), /未完成问题提交/);
});

test("CDP 兼容协议将原生权限命令编码为 commands.execute", async () => {
  const { DshDesktopController } = require("../dsh_cdp");
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const payload = await controller.legacyPayload("commands.execute", {
    agentId: "s-permission", line: "/permission danger-full-access", images: [],
  });
  assert.deepEqual(payload, { args: { agentId: "s-permission", line: "/permission danger-full-access", submittedAttachments: [] } });
});

test("CDP 兼容协议优先保留 Harness 新命令附件字段", async () => {
  const { DshDesktopController } = require("../dsh_cdp");
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const payload = await controller.legacyPayload("commands.execute", {
    agentId: "s-permission", line: "/permission workspace-write", submittedAttachments: [],
  });
  assert.deepEqual(payload, { args: { agentId: "s-permission", line: "/permission workspace-write", submittedAttachments: [] } });
});

test("旧版权限投影缺少目录时提供 Harness 默认预设", async () => {
  const desktop = {
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-legacy-permission", running: false, projections: { values: { title: "旧版权限会话" } } }] };
      if (method === "session.history") return { events: [], hasMore: false };
      if (method === "session.projections") return { values: { permissions: { currentValue: "workspace-write" } } };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      throw new Error(`未预期的请求：${method}`);
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const detail = await adapter.readDetail({ NativeSessionID: "s-legacy-permission" });
  assert.equal(detail.current_permission.id, "workspace-write");
  assert.deepEqual(detail.permission_options.map((option) => option.id), ["workspace-write", "danger-full-access"]);
  assert.equal(detail.actions.find((action) => action.id === "permission.switch").available, true);
});

test("历史页暂时失败时仍会提交新消息", async () => {
  const client = fakeClient();
  const originalCall = client.call;
  let historyReads = 0;
  client.call = async (method, payload) => {
    if (method === "session.history" && historyReads++ === 0) throw new Error("旧版历史页暂时不可用");
    return originalCall(method, payload);
  };
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}) } });
  const receipt = await adapter.send({ NativeSessionID: "s-1" }, { Text: "仍然发送" });
  assert.equal(receipt.Accepted, true);
  assert.ok(client.calls.some((call) => call.method === "session.prompt"));
});

test("adapter sends a message and exposes a waitable run", async () => {
  const client = fakeClient();
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}), selectSession: async () => ({}) } });
  const session = await adapter.attachSession({ NativeSessionID: "s-1" });
  const receipt = await adapter.send(session, { PrismMessageID: "m-1", Text: "继续" });
  assert.equal(receipt.Accepted, true);
  const result = await adapter.waitForRun(session, receipt.NativeMessageID);
  assert.equal(result.Status, "completed");
  assert.ok(client.calls.some((call) => call.method === "session.prompt"));
});

test("草稿协议会创建句柄并用首条消息启动 Harness 会话", async () => {
  const client = fakeClient();
  let created = false;
  const originalCall = client.call;
  client.call = async (method, payload) => {
    if (method === "session.create") {
      created = true;
      return { sessionId: "s-1" };
    }
    return originalCall(method, payload);
  };
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}) } });
  const draft = await adapter.openDraft({ DraftID: "draft-1", Cwd: "/tmp/demo" });
  assert.equal(draft.DraftID, "draft-1");
  assert.equal((await adapter.probe()).CanOpenDraft, true);
  const started = await adapter.startDraftWithMessage({ DraftID: draft.DraftID, Cwd: draft.Cwd, Message: { Text: "首条消息" } });
  assert.equal(created, true);
  assert.equal(started.Receipt.Accepted, true);
});

test("桌面模式优先使用 CDP 页面内 RPC", async () => {
  const desktopCalls = [];
  const desktop = {
    async call(method, payload) {
      desktopCalls.push({ method, payload });
      if (method === "session.list") return { items: [{ sessionId: "s-cdp", running: false, projections: { values: { title: "CDP 会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      return { accepted: true };
    },
    async probe() { desktopCalls.push({ method: "probe" }); },
    async selectSession() { return { selected: "s-cdp" }; },
    async verifySession() { return { visible: true }; },
  };
  const client = { async call() { throw new Error("不应调用独立 HTTP 客户端"); }, async probe() { throw new Error("不应调用独立 HTTP 客户端"); }, baseUrl: "http://unused" };
  const adapter = createAdapter({ client, desktop });
  assert.equal((await adapter.probe()).Available, true);
  const sessions = await adapter.listSessions();
  assert.equal(sessions[0].NativeSessionID, "s-cdp");
  assert.ok(desktopCalls.some((call) => call.method === "session.list"));
});

test("桌面控制操作和订阅使用 CDP transport", async () => {
  const calls = [];
  const desktop = {
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "session.list") return { items: [{ sessionId: "s-control", running: false, projections: { values: { title: "控制会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [{ id: "deepseek", name: "DeepSeek", models: [{ id: "deepseek-chat", name: "Chat", reasoning: { efforts: [] } }] }] };
      return { accepted: true };
    },
    async selectSession() { calls.push({ method: "selectSession" }); return { selected: "s-control" }; },
    async verifySession() { calls.push({ method: "verifySession" }); return { visible: true }; },
  };
  const adapter = createAdapter({ client: { async call() { throw new Error("不应调用 HTTP"); }, baseUrl: "http://unused" }, desktop });
  await adapter.controlSession({ session: { NativeSessionID: "s-control" }, action: "model.switch", target: { provider: "deepseek", model: "deepseek-chat" } });
  assert.ok(calls.some((call) => call.method === "session.selectModel"));
  assert.equal((await adapter.verifyVisibility({ NativeSessionID: "s-control" }, "")).Visible, true);
});

test("切换桌面会话前会幂等登记未注册的工作区", async () => {
  const calls = [];
  const desktop = {
    async call(method, payload) {
      calls.push({ method, payload });
      if (method === "session.list") return { items: [{ sessionId: "s-unregistered", cwd: "/tmp", running: false, blank: false, projections: { values: { title: "临时会话" } } }] };
      if (method === "workspace.list") return { items: [] };
      if (method === "workspace.create") return { workspace: { workspaceId: "w-tmp", path: "/tmp", sessionIds: [] } };
      return { accepted: true };
    },
    async selectSession() { calls.push({ method: "selectSession" }); return { selected: "s-unregistered" }; },
    async verifySession() { return { visible: true }; },
  };
  const adapter = createAdapter({ client: { async call() { throw new Error("不应调用 HTTP"); }, baseUrl: "http://unused" }, desktop });
  await adapter.controlSession({ session: { NativeSessionID: "s-unregistered" }, action: "conversation.select" });
  assert.deepEqual(calls.slice(0, 5).map((call) => call.method), ["session.list", "workspace.list", "workspace.create", "session.create", "selectSession"]);
  assert.deepEqual(calls[2].payload, { path: "/tmp" });
  assert.deepEqual(calls[3].payload, { sessionId: "s-unregistered", workspaceId: "w-tmp" });
});

test("空白会话不宣称在桌面可见", () => {
  const { nativeSession } = require("../index");
  const session = nativeSession({ sessionId: "s-blank", blank: true, cwd: "/tmp", projections: { values: { title: "" } } });
  assert.equal(session.Visible, false);
});

test("图片附件会转换为 Harness 的 base64 图片块", async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dsh-plugin-")), "pixel.png");
  await fs.writeFile(filePath, VALID_PNG);
  const calls = [];
  const client = fakeClient();
  const originalCall = client.call;
  client.call = async (method, payload) => {
    calls.push({ method, payload });
    return originalCall(method, payload);
  };
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}) } });
  await adapter.send({ NativeSessionID: "s-1" }, { Text: "看图", Attachments: [{ Name: "pixel.png", MIMEType: "image/png", LocalPath: filePath }] });
  const prompt = calls.find((call) => call.method === "session.prompt");
  assert.equal(prompt.payload.content[1].type, "image");
  assert.equal(prompt.payload.content[1].mediaType, "image/png");
  assert.equal(prompt.payload.content[1].data, VALID_PNG.toString("base64"));
});

test("图片附件在上传端遗漏 MIME 时按安全扩展名识别", async () => {
  const filePath = path.join(await fs.mkdtemp(path.join(os.tmpdir(), "dsh-plugin-")), "pixel.jpeg");
  await fs.writeFile(filePath, VALID_PNG);
  const calls = [];
  const client = fakeClient();
  const originalCall = client.call;
  client.call = async (method, payload) => {
    calls.push({ method, payload });
    return originalCall(method, payload);
  };
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}) } });
  await adapter.send({ NativeSessionID: "s-1" }, { Text: "看图", Attachments: [{ Name: "pixel.jpeg", MIMEType: "application/octet-stream", LocalPath: filePath }] });
  const prompt = calls.find((call) => call.method === "session.prompt");
  assert.equal(prompt.payload.content[1].mediaType, "image/jpeg");
});

test("文本附件会以内嵌文件内容传入 Harness", async () => {
  const filePath = path.join(os.tmpdir(), `dsh-text-${crypto.randomUUID()}.md`);
  await fs.writeFile(filePath, "# 远程附件\n\n内容保留。", "utf8");
  const client = fakeClient();
  const calls = [];
  const originalCall = client.call;
  client.call = async (method, payload) => {
    calls.push({ method, payload });
    return originalCall(method, payload);
  };
  const adapter = createAdapter({ client, desktop: { resolvePage: async () => ({}) } });
  await adapter.send({ NativeSessionID: "s-1" }, { Text: "阅读附件", Attachments: [{ Name: "notes.md", MIMEType: "text/markdown", LocalPath: filePath }] });
  const prompt = calls.find((call) => call.method === "session.prompt");
  assert.deepEqual(prompt.payload.content, [{ type: "text", text: "阅读附件\n\n[附件：notes.md]\n```markdown\n# 远程附件\n\n内容保留。\n```" }]);
  await fs.unlink(filePath);
});

test("二进制附件会在发送前明确拒绝", async () => {
  const filePath = path.join(os.tmpdir(), `dsh-binary-${crypto.randomUUID()}.pdf`);
  await fs.writeFile(filePath, Buffer.from([0, 1, 2, 3]));
  const adapter = createAdapter({ client: fakeClient(), desktop: { resolvePage: async () => ({}) } });
  await assert.rejects(
    () => adapter.send({ NativeSessionID: "s-1" }, { Text: "阅读附件", Attachments: [{ Name: "report.pdf", MIMEType: "application/pdf", LocalPath: filePath }] }),
    /仅支持图片和 UTF-8 文本附件/,
  );
  await fs.unlink(filePath);
});

test("CDP 页面内调用优先使用新版 Harness RPC 信封", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  let script = "";
  controller.withPage = async (callback) => callback({ evaluate: async (value) => { script = value; return { accepted: true }; } });
  const result = await controller.call("session.list", {});
  assert.deepEqual(result, { accepted: true });
  assert.doesNotMatch(script, /credentials:/);
  assert.match(script, /\/api\/session\.list/);
  assert.match(script, /method\\":\\"session\.list/);
  assert.match(script, /payload\\":\{\}/);
  assert.doesNotMatch(script, /_request|payload\\":\{\\"args\\"|payload\\":\{\\"request\\"/);
});

test("CDP 审批响应保留 mux 的 rpcId 并提交到页面内 respond 端点", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  let script = "";
  controller.withPage = async (callback) => callback({
    evaluate: async (value) => {
      script = value;
      return { accepted: true };
    },
  });
  await controller.respondApproval({ rpcId: "rpc-1", sessionId: "s-1", approvalId: "approval-1", outcome: "allowed-once" });
  assert.match(script, /\/api\/respond/);
  assert.match(script, /client-response/);
  assert.match(script, /rpc-1/);
  assert.match(script, /allowed-once/);
});

test("CDP 审批下行只保留 Harness 审批帧及其 rpcId", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  controller.rpcFlavor = "modern";
  let script = "";
  controller.withPage = async (callback) => callback({
    evaluate: async (value) => {
      script = value;
      return [{ type: "approval/requested", rpcId: "rpc-1", sessionId: "s-1", approvalId: "approval-1", toolName: "bash" }];
    },
  });
  const frames = await controller.readApprovalFrames(300);
  assert.equal(frames[0].approvalId, "approval-1");
  assert.equal(frames[0].rpcId, "rpc-1");
  assert.match(script, /\/api\/events\.mux/);
  assert.match(script, /approval\/requested/);
});

test("CDP 探测支持跨平台配置的端口列表", () => {
  const { cdpCandidates, configuredCdpPorts } = require("../dsh_cdp");
  assert.deepEqual(configuredCdpPorts("17777, 9222, invalid, 70000"), [17777, 9222, 9223, 9333]);
  assert.deepEqual(cdpCandidates("http://127.0.0.1:18888,ws://127.0.0.1:19999/devtools/page/a", "17777"), [
    "http://127.0.0.1:18888", "ws://127.0.0.1:19999/devtools/page/a", "http://127.0.0.1:17777", "http://127.0.0.1:9222", "http://127.0.0.1:9223", "http://127.0.0.1:9333",
  ]);
});

test("CDP 探测优先读取托管桌面应用的动态端口文件", async () => {
  const controller = new DshDesktopController({
    userDataDir: "/tmp/dsh-profile",
    readFile: async () => "18443\n/devtools/browser/example\n",
  });
  const visited = [];
  controller.fetch = async (url) => {
    visited.push(url);
    return { ok: false };
  };
  await assert.rejects(() => controller.resolvePage(), /未发现 DeepSeek Harness/);
  assert.equal(visited[0], "http://127.0.0.1:18443/json/list");
});

test("CDP 页面操作超时后关闭连接以便 watcher 重试", async () => {
  const controller = new DshDesktopController({ pageOperationTimeoutMs: 10 });
  let closed = false;
  controller.resolvePage = async () => ({ webSocketDebuggerUrl: "ws://harness.test" });
  const sdk = require("@rokid-prism/pluginbridge-plugin-sdk/cdp-runtime");
  const original = sdk.CdpPageClient;
  class HangingPage {
    async connectToPage() {}
    async close() { closed = true; }
  }
  sdk.CdpPageClient = HangingPage;
  try {
    await assert.rejects(controller.withPage(() => new Promise(() => {})), /CDP 页面操作超时/);
    assert.equal(closed, true);
  } finally {
    sdk.CdpPageClient = original;
  }
});

test("CDP 页面内调用会回退到旧版 Harness Typert 路由", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const scripts = [];
  controller.withPage = async (callback) => callback({
    evaluate: async (script) => {
      scripts.push(script);
      if (script.includes("/api/session.list")) throw new Error("Harness 页面内 RPC 请求失败：session.list HTTP 404");
      return { accepted: true };
    },
  });
  const result = await controller.call("session.list", {});
  assert.deepEqual(result, { accepted: true });
  assert.equal(controller.rpcFlavor, "legacy");
  const legacyScript = scripts.at(-1);
  assert.match(legacyScript, /\/api\/session\/list/);
  assert.match(legacyScript, /method\\":\\"session\/list/);
  assert.match(legacyScript, /payload\\":\{\\"args\\":\{\\"_request\\":\{\}\}\}/);
});

test("CDP 会话搜索兼容 Harness 中英文输入框文案", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const scripts = [];
  controller.withPage = async (callback) => callback({
    evaluate: async (value) => {
      scripts.push(value);
      if (value.includes("data-row-key^=\"workspace:\"")) return [];
      if (value.includes("searchButton")) return { changed: true, mechanism: "session-search" };
      if (value.includes("const selected =")) return { id: "s-1", title: "测试会话" };
      return { changed: false, mechanism: "session-row-not-found" };
    },
  });
  await controller.selectSession("s-1", "测试会话");
  const searchScript = scripts.find((script) => script.includes("searchButton"));
  assert.match(searchScript, /placeholder\*="搜索会话"/);
  assert.match(searchScript, /placeholder\*="Search sessions"/);
  assert.match(scripts[0], /\[role="row"\]/);
});

test("旧版 Harness 历史请求转换为 session/page 并归一化 records", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const scripts = [];
  controller.withPage = async (callback) => callback({
    evaluate: async (script) => {
      scripts.push(script);
      if (script.includes("/api/session.history")) throw new Error("Harness 页面内 RPC 请求失败：session.history HTTP 404");
      if (script.includes("/api/session.list") || script.includes("/api/session/list")) {
        return { items: [{ sessionId: "s-1", projections: { asOfSeq: 42 } }] };
      }
      return { records: [{ event: { type: "user/message", seq: 42, time: 1700000000000, data: {} } }], hasMore: false };
    },
  });
  const value = await controller.call("session.history", { sessionId: "s-1", maxMessages: 20 });
  assert.equal(controller.rpcFlavor, "legacy");
  assert.equal(value.events.length, 1);
  assert.equal(value.events[0].event.seq, 42);
  const pageScript = scripts.find((script) => script.includes("/api/session/page"));
  assert.match(pageScript, /method\\":\\"session\/page/);
  assert.match(pageScript, /throughSeq\\":42/);
  assert.match(pageScript, /maxMessages\\":20/);
});

test("旧版 Harness 模型目录使用 default 作为当前模型", async () => {
  const controller = new DshDesktopController({ fetch: async () => ({ ok: false }) });
  const scripts = [];
  controller.withPage = async (callback) => callback({
    evaluate: async (script) => {
      scripts.push(script);
      if (script.includes("/api/session.models")) throw new Error("Harness 页面内 RPC 请求失败：session.models HTTP 404");
      return { default: { provider: "deepseek", model: "deepseek-chat" }, groups: [], failures: [] };
    },
  });
  const value = await controller.call("session.models", { sessionId: "s-1" });
  assert.deepEqual(value.current, { provider: "deepseek", model: "deepseek-chat" });
  assert.match(scripts.at(-1), /\/api\/session\/modelCatalog/);
  assert.match(scripts.at(-1), /payload\\":\{\\"args\\":\{\}\}/);
});

test("旧版 Harness 不支持 workspace RPC 时切换会话不被阻断", async () => {
  const calls = [];
  const desktop = {
    isLegacy() { return true; },
    async call(method) {
      calls.push(method);
      if (method === "session.list") return { items: [{ sessionId: "s-legacy", cwd: "/tmp", projections: { values: { title: "旧版会话" } } }] };
      return { accepted: true };
    },
    async selectSession() { calls.push("selectSession"); return { selected: "s-legacy" }; },
    async verifySession() { return { visible: true }; },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  await adapter.controlSession({ session: { NativeSessionID: "s-legacy" }, action: "conversation.select" });
  assert.deepEqual(calls.slice(0, 2), ["session.list", "selectSession"]);
  assert.equal(calls.includes("workspace.list"), false);
  assert.equal(calls.includes("workspace.create"), false);
});

test("桌面会话切换返回 Hub 所需的前台确认快照", async () => {
  const desktop = {
    isLegacy() { return true; },
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-foreground", cwd: "/tmp", projections: { values: { title: "前台会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      return { accepted: true };
    },
    async selectSession() { return { selected: "s-foreground", title_match: false }; },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const result = await adapter.controlSession({ session: { NativeSessionID: "s-foreground" }, action: "conversation.select" });
  assert.equal(result.details.selected, true);
  assert.equal(result.details.desktop_foreground, true);
  assert.equal(result.details.detail_stale, false);
});

test("桌面前台 watcher 会发布实时 detail_snapshot", async () => {
  const desktop = {
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-live", cwd: "/tmp", projections: { values: { title: "实时会话" } } }] };
      if (method === "session.history") return { events: [], projections: { values: {} }, hasMore: false };
      if (method === "session.models") return { current: { provider: "deepseek", model: "deepseek-chat" }, groups: [] };
      if (method === "session.projections") return { values: {} };
      return { accepted: true };
    },
    async *watchHost() {
      yield { type: "host/session-foreground", sessionId: "s-live", foreground: true, item: { cwd: "/tmp" } };
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const events = adapter.subscribePlugin(new AbortController().signal);
  const event = (await events.next()).value;
  assert.equal(event.Type, "dsh.desktop.state.changed");
  assert.equal(event.Payload.detail_snapshot.desktop_foreground, true);
  assert.equal(event.Payload.detail_snapshot.detail_stale, false);
});

test("桌面 watcher 优先用会话目录投影发布前台模型", async () => {
  const desktop = {
    async call(method) {
      if (method === "session.list") return { items: [{ sessionId: "s-live", running: false, cwd: "/tmp", projections: { values: { title: "实时会话", modelSelection: { next: { provider: "deepseek", model: "deepseek-v4-flash" } } } } }] };
      throw new Error("目录投影快照不应等待完整详情请求");
    },
    async *watchHost() {
      yield { type: "host/session-foreground", sessionId: "s-live", foreground: true, item: { sessionId: "s-live", running: false, cwd: "/tmp", projections: { values: { title: "实时会话", modelSelection: { next: { provider: "deepseek", model: "deepseek-v4-flash" } } } } } };
    },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const events = adapter.subscribePlugin(new AbortController().signal);
  const event = (await events.next()).value;
  assert.equal(event.Payload.detail_snapshot.model, "deepseek-v4-flash");
  assert.equal(event.Payload.detail_snapshot.model_options[0].target.option_id, "deepseek:deepseek-v4-flash");
  assert.equal(event.Payload.detail_snapshot.desktop_foreground, true);
});

test("桌面前台快照会携带模型和权限投影", async () => {
  const desktop = {
    async *watchHost() {
      yield {
        type: "host/session-foreground", sessionId: "s-projection", foreground: true,
        item: {
          sessionId: "s-projection", running: false, projections: { values: {
            title: "投影会话", modelSelection: { next: { provider: "deepseek", model: "deepseek-v4-flash" } },
            permissions: { currentValue: "workspace-write", options: [{ value: "workspace-write", name: "Workspace write" }] },
          } },
        },
      };
    },
    async call() { throw new Error("目录快照不应等待详情读取"); },
  };
  const adapter = createAdapter({ desktop, client: { async call() { throw new Error("不应调用 HTTP"); } } });
  const iterator = adapter.subscribePlugin(new AbortController().signal);
  const event = (await iterator.next()).value;
  assert.equal(event.Payload.detail_snapshot.current_permission.id, "workspace-write");
  assert.equal(event.Payload.detail_snapshot.permission_options[0].id, "workspace-write");
  assert.equal(event.Payload.detail_snapshot.actions.find((action) => action.id === "permission.switch").available, true);
});

test("CDP watcher 在 DOM 无法读回会话标识时复用已确认的切换结果", async () => {
  const { DshDesktopController } = require("../dsh_cdp");
  const controller = new DshDesktopController();
  controller.confirmedSessionId = "s-confirmed";
  controller.call = async () => ({ items: [{ sessionId: "s-confirmed", running: false }] });
  controller.selectedSessionId = async () => "";
  const iterator = controller.watchHost(new AbortController().signal, 60_000);
  const first = await iterator.next();
  assert.equal(first.value.type, "host/session-foreground");
  assert.equal(first.value.sessionId, "s-confirmed");
  assert.equal(first.value.foreground, true);
  const second = await iterator.next();
  assert.equal(second.value.type, "host/session-added");
  const third = await iterator.next();
  assert.equal(third.value.type, "host/session-status");
  assert.equal(third.value.sessionId, "s-confirmed");
  assert.equal(third.value.foregroundTransition, true);
  await iterator.return();
});

test("CDP watcher 首轮以最新活动会话发布快照，不依赖第二条 DOM 连接", async () => {
  const controller = new DshDesktopController();
  controller.call = async () => ({ items: [
    { sessionId: "s-old", updatedAt: 1, blank: false },
    { sessionId: "s-current", updatedAt: 2, blank: false },
  ] });
  controller.withPage = async () => { throw new Error("watcher 不应读取 DOM 选中态"); };
  const iterator = controller.watchHost(new AbortController().signal, 60_000);
  const first = await iterator.next();
  assert.equal(first.value.type, "host/session-foreground");
  assert.equal(first.value.sessionId, "s-current");
  assert.equal(first.value.foreground, true);
  await iterator.return();
});

test("CDP 已确认切换后 watcher 会重新发布前台会话", async () => {
  const { DshDesktopController } = require("../dsh_cdp");
  const controller = new DshDesktopController();
  controller.confirmedSessionId = "s-current";
  controller.call = async () => ({ items: [{ sessionId: "s-current", running: false }] });
  controller.withPage = async () => { throw new Error("测试中省略 DOM 读取"); };
  const abort = new AbortController();
  const iterator = controller.watchHost(abort.signal, 10)[Symbol.asyncIterator]();
  try {
    await iterator.next();
    await iterator.next();
    await iterator.next();
    controller.foregroundRevision += 1;
    const confirmed = await Promise.race([
      iterator.next(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("切换确认后没有重新发布前台会话")), 250)),
    ]);
    assert.equal(confirmed.value.type, "host/session-foreground");
    assert.equal(confirmed.value.sessionId, "s-current");
    assert.equal(confirmed.value.foreground, true);
  } finally {
    abort.abort();
    await iterator.return();
  }
});

test("textOf renders known Harness content blocks", () => {
  assert.equal(textOf([{ type: "text", text: "a" }, { type: "tool-call", name: "bash" }]), "a\n[工具调用] bash");
});

test("客户端会用启动 token 换取 Cookie 并复用认证", async () => {
  let requests = 0;
  const client = new DshClient({
    baseUrl: "http://harness.test",
    launchToken: "launch-token",
    fetch: async (url, init) => {
      requests += 1;
      if (String(url) === "http://harness.test/?token=launch-token") {
        return new Response(null, { status: 302, headers: { "set-cookie": "dsh-auth-test=ok; Path=/" } });
      }
      const request = JSON.parse(init.body);
      assert.equal(init.headers.cookie, "dsh-auth-test=ok");
      assert.equal(url, "http://harness.test/api/session.list");
      assert.deepEqual(request.payload, {});
      return Response.json({ type: "server-response", rpcId: request.rpcId, result: { ok: true, value: {} } });
    },
  });
  await client.probe();
  assert.equal(requests, 2);
});
