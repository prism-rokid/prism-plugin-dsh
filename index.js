#!/usr/bin/env node
"use strict";

process.title = process.env.PRISM_PLUGIN_PROCESS_LABEL || "prism-plugin-dsh";

const crypto = require("crypto");
const fs = require("fs/promises");
const pluginBridge = require("@rokid-prism/pluginbridge-plugin-sdk");
const PluginAdapterError = pluginBridge.PluginAdapterError || class extends Error {
  constructor(code, message) { super(message); this.code = code; }
};
const { DshClient, firstText } = require("./dsh_client");
const { DshDesktopController } = require("./dsh_cdp");
const { dshEventSummary, reconnectingDshEvents, sleep } = require("./dsh_events");

const PLUGIN_ID = "dsh";
const MODE = firstText(process.env.PRISM_PLUGIN_MODE, "desktop").toLowerCase();
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_POLL_MS = 750;
const MAX_TEXT_ATTACHMENT_BYTES = 512 * 1024;
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_MIME_BY_EXTENSION = new Map([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"], ["gif", "image/gif"]]);
const TEXT_ATTACHMENT_EXTENSIONS = new Set(["txt", "md", "mdx", "json", "jsonl", "yaml", "yml", "toml", "ini", "cfg", "csv", "tsv", "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "go", "java", "kt", "c", "h", "cc", "cpp", "cs", "rs", "rb", "php", "sh", "zsh", "fish", "ps1", "sql", "html", "htm", "css", "scss", "less", "xml", "svg"]);

function now() { return new Date().toISOString(); }
function idOf(session) { return firstText(session && session.NativeSessionID, session && session.NativeThreadID, session && session.sessionId); }
function summaryTitle(summary) {
  const title = summary && summary.projections && summary.projections.values && summary.projections.values.title;
  return firstText(title && typeof title === "object" ? title.title : title, title && typeof title === "object" ? title.value : "", "DeepSeek Harness 会话");
}
function textOf(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (!block || typeof block !== "object") return "";
    if (block.type === "text" || block.type === "reasoning") return String(block.text || "");
    if (block.type === "tool-call") return `[工具调用] ${block.name || ""}`;
    if (block.type === "tool-result") return textOf(block.content);
    return "";
  }).filter(Boolean).join("\n");
}

function visibleTextOf(blocks) {
  return (Array.isArray(blocks) ? blocks : []).map((block) => {
    if (!block || typeof block !== "object") return "";
    return block.type === "text" ? String(block.text || "") : "";
  }).filter(Boolean).join("\n");
}

function isUserAuthoredMessage(message) {
  const source = message && message.source;
  // 旧版 Harness 没有 source 字段，保留其历史；新版只展示明确来自用户的消息，
  // 过滤 time-context、system-prompt 等自动注入内容。
  return !source || typeof source !== "object" || !source.kind || source.kind === "user";
}
function attachmentMetadata(blocks) {
  const result = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "image" && block.attachment && typeof block.attachment === "object") {
      const attachment = block.attachment;
      result.push({ kind: "image", name: firstText(attachment.name, "图片"), mime_type: firstText(attachment.mediaType, "image/*"), bytes: Number(attachment.bytes) || 0 });
    } else if (block.type === "tool-result") {
      result.push(...attachmentMetadata(block.content));
    }
  }
  return result;
}
function iso(time) { return new Date(Number(time) || Date.now()).toISOString(); }
function actionName(value) { return String(value || "").trim().toLowerCase().replace(/_/g, "."); }
function controlTargetStale(message) {
  return new PluginAdapterError("control_target_stale", message);
}

function textAttachmentLanguage(name) {
  const extension = firstText(name).split(".").at(-1).toLowerCase();
  const aliases = { md: "markdown", yml: "yaml", py: "python", ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx", sh: "bash", ps1: "powershell", cs: "csharp", kt: "kotlin", rb: "ruby", rs: "rust" };
  return aliases[extension] || extension || "text";
}

function imageAttachmentMimeType(name, mimeType) {
  if (IMAGE_MIME_TYPES.has(mimeType)) return mimeType;
  // 上传端无法识别 MIME 时，Hub 仍会保留原文件名；仅对 Harness 明确支持的图片扩展名兜底。
  if (!mimeType || mimeType === "application/octet-stream") return IMAGE_MIME_BY_EXTENSION.get(firstText(name).split(".").at(-1).toLowerCase()) || "";
  return "";
}

function textAttachmentSupported(name, mimeType) {
  if (mimeType.startsWith("text/")) return true;
  if (["application/json", "application/ld+json", "application/xml", "application/javascript", "application/x-yaml", "application/yaml"].includes(mimeType)) return true;
  return TEXT_ATTACHMENT_EXTENSIONS.has(firstText(name).split(".").at(-1).toLowerCase());
}

function permissionControls(state) {
  const permissionState = state && (state.permissions || state.permission) || {};
  const currentPermission = firstText(permissionState.currentValue, permissionState.current_value);
  const provided = Array.isArray(permissionState.options) ? permissionState.options : [];
  const options = provided.map((option) => ({
    id: firstText(option.value, option.id), label: firstText(option.name, option.label, option.value, option.id),
    ...(firstText(option.description) ? { description: option.description } : {}),
    target: { option_id: firstText(option.value, option.id) }, available: firstText(option.value, option.id) !== "custom",
  })).filter((option) => option.id);
  // 旧版 Harness 的投影只发布当前值。其默认权限服务明确提供这两个可切换预设，
  // 因此仅在目录缺失时补齐，不伪造部署自定义的预设。
  if (options.length === 0 && currentPermission) {
    const names = ["workspace-write", "danger-full-access"];
    if (currentPermission !== "custom" && !names.includes(currentPermission)) names.unshift(currentPermission);
    const labels = { "workspace-write": "工作区写入", "danger-full-access": "完全访问" };
    options.push(...names.map((id) => ({
      id, label: labels[id] || id, target: { option_id: id }, available: id !== "custom",
    })));
  }
  return { currentPermission, permissionOptions: options };
}

function capability(available, reason = "", canApproval = false) {
  return {
    PluginID: PLUGIN_ID, Available: available,
    NativeVisibleInput: MODE === "desktop", NativeVisibleOutput: MODE === "desktop",
    CanAttachSession: true, CanStartSessionWithMessage: true, CanOpenDraft: true,
    CanListSessions: true, CanReadHistory: true, CanInterrupt: true, CanApproval: canApproval,
    CanForwardSync: true, CanReverseSync: true, CanPluginWideWatch: true,
    CanWaitRun: true, CanReadStatus: true, CanControlSession: true,
    IntegrationMode: MODE === "desktop" ? "desktop-automation" : "protocol-native",
    VisibilitySurface: MODE === "desktop" ? "deepseek-harness-desktop" : "deepseek-harness-api",
    UnavailableReason: reason,
  };
}

function nativeSession(summary, visible = MODE === "desktop") {
  const sessionId = firstText(summary && summary.sessionId);
  const title = summaryTitle(summary);
  return {
    PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId,
    Surface: MODE === "desktop" ? "deepseek-harness-desktop" : "deepseek-harness-api",
    Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`,
    Cwd: firstText(summary && summary.cwd), Visible: visible && !Boolean(summary && summary.blank),
    Title: title, PrismConversationID: "", Active: Boolean(summary && summary.running),
    LastActivityAt: iso(summary && summary.updatedAt),
    Metadata: {
      blank: String(Boolean(summary && summary.blank)),
      ...(summary && summary.parentSessionId ? { parent_session_id: String(summary.parentSessionId) } : {}),
      ...(summary && summary.agentPreset ? { agent_preset: String(summary.agentPreset) } : {}),
    },
  };
}

function historyTurns(events) {
  const turns = new Map();
  let activeTurn = 0;
  for (const row of Array.isArray(events) ? events : []) {
    const event = row && row.event || row;
    if (!event || typeof event !== "object") continue;
    const data = event.data || {};
    if (event.type === "turn/start") activeTurn = Number(data.turn || activeTurn + 1);
    const turnId = Number(data.turn || activeTurn || 0);
    const sequence = Number(event.seq);
    if (!turns.has(turnId)) turns.set(turnId, { turn_id: `dsh-turn-${turnId || event.seq}`, order_key: String(event.seq || 0).padStart(12, "0"), revision: Number.isFinite(sequence) ? sequence : 0, messages: [] });
    const turn = turns.get(turnId);
    if (Number.isFinite(sequence)) turn.revision = Math.max(turn.revision, sequence);
    if (event.type === "user/message" || event.type === "assistant/message") {
      const message = event.type === "assistant/message" ? data.message || {} : data;
      if (event.type === "user/message" && !isUserAuthoredMessage(message)) continue;
      const content = event.type === "assistant/message" ? visibleTextOf(message.content) : textOf(message.content);
      const attachments = attachmentMetadata(message.content);
      // 每个 step 都可能产生 assistant/message；只有带最终文本的消息才展示。
      if (event.type === "assistant/message" && !content) continue;
      turn.messages.push({
        ID: firstText(message.id, `dsh-${event.seq}`), Role: firstText(message.role, event.type.startsWith("user") ? "user" : "assistant"),
        Type: "message", Content: content, Status: data.interrupted ? "interrupted" : "completed",
        CreatedAt: iso(event.time), UpdatedAt: iso(event.time),
        ...(() => {
          const metadata = {};
          if (attachments.length) metadata.attachments = attachments;
          if (event.type === "assistant/message" && data.usage) metadata.usage = data.usage;
          return Object.keys(metadata).length ? { Metadata: metadata } : {};
        })(),
      });
    }
  }
  return [...turns.values()].map((turn) => {
    // 一个 turn 可能跨多个模型 step；只展示最后一条助手文本，避免把中间步骤
    // 和 Harness 内部编排过程暴露到 Panel。
    let lastAssistant = -1;
    turn.messages.forEach((message, index) => {
      if (message.Role === "assistant") lastAssistant = index;
    });
    return {
      ...turn,
      messages: turn.messages.filter((message, index) => message.Role !== "assistant" || index === lastAssistant),
    };
  }).filter((turn) => turn.messages.length > 0);
}

function historyTurnFingerprint(turn) {
  return JSON.stringify({
    turn_id: turn.turn_id,
    order_key: turn.order_key,
    messages: turn.messages.map((message) => ({
      ID: message.ID, Role: message.Role, Type: message.Type, Content: message.Content,
      Status: message.Status, CreatedAt: message.CreatedAt, UpdatedAt: message.UpdatedAt,
      Metadata: message.Metadata || null,
    })),
  });
}

function waitForHistoryUpdate(signal, intervalMs = 500) {
  return new Promise((resolve) => {
    if (signal && signal.aborted) return resolve();
    const timer = setTimeout(done, intervalMs);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

function createAdapter(options = {}) {
  const client = options.client || new DshClient(options);
  const desktop = options.desktop || new DshDesktopController(options);
  const desktopTransport = MODE === "desktop" && typeof desktop.call === "function";
  const runs = new Map();
  const starts = new Map();
  const drafts = new Map();
  const approvals = new Map();
  const questions = new Map();
  const resolvedApprovals = new Set();
  const resolvedQuestions = new Set();
  const interactionUpdates = [];
  let interactionUpdateWake = null;
  let approvalProtocolAvailable = false;

  function draftControls() {
    return { actions: [] };
  }

  function activeDraft(draftId) {
    const key = firstText(draftId);
    const draft = drafts.get(key);
    if (!draft) throw new Error("DeepSeek Harness 草稿已失效或不存在。");
    return draft;
  }

  async function call(method, payload = {}, requestOptions = {}) {
    return desktopTransport
      ? desktop.call(method, payload, requestOptions)
      : client.call(method, payload, requestOptions);
  }

  function enqueueInteractionUpdate(frame) {
    interactionUpdates.push(frame);
    const wake = interactionUpdateWake;
    interactionUpdateWake = null;
    if (wake) wake();
  }

  function nextInteractionUpdate(signal) {
    if (interactionUpdates.length) return Promise.resolve(interactionUpdates.shift());
    return new Promise((resolve) => {
      let wake;
      const onAbort = () => done(null);
      const done = (frame) => {
        signal?.removeEventListener("abort", onAbort);
        if (interactionUpdateWake === wake) interactionUpdateWake = null;
        resolve(frame);
      };
      wake = () => done(interactionUpdates.shift() || null);
      interactionUpdateWake = wake;
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  function approvalSnapshot(pending) {
    if (!pending) return null;
    const toolName = firstText(pending.toolName, "工具");
    const reason = firstText(pending.reason, "DeepSeek Harness 请求执行工具操作。");
    return {
      active: true,
      approval_request_id: pending.approvalId,
      title: `允许 ${toolName} 执行操作？`,
      summary: reason,
      description: pending.callId ? `工具调用：${pending.callId}` : "",
      created_at: pending.createdAt,
      actions: [
        { id: "allowed-once", label: "仅允许一次", available: true, style: "primary" },
        { id: "rejected", label: "拒绝", available: true, style: "danger" },
      ],
    };
  }

  function approvalEvent(frame, state) {
    const sessionId = firstText(frame && frame.sessionId);
    const approvalId = firstText(frame && frame.approvalId);
    const nativeSession = {
      PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId,
      Surface: "deepseek-harness-desktop", Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`,
      Cwd: "", Visible: true,
    };
    if (state === "requested") {
      const pending = {
        sessionId, approvalId, rpcId: firstText(frame && frame.rpcId), toolName: firstText(frame && frame.toolName),
        callId: firstText(frame && frame.callId), reason: firstText(frame && frame.reason), createdAt: Date.now(),
      };
      const previous = approvals.get(approvalId);
      approvals.set(approvalId, pending);
      resolvedApprovals.delete(approvalId);
      if (previous && previous.rpcId === pending.rpcId) return null;
      const approval = approvalSnapshot(pending);
      return {
        ID: `dsh:approval:${approvalId}:requested`, Type: "approval.required", Status: "waiting_approval",
        Summary: approval.summary, CreatedAt: now(),
        Payload: {
          native_session: nativeSession, approval_request_id: approvalId, approval_kind: "tool_execution",
          title: approval.title, summary: approval.summary, description: approval.description, actions: approval.actions,
          detail_snapshot: { native_session_id: sessionId, native_thread_id: sessionId, approval, run: { status: "waiting_approval", approval_blocked: true, approval_request_id: approvalId, primary_action: "approval" }, primary_action: "approval" },
        },
      };
    }
    if (resolvedApprovals.has(approvalId)) return null;
    resolvedApprovals.add(approvalId);
    approvals.delete(approvalId);
    return {
      ID: `dsh:approval:${approvalId}:resolved`, Type: "approval.resolved", Status: "running",
      Summary: `DeepSeek Harness 审批已${frame.outcome === "allowed-once" ? "允许" : "结束"}`, CreatedAt: now(),
      Payload: {
        native_session: nativeSession, approval_request_id: approvalId, outcome: firstText(frame && frame.outcome),
        detail_snapshot: { native_session_id: sessionId, native_thread_id: sessionId, approval: null, run: { status: "running", approval_blocked: false, approval_request_id: "", primary_action: "interrupt" }, primary_action: "interrupt" },
      },
    };
  }

  function questionSurface(pending) {
    if (pending && pending.surface && typeof pending.surface === "object") return pending.surface;
    const rawQuestions = Array.isArray(pending && pending.questions) ? pending.questions : [];
    if (rawQuestions.length === 0 || rawQuestions.length > 20) return null;
    const seenQuestions = new Set();
    const mapped = rawQuestions.map((rawQuestion, questionIndex) => {
      const question = rawQuestion && typeof rawQuestion === "object" ? rawQuestion : {};
      const id = firstText(question.id);
      const text = firstText(question.question);
      if (!id || !text || seenQuestions.has(id)) return null;
      seenQuestions.add(id);
      const rawOptions = Array.isArray(question.options) ? question.options : [];
      if (rawOptions.length > 100) return null;
      const options = rawOptions.map((rawOption, optionIndex) => {
        const option = rawOption && typeof rawOption === "object" ? rawOption : {};
        const label = firstText(option.label);
        return label ? { id: `dsh-option-${questionIndex}-${optionIndex}`, label: firstText(label, option.description) } : null;
      });
      if (options.some((option) => option === null)) return null;
      const detail = firstText(question.detail);
      return {
        id,
        question: detail ? `${text}\n\n${detail}` : text,
        multiple: question.multiSelect === true,
        // Harness 的问题协议始终允许 custom 字段；无选项的问题也必须保留文本回答入口。
        allow_custom: true,
        placeholder: "输入你的答案",
        options,
      };
    });
    if (mapped.some((question) => question === null)) return null;
    const title = firstText(rawQuestions[0] && rawQuestions[0].header, "DeepSeek Harness 问题");
    return {
      surface_id: pending.surfaceId,
      capability: "user_question",
      kind: "questionnaire",
      title,
      questions: mapped,
      actions: [
        { action_id: "submit", label: "提交", purpose: "submit_answers", available: true, requires_input: true, accepts_input: true },
        { action_id: "skip", label: "跳过", purpose: "skip_questions", available: true, requires_input: false, accepts_input: false },
      ],
      inputs: [],
    };
  }

  function questionEvent(frame, state) {
    const sessionId = firstText(frame && frame.sessionId);
    const nativeDom = frame && frame.source === "desktop-dom";
    const rpcId = firstText(state === "requested" ? frame && frame.rpcId : frame && frame.questionRpcId, frame && frame.rpcId, nativeDom && frame && frame.surface && frame.surface.surface_id);
    if (!sessionId || !rpcId) return null;
    if (state === "requested") {
      const pending = {
        rpcId, sessionId, source: nativeDom ? "desktop-dom" : "mux",
        surfaceId: nativeDom ? firstText(frame && frame.surface && frame.surface.surface_id) : `dsh-question:${rpcId}`,
        questions: nativeDom ? [] : (Array.isArray(frame.questions) ? frame.questions : []),
        ...(nativeDom && frame.surface ? { surface: frame.surface } : {}),
      };
      const previous = questions.get(rpcId);
      questions.set(rpcId, pending);
      resolvedQuestions.delete(rpcId);
      if (previous) return null;
      const surface = questionSurface(pending);
      if (!surface) {
        questions.delete(rpcId);
        return null;
      }
      return {
        ID: `dsh:question:${rpcId}:requested`, Type: "dsh.question.requested", Status: "running",
        Summary: "DeepSeek Harness 正在等待你的回答", CreatedAt: now(),
        Payload: {
          native_session: { PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId, Surface: "deepseek-harness-desktop", Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`, Cwd: "", Visible: true },
          detail_snapshot: { native_session_id: sessionId, native_thread_id: sessionId, desktop_foreground: true, detail_stale: false, interactive_surface: surface, run: { status: "running", primary_action: "interrupt" }, primary_action: "interrupt" },
        },
      };
    }
    if (resolvedQuestions.has(rpcId)) return null;
    resolvedQuestions.add(rpcId);
    questions.delete(rpcId);
    return {
      ID: `dsh:question:${rpcId}:resolved`, Type: "dsh.question.resolved", Status: "running",
      Summary: "DeepSeek Harness 问题已处理", CreatedAt: now(),
      Payload: {
        native_session: { PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId, Surface: "deepseek-harness-desktop", Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`, Cwd: "", Visible: true },
        detail_snapshot: { native_session_id: sessionId, native_thread_id: sessionId, desktop_foreground: true, detail_stale: false, interactive_surface: null, run: { status: "running", primary_action: "interrupt" }, primary_action: "interrupt" },
      },
    };
  }

  function questionAnswer(pending, input) {
    let value;
    try { value = JSON.parse(firstText(input)); } catch { throw new Error("DeepSeek Harness 问题回答格式无效。"); }
    const answers = value && Array.isArray(value.answers) ? value.answers : [];
    if (answers.length !== pending.questions.length) throw new Error("DeepSeek Harness 问题回答数量不匹配。");
    return {
      answers: pending.questions.map((rawQuestion, questionIndex) => {
        const question = rawQuestion && typeof rawQuestion === "object" ? rawQuestion : {};
        const answer = answers[questionIndex] && typeof answers[questionIndex] === "object" ? answers[questionIndex] : {};
        const selectedIDs = Array.isArray(answer.selectedOptionIds) ? answer.selectedOptionIds.map((id) => firstText(id)) : [];
        const selected = [...new Set(selectedIDs)];
        const rawOptions = Array.isArray(question.options) ? question.options : [];
        const labels = selected.map((id) => {
          const matched = /^dsh-option-(\d+)-(\d+)$/.exec(id);
          const option = matched && Number(matched[1]) === questionIndex ? rawOptions[Number(matched[2])] : null;
          return firstText(option && option.label);
        });
        if (labels.some((label) => !label) || (!question.multiSelect && labels.length > 1)) throw new Error("DeepSeek Harness 问题选项无效。");
        const custom = firstText(answer.freeformText);
        if (custom.length > 8192) throw new Error("DeepSeek Harness 问题文本回答过长。");
        if (answer.skip === true) return { id: firstText(question.id), selected: [] };
        if (labels.length === 0 && !custom) throw new Error("请完成 DeepSeek Harness 问题后再提交。");
        return { id: firstText(question.id), selected: labels, ...(custom ? { custom } : {}) };
      }),
    };
  }

  async function summaries() {
    const response = await call("session.list", {});
    return Array.isArray(response && response.items) ? response.items : [];
  }
  function samePath(left, right) {
    const normalize = (value) => firstText(value).replace(/[\\/]+$/, "") || "/";
    return normalize(left) === normalize(right);
  }
  async function ensureDesktopWorkspace(session) {
    if (!desktopTransport) return;
    if (typeof desktop.isLegacy === "function" && desktop.isLegacy()) return;
    const cwd = firstText(session && session.cwd);
    if (!cwd) return;
    const response = await call("workspace.list", {});
    const items = Array.isArray(response && response.items) ? response.items : [];
    let workspace = items.find((item) => item && samePath(item.path, cwd));
    if (!workspace) {
      const created = await call("workspace.create", { path: cwd });
      workspace = created && created.workspace;
    }
    const workspaceId = firstText(workspace && workspace.workspaceId);
    if (!workspaceId || (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(idOf(session)))) return;
    await call("session.create", { sessionId: idOf(session), workspaceId });
  }
  async function summary(sessionId) {
    const item = (await summaries()).find((candidate) => candidate && candidate.sessionId === sessionId);
    if (!item) throw new Error(`未找到 DeepSeek Harness 会话：${sessionId}`);
    return item;
  }
  async function checkSession(session) { return nativeSession(await summary(idOf(session))); }
  async function projection(sessionId) {
    // session.history 是 Harness 公开 RPC，尾页携带和桌面 UI 相同的一致性投影。
    // 旧版 Harness 则只通过 session.projections 提供同一份数据。
    let historyError;
    try {
      const value = await call("session.history", { sessionId, maxMessages: 1 });
      const values = value && value.projections && value.projections.values;
      if (values && typeof values === "object") return values;
    } catch (error) {
      historyError = error;
    }
    try {
      const direct = await call("session.projections", { sessionId });
      const block = direct && direct.projections && direct.projections.values ? direct.projections : direct;
      if (block && block.values && typeof block.values === "object") return block.values;
    } catch (error) {
      if (!historyError) historyError = error;
    }
    if (historyError) throw historyError;
    return {};
  }
  async function controls(sessionId, stateOverride) {
    const [catalog, state] = await Promise.all([
      call("session.models", { sessionId }),
      stateOverride === undefined ? projection(sessionId) : Promise.resolve(stateOverride),
    ]);
    const catalogCurrent = catalog.current || catalog.default || {};
    const rawGroups = catalog.groups || catalog.routableProviders || catalog.providers || [];
    const groups = rawGroups.length ? rawGroups : (Array.isArray(catalog.models) && catalog.models.length ? [{ id: catalogCurrent.provider || catalogCurrent.providerId || "deepseek", name: catalogCurrent.provider || catalogCurrent.providerId || "DeepSeek", models: catalog.models }] : []);
    const modelOptions = groups.flatMap((group) => (group.models || []).map((model) => ({
      id: `${group.id}:${model.id}`, label: `${group.name || group.id} / ${model.name || model.id}`,
      target: { option_id: `${group.id}:${model.id}` }, available: true,
    })));
    const selection = state.modelSelection || state.model_selection || {};
    const current = selection.next || selection.lastUsed || catalogCurrent;
    const currentModel = current.model || current.modelId;
    const currentProvider = current.provider || current.providerId;
    const selectedGroup = groups.find((group) => group.id === currentProvider);
    const selectedModel = selectedGroup && (selectedGroup.models || []).find((model) => {
      if (model.id === currentModel) return true;
      const normalizedCurrent = String(currentModel || "").replace(/-v4(?=-|$)/, "");
      return normalizedCurrent === model.id || normalizedCurrent.endsWith(`-${model.id}`);
    });
    const efforts = selectedModel && selectedModel.reasoning && (selectedModel.reasoning.efforts || selectedModel.reasoning.reasoningEfforts || selectedModel.reasoning_efforts);
    const reasoningOptions = (efforts || []).map((item) => ({ id: item.id, label: item.name || item.id, target: { option_id: item.id }, available: true }));
    const { currentPermission, permissionOptions } = permissionControls(state);
    return { models: { ...catalog, current: { ...current, provider: currentProvider, model: currentModel } }, modelOptions, reasoningOptions, permissionOptions, currentPermission };
  }
  async function readDetail(session) {
    const sessionId = idOf(session);
    const [current, state] = await Promise.all([summary(sessionId), projection(sessionId)]);
    const model = await controls(sessionId, state);
    const pendingApproval = [...approvals.values()].find((approval) => approval.sessionId === sessionId);
    const pendingQuestion = [...questions.values()].find((question) => question.sessionId === sessionId);
    const currentSelection = model.models.current || {};
    const modelLabel = firstText(currentSelection.displayName, currentSelection.display_name, currentSelection.name, currentSelection.model, currentSelection.modelId);
    const modelId = firstText(currentSelection.model, currentSelection.modelId);
    const providerId = firstText(currentSelection.provider, currentSelection.providerId);
    return {
      native_session_id: sessionId, native_thread_id: sessionId, title: nativeSession(current).Title,
      running: Boolean(current.running), model: modelLabel, current_model: { id: `${providerId}:${modelId}`, label: modelLabel, target: { option_id: `${providerId}:${modelId}` }, provider: providerId, model: modelId }, model_options: model.modelOptions,
      reasoning_options: model.reasoningOptions, context: state.contextPressure || {}, token_usage: state.tokenUsage || {},
      session_stats: state.sessionStats || {},
      current_permission: model.currentPermission ? { id: model.currentPermission, label: model.currentPermission, target: { option_id: model.currentPermission } } : null,
      permission_options: model.permissionOptions,
      approval: approvalSnapshot(pendingApproval),
      interactive_surface: pendingQuestion ? questionSurface(pendingQuestion) : null,
      run: pendingApproval ? { status: "waiting_approval", approval_blocked: true, approval_request_id: pendingApproval.approvalId, primary_action: "approval" } : undefined,
      primary_action: pendingApproval ? "approval" : current.running ? "interrupt" : "send",
      // 这些是会话统计，不是 DeepSeek 账户套餐或余额。
      account_usage_supported: false,
      actions: [
        { id: "conversation.select", label: "切换会话", available: MODE === "desktop" },
        { id: "model.switch", label: "切换模型", available: !current.running && model.modelOptions.length > 0 },
        { id: "reasoning.switch", label: "切换推理强度", available: !current.running && model.reasoningOptions.length > 0 },
        { id: "permission.switch", label: "切换权限", available: !current.running && model.permissionOptions.some((option) => option.available) },
        { id: "rename", label: "重命名", available: true },
        { id: "archive", label: "归档", available: true },
      ],
    };
  }
  function hostDetailSnapshot(sessionId, item, foreground) {
    const state = item && item.projections && item.projections.values || {};
    const selection = state.modelSelection || state.model_selection || {};
    const current = selection.next || selection.lastUsed || {};
    const providerId = firstText(current.provider, current.providerId);
    const modelId = firstText(current.model, current.modelId);
    const modelLabel = firstText(current.displayName, current.display_name, current.name, modelId);
    const modelOption = providerId && modelId ? {
      id: `${providerId}:${modelId}`, label: modelLabel,
      target: { option_id: `${providerId}:${modelId}` }, available: true,
    } : null;
    const { currentPermission, permissionOptions } = permissionControls(state);
    return {
      native_session_id: sessionId, native_thread_id: sessionId, title: nativeSession(item || {}).Title,
      running: Boolean(item && item.running), model: modelLabel,
      current_model: { id: `${providerId}:${modelId}`, label: modelLabel, target: { option_id: `${providerId}:${modelId}` }, provider: providerId, model: modelId },
      model_options: modelOption ? [modelOption] : [], reasoning_options: [],
      current_permission: currentPermission ? { id: currentPermission, label: currentPermission, target: { option_id: currentPermission } } : null,
      permission_options: permissionOptions,
      context: state.contextPressure || {}, token_usage: state.tokenUsage || {}, session_stats: state.sessionStats || {},
      account_usage_supported: false,
      desktop_foreground: foreground === true, detail_stale: foreground !== true,
      actions: [
        { id: "conversation.select", label: "切换会话", available: MODE === "desktop" },
        { id: "permission.switch", label: "切换权限", available: !Boolean(item && item.running) && permissionOptions.some((option) => option.available) },
      ],
    };
  }
  async function settleRun(run) {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const current = await summary(run.sessionId);
        const history = await readPage(run.sessionId, 100);
        const newEvents = history.events.filter((row) => Number((row && row.event || row).seq || 0) > Number(run.beforeSeq || -1));
        const hasAssistant = newEvents.some((row) => (row && row.event || row).type === "assistant/message");
        if (!current.running && run.cancelRequested) {
          return { ID: run.id, Type: "run.interrupted", Status: "interrupted", Summary: "DeepSeek Harness 回复已停止", CreatedAt: now(), Payload: { native_session_id: run.sessionId, native_thread_id: run.sessionId } };
        }
        if (!current.running && hasAssistant) {
          const rows = historyTurns(history.events);
          const last = rows.at(-1);
          const response = last && last.messages.filter((message) => message.Role === "assistant").at(-1);
          return { ID: run.id, Type: "run.completed", Status: "completed", Summary: firstText(response && response.Content, "DeepSeek Harness 已完成回复"), CreatedAt: now(), Payload: { native_session_id: run.sessionId, native_thread_id: run.sessionId } };
        }
      } catch {
        // CDP 页面短暂重载时保留运行状态，下一轮继续读取持久化会话历史。
      }
      await sleep(RUN_POLL_MS);
    }
    return { ID: run.id, Type: "run.failed", Status: "failed", Summary: "等待 DeepSeek Harness 回复超时", CreatedAt: now(), Payload: { native_session_id: run.sessionId, native_thread_id: run.sessionId } };
  }
  async function readPage(sessionId, maxMessages = 100) {
    const value = await call("session.history", { sessionId, maxMessages });
    const events = Array.isArray(value && value.events) ? value.events : [];
    return { ...(value || {}), events };
  }
  async function startRun(sessionId, text, attachments = []) {
    if (!text && !attachments.length) throw new Error("消息不能为空。");
    const textParts = text ? [text] : [];
    const images = [];
    for (const attachment of attachments) {
      const filePath = firstText(attachment && attachment.LocalPath);
      const rawMimeType = firstText(attachment && attachment.MIMEType).toLowerCase();
      const mimeType = rawMimeType === "image/jpg" ? "image/jpeg" : rawMimeType;
      if (!filePath) throw new Error("附件缺少本地路径。");
      const name = firstText(attachment && attachment.Name, filePath);
      let data;
      try {
        data = await fs.readFile(filePath);
      } catch (error) {
        throw new Error(`无法读取附件 ${name}：${error instanceof Error ? error.message : String(error)}`);
      }
      const imageMimeType = imageAttachmentMimeType(name, mimeType);
      if (imageMimeType) {
        images.push({ type: "image", mediaType: imageMimeType, data: data.toString("base64"), ...(firstText(attachment && attachment.Name) ? { name: attachment.Name } : {}) });
        continue;
      }
      if (!textAttachmentSupported(name, mimeType) || data.byteLength > MAX_TEXT_ATTACHMENT_BYTES || data.includes(0)) {
        throw new Error(`DeepSeek Harness 仅支持图片和 UTF-8 文本附件：${name}`);
      }
      const fileText = data.toString("utf8");
      if (fileText.includes("\uFFFD")) throw new Error(`DeepSeek Harness 仅支持 UTF-8 文本附件：${name}`);
      textParts.push(`[附件：${name}]\n\`\`\`${textAttachmentLanguage(name)}\n${fileText}\n\`\`\``);
    }
    const content = [...(textParts.length ? [{ type: "text", text: textParts.join("\n\n") }] : []), ...images];
    let beforeSeq = -1;
    try {
      const before = await readPage(sessionId, 100);
      beforeSeq = Math.max(-1, ...(before.events || []).map((row) => Number((row && row.event || row).seq || -1)));
    } catch {
      try {
        const listing = await call("session.list", {});
        const item = Array.isArray(listing && listing.items) ? listing.items.find((candidate) => candidate && candidate.sessionId === sessionId) : null;
        const asOfSeq = item && item.projections && item.projections.asOfSeq;
        if (Number.isFinite(Number(asOfSeq))) beforeSeq = Number(asOfSeq);
      } catch {
        // 历史页和列表都暂时不可读时仍允许 Harness 接收新消息。
      }
    }
    await call("session.prompt", { requestId: crypto.randomUUID(), sessionId, mode: "queue", content, clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    const run = { id: crypto.randomUUID(), sessionId, startedAt: Date.now(), beforeSeq };
    run.promise = settleRun(run).then((event) => { run.final = event; return event; });
    runs.set(run.id, run);
    return run;
  }

  async function visibility(sessionId, marker = "") {
    if (!desktopTransport) {
      return { Visible: false, Marker: marker, Evidence: `session:${sessionId}`, CheckedAt: now(), FailureReason: "native 模式没有桌面前台" };
    }
    try {
      const current = await summary(sessionId);
      const title = summaryTitle(current);
      const selected = await desktop.selectSession(sessionId, title);
      const checked = await desktop.verifySession(sessionId, marker, title);
      return {
        Visible: Boolean(checked.visible || selected.selected === sessionId || selected.title_match),
        Marker: marker,
        Evidence: `session:${sessionId}`,
        CheckedAt: now(),
        FailureReason: checked.visible || selected.selected === sessionId || selected.title_match ? "" : "桌面页面未确认目标会话可见",
      };
    } catch (error) {
      return { Visible: false, Marker: marker, Evidence: `session:${sessionId}`, CheckedAt: now(), FailureReason: error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    id() { return PLUGIN_ID; },
    async probe() {
      try {
        if (desktopTransport) await desktop.probe();
        else await client.probe();
        approvalProtocolAvailable = desktopTransport && typeof desktop.probeApprovals === "function"
          ? await desktop.probeApprovals()
          : false;
        return capability(true, "", approvalProtocolAvailable);
      } catch (error) { return capability(false, error instanceof Error ? error.message : String(error)); }
    },
    async discover() {
      try {
        if (desktopTransport) await desktop.probe();
        else await client.probe();
        return { PluginID: PLUGIN_ID, Surface: MODE === "desktop" ? "deepseek-harness-desktop" : "deepseek-harness-api", Endpoint: desktopTransport ? "dsh-app://app/" : client.baseUrl, ProcessID: 0, SessionHints: { api_base_url: client.baseUrl, mode: MODE, transport: desktopTransport ? "cdp-page-rpc" : "http-rpc" }, Verified: true, Detail: desktopTransport ? "DeepSeek Harness 桌面页面已连接" : "DeepSeek Harness API 已连接" };
      } catch (error) { return { PluginID: PLUGIN_ID, Surface: "deepseek-harness", Endpoint: client.baseUrl, ProcessID: 0, SessionHints: { mode: MODE }, Verified: false, Detail: error instanceof Error ? error.message : String(error) }; }
    },
    async listSessions() { return (await summaries()).map((item) => nativeSession(item)); },
    async attachSession(req) { return checkSession({ NativeSessionID: firstText(req.NativeSessionID, req.NativeThreadID) }); },
    async openDraft(req) {
      const draftId = firstText(req && req.DraftID);
      if (!draftId) throw new Error("DeepSeek Harness 草稿需要 DraftID。");
      const cwd = firstText(req && req.Cwd);
      const draft = { DraftID: draftId, Cwd: cwd, DraftFingerprint: crypto.randomUUID(), OpenedAt: Date.now() };
      drafts.set(draftId, draft);
      return { DraftID: draftId, Cwd: cwd, Controls: draftControls(), DraftFingerprint: draft.DraftFingerprint };
    },
    async controlDraft(req) {
      const draft = activeDraft(req && req.DraftID);
      const action = actionName(req && (req.Action || req.action));
      if (action) throw new Error(`DeepSeek Harness 草稿不支持控制操作：${action}`);
      return { DraftID: draft.DraftID, Cwd: draft.Cwd, Controls: draftControls() };
    },
    async startDraftWithMessage(req) {
      const draft = activeDraft(req && req.DraftID);
      const message = req && req.Message || {};
      const result = await this.startSessionWithMessage({ ...req, Cwd: draft.Cwd, Message: message });
      drafts.delete(draft.DraftID);
      return result;
    },
    async startSessionWithMessage(req) {
      const messageId = firstText(req.Message && req.Message.PrismMessageID);
      if (messageId && starts.has(messageId)) {
        const prior = starts.get(messageId);
        if (prior.status === "accepted") {
          return { Session: await checkSession({ NativeSessionID: prior.sessionId }), Receipt: { NativeMessageID: prior.nativeMessageId, CanonicalNativeSessionID: prior.sessionId, CanonicalNativeThreadID: prior.sessionId, Accepted: true, Visible: Boolean(prior.visible), Detail: "重复请求已复用已创建的 DeepSeek Harness 会话" }, Visibility: { Visible: Boolean(prior.visible), Marker: firstText(req.Message && req.Message.Text), Evidence: `session:${prior.sessionId}`, CheckedAt: now(), FailureReason: prior.visible ? "" : "桌面页面尚未确认目标会话可见" } };
        }
        throw new Error("上一次新建 DeepSeek Harness 会话的结果未知，为避免重复发送，本次请求已拒绝重试。");
      }
      const created = await call("session.create", { cwd: firstText(req.Cwd) });
      const sessionId = firstText(created && created.sessionId);
      if (!sessionId) throw new Error("DeepSeek Harness 未返回新会话标识。");
      if (messageId) starts.set(messageId, { status: "created", sessionId });
      const run = await startRun(sessionId, firstText(req.Message && req.Message.Text), req.Message && req.Message.Attachments || []);
      const visibilityResult = await visibility(sessionId, firstText(req.Message && req.Message.Text));
      if (messageId) starts.set(messageId, { status: "accepted", sessionId, nativeMessageId: run.id, visible: visibilityResult.Visible });
      return { Session: await checkSession({ NativeSessionID: sessionId }), Receipt: { NativeMessageID: run.id, CanonicalNativeSessionID: sessionId, CanonicalNativeThreadID: sessionId, Accepted: true, Visible: visibilityResult.Visible, Detail: "已提交到 DeepSeek Harness" }, Visibility: visibilityResult };
    },
    async send(session, message) {
      const sessionId = idOf(session);
      await summary(sessionId);
      const run = await startRun(sessionId, firstText(message && message.Text), message && message.Attachments || []);
      const visibilityResult = await visibility(sessionId, firstText(message && message.Text));
      return { NativeMessageID: run.id, CanonicalNativeSessionID: sessionId, CanonicalNativeThreadID: sessionId, Accepted: true, Visible: visibilityResult.Visible, Detail: "已提交到 DeepSeek Harness" };
    },
    async *readHistoryStream(session, request = {}, signal) {
      const sessionId = idOf(session);
      const limit = Math.min(20, Math.max(1, Number(request.limit) || 20));
      const knownTurns = new Map();
      const acceptTurn = (turn) => {
        const fingerprint = historyTurnFingerprint(turn);
        const previous = knownTurns.get(turn.turn_id);
        if (previous && previous.fingerprint === fingerprint) return null;
        const revision = previous
          ? Math.max(previous.revision + 1, Number(turn.revision) || 0)
          : Math.max(1, Number(turn.revision) || 0);
        knownTurns.set(turn.turn_id, { fingerprint, revision });
        return { turn: { ...turn, revision }, operation: previous ? "replace" : "append" };
      };
      const initialPage = await readPage(sessionId, 100);
      const initialTurns = historyTurns(initialPage.events).slice(-limit).reverse();
      for (const turn of initialTurns) {
        const accepted = acceptTurn(turn);
        if (accepted) yield { stream_id: request.stream_id, type: "turn", source: "initial", operation: accepted.operation, turn: accepted.turn };
      }
      yield { stream_id: request.stream_id, type: "page_end", source: "initial", operation: "append" };
      if (request.live === false) {
        yield { stream_id: request.stream_id, type: "end", source: "initial", operation: "append" };
        return;
      }
      while (!signal || !signal.aborted) {
        await waitForHistoryUpdate(signal);
        if (signal && signal.aborted) return;
        try {
          const page = await readPage(sessionId, 100);
          const turns = historyTurns(page.events).slice(-limit);
          for (const turn of turns) {
            const accepted = acceptTurn(turn);
            if (accepted) yield { stream_id: request.stream_id, type: "turn", source: "live", operation: accepted.operation, turn: accepted.turn };
          }
        } catch {
          // 桌面页面短暂重载时保持正文流，下一轮轮询会从 Harness 历史重新收敛。
        }
      }
    },
    async readHistory(session, limit) {
      const page = await readPage(idOf(session), Math.max(1, Number(limit) || 100));
      return historyTurns(page.events).flatMap((turn) => turn.messages);
    },
    readDetail,
    async readStatus(session, runId) {
      const current = await summary(idOf(session));
      const run = runs.get(firstText(runId));
      const finalStatus = run && run.final && run.final.Status;
      const pending = [...approvals.values()].find((approval) => approval.sessionId === idOf(session));
      const status = pending ? "waiting_approval" : current.running ? "running" : finalStatus === "failed" ? "failed" : finalStatus === "interrupted" ? "interrupted" : finalStatus === "completed" ? "completed" : "idle";
      const values = current.projections && current.projections.values || {};
      return {
        status,
        preview: current.running ? "DeepSeek Harness 正在回复…" : "",
        context: values.contextPressure || {},
        interruptible: Boolean(current.running) && !pending, approval_blocked: Boolean(pending),
        ...(pending ? { approval_request_id: pending.approvalId } : {}),
        primary_action: pending ? "approval" : current.running ? "interrupt" : "send",
        ...(run ? { turn_id: run.id, started_at: new Date(run.startedAt).toISOString() } : {}),
      };
    },
    async resolveApproval(req) {
      if (!desktopTransport || !approvalProtocolAvailable || typeof desktop.respondApproval !== "function") {
        throw new Error("当前 DeepSeek Harness 版本不支持远程审批交互。");
      }
      const approvalId = firstText(req && req.ApprovalRequestID);
      const pending = approvals.get(approvalId);
      if (!pending) throw new Error("DeepSeek Harness 审批请求已失效或尚未同步到插件。");
      const sessionId = idOf(req && req.Session);
      if (sessionId && sessionId !== pending.sessionId) throw new Error("DeepSeek Harness 审批请求不属于当前会话。");
      const action = firstText(req && req.ActionID).toLowerCase().replace(/_/g, "-");
      const outcome = action === "allowed-once" || action === "allow-once" || action === "approve" ? "allowed-once"
        : action === "rejected" || action === "reject" || action === "deny" ? "rejected" : "";
      if (!outcome) throw new Error(`不支持 DeepSeek Harness 审批动作：${action || "unknown"}`);
      await desktop.respondApproval({ rpcId: pending.rpcId, sessionId: pending.sessionId, approvalId, outcome });
      // /api/respond 接受后，Harness 会通过 approval/resolved 广播最终状态；先删除本地
      // 待处理记录，避免在广播到达前将同一审批重新展示为可操作状态。
      approvals.delete(approvalId);
      enqueueInteractionUpdate({ type: "approval/resolved", sessionId: pending.sessionId, approvalId, outcome });
    },
    async controlSession(req) {
      const session = req.session || req.Session || req;
      const sessionId = idOf(session);
      const action = actionName(req.action || req.Action);
      const currentSession = await summary(sessionId);
      if (action === "conversation.select") {
        if (MODE !== "desktop") return { ok: true, action, thread_id: sessionId, message: "已在 Prism 中选中会话；原生模式不会改变桌面前台。", details: await readDetail(session), details_confirmed: true };
        try {
          await ensureDesktopWorkspace(currentSession);
          const selected = await desktop.selectSession(sessionId, summaryTitle(currentSession));
          if (!selected || (selected.selected !== sessionId && !selected.title_match)) throw new Error("DeepSeek Harness 未确认目标会话已切换到桌面前台。");
        }
        catch (error) { throw controlTargetStale(error instanceof Error ? error.message : String(error)); }
      } else if (action === "model.switch") {
        const target = req.target || req.Target || {};
        const optionId = firstText(target.option_id, target.optionId, typeof target === "string" ? target : "");
        const encoded = optionId.split(":");
        const provider = firstText(target.provider, target.Provider, encoded[0]);
        const model = firstText(target.model, target.Model, encoded.slice(1).join(":"));
        if (!provider || !model) throw new Error("切换模型需要 provider 和 model。");
        await call("session.selectModel", { sessionId, provider, model, ...(firstText(target.reasoningEffort, target.reasoning_effort) ? { reasoningEffort: firstText(target.reasoningEffort, target.reasoning_effort) } : {}) });
      } else if (action === "reasoning.switch") {
        const target = req.target || req.Target || {};
        const effort = firstText(target.reasoningEffort, target.reasoning_effort, target.option_id, target.optionId, typeof target === "string" ? target : "");
        const detail = await controls(sessionId);
        if (!effort || !detail.models.current) throw new Error("切换推理强度需要 reasoningEffort。");
        await call("session.selectModel", { sessionId, provider: detail.models.current.provider, model: detail.models.current.model, reasoningEffort: effort });
      } else if (action === "permission.switch") {
        const target = req.target || req.Target || {};
        const optionId = firstText(target.option_id, target.optionId, target.permission, target.value, typeof target === "string" ? target : "");
        if (!optionId || optionId === "custom") throw new Error("切换权限需要有效的权限预设。");
        const controlsForSession = await controls(sessionId);
        const option = controlsForSession.permissionOptions.find((item) => item.id === optionId);
        if (!option || !option.available) throw new Error(`DeepSeek Harness 不提供可切换的权限预设：${optionId}。`);
        const executed = await call("commands.execute", { agentId: sessionId, line: `/permission ${optionId}`, submittedAttachments: [] });
        if (!executed || !executed.result || executed.result.kind !== "success") {
          throw new Error(firstText(executed && executed.result && executed.result.text, "DeepSeek Harness 未接受权限切换。"));
        }
      } else if (action === "interactive.surface.apply") {
        const target = req.target || req.Target || {};
        const surfaceId = firstText(target.surface_id, target.surfaceId);
        const question = [...questions.values()].find((item) => item.surfaceId === surfaceId && item.sessionId === sessionId);
        if (!question) throw controlTargetStale("DeepSeek Harness 问题已失效或不属于当前会话。");
        const actionId = firstText(target.action_id, target.actionId);
        if (question.source === "desktop-dom") {
          await desktop.applyQuestionSurface(question.surfaceId, actionId, firstText(target.input));
        } else if (actionId === "submit") {
          await desktop.respondQuestion({ rpcId: question.rpcId, sessionId, answer: questionAnswer(question, firstText(target.input)) });
        } else if (actionId === "skip") {
          await desktop.respondQuestion({ rpcId: question.rpcId, sessionId, cancelled: true });
        } else {
          throw new Error(`不支持 DeepSeek Harness 问题动作：${actionId || "unknown"}`);
        }
        questions.delete(question.rpcId);
        enqueueInteractionUpdate({ type: "question/resolved", sessionId, questionRpcId: question.rpcId, outcome: actionId === "skip" ? "cancelled" : "answered" });
      } else if (action === "rename") {
        const title = firstText(req.name, req.Name, req.target && req.target.title);
        if (!title) throw new Error("重命名需要会话名称。");
        await call("session.rename", { sessionId, title });
      } else if (action === "archive") {
        await call("workspace.archiveSession", { sessionId, stopActivity: true });
      } else if (action !== "controls.describe" && action !== "describe.controls") {
        throw new Error(`不支持 DeepSeek Harness 控制操作：${action || "unknown"}`);
      }
      let details;
      try {
        details = await readDetail(session);
      } catch (error) {
        if (action !== "archive") throw error;
        details = { native_session_id: sessionId, native_thread_id: sessionId, archived: true, actions: [{ id: "archive", label: "归档", available: false }] };
      }
      if (action === "conversation.select" && MODE === "desktop") {
        details = { ...details, selected: true, desktop_foreground: true, detail_stale: false };
      }
      if (action === "interactive.surface.apply") {
        details = { ...details, desktop_foreground: true, detail_stale: false, interactive_surface: null, run: { status: "running", primary_action: "interrupt" }, primary_action: "interrupt" };
      }
      return {
        ok: true, action, thread_id: sessionId,
        message: "DeepSeek Harness 控制操作已完成。",
        details,
        details_confirmed: true,
      };
    },
    async interrupt(session) {
      const sessionId = idOf(session);
      await call("session.cancel", { sessionId });
      for (const run of runs.values()) if (run.sessionId === sessionId) run.cancelRequested = true;
    },
    async verifyVisibility(session, marker) {
      const sessionId = idOf(session);
      await summary(sessionId);
      return desktopTransport ? visibility(sessionId, marker) : { Visible: false, Marker: marker, Evidence: `session:${sessionId}`, CheckedAt: now(), FailureReason: "native 模式没有桌面前台" };
    },
    async waitForRun(session, runId) {
      const run = runs.get(firstText(runId));
      if (run) return run.promise;
      const current = await summary(idOf(session));
      return { ID: firstText(runId, crypto.randomUUID()), Type: current.running ? "run.running" : "run.completed", Status: current.running ? "running" : "completed", Summary: current.running ? "DeepSeek Harness 仍在回复" : "DeepSeek Harness 会话空闲", CreatedAt: now(), Payload: { native_session_id: idOf(session), native_thread_id: idOf(session) } };
    },
    async *subscribe(session, signal) {
      const sessionId = idOf(session);
      if (desktopTransport) {
        for await (const frame of desktop.watchSession(sessionId, signal)) {
          const event = frame.event || {};
          yield { ID: `dsh:${sessionId}:${event.seq || crypto.randomUUID()}`, Type: `dsh.${event.type || frame.type}`, Status: event.type === "turn/end" ? "completed" : "running", Summary: dshEventSummary(frame), CreatedAt: iso(event.time), Payload: { native_session_id: sessionId, native_thread_id: sessionId, event: frame } };
        }
        return;
      }
      for await (const frame of reconnectingDshEvents(client.baseUrl, "/api/events.mux", signal)) {
        if (frame.sessionId !== sessionId) continue;
        const event = frame.event || {};
        yield { ID: `dsh:${sessionId}:${event.seq || crypto.randomUUID()}`, Type: `dsh.${event.type || frame.type}`, Status: event.type === "turn/end" ? "completed" : "running", Summary: dshEventSummary(frame), CreatedAt: iso(event.time), Payload: { native_session_id: sessionId, native_thread_id: sessionId, event: frame } };
      }
    },
    async *subscribePlugin(signal) {
      if (desktopTransport) {
        const hostIterator = desktop.watchHost(signal)[Symbol.asyncIterator]();
        let hostNext = hostIterator.next();
        let interactionNext = nextInteractionUpdate(signal);
        try {
          while (!signal || !signal.aborted) {
            const next = await Promise.race([
              hostNext.then((result) => ({ source: "host", result })),
              interactionNext.then((frame) => ({ source: "interaction", frame })),
            ]);
            if (next.source === "interaction") {
              interactionNext = nextInteractionUpdate(signal);
              if (!next.frame) continue;
              const event = next.frame.type.startsWith("approval/")
                ? approvalEvent(next.frame, next.frame.type === "approval/requested" ? "requested" : "resolved")
                : questionEvent(next.frame, next.frame.type === "question/requested" ? "requested" : "resolved");
              if (event) yield event;
              continue;
            }
            if (next.result.done) return;
            const frame = next.result.value;
            hostNext = hostIterator.next();
          if (["approval/requested", "approval/resolved", "question/requested", "question/resolved"].includes(frame.type)) {
            const event = frame.type.startsWith("approval/")
              ? approvalEvent(frame, frame.type === "approval/requested" ? "requested" : "resolved")
              : questionEvent(frame, frame.type === "question/requested" ? "requested" : "resolved");
            if (event) yield event;
            continue;
          }
          const sessionId = firstText(frame.sessionId);
          const session = sessionId ? {
            PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId,
            Surface: "deepseek-harness-desktop", Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`, Cwd: "", Visible: true,
          } : null;
          const item = frame.item || {};
          const foregroundStatusChanged = frame.type === "host/session-status" && frame.foreground === true && frame.foregroundTransition !== true;
          if (session && (frame.type === "host/session-foreground" || foregroundStatusChanged)) {
            const initialDetail = hostDetailSnapshot(sessionId, item, frame.foreground === true);
            session.Cwd = firstText(item.cwd);
            yield { ID: `dsh:host:detail:${sessionId}:${initialDetail.desktop_foreground ? "live" : "stale"}:projection`, Type: "dsh.desktop.state.changed", Status: initialDetail.desktop_foreground ? "running" : "completed", Summary: initialDetail.desktop_foreground ? "DeepSeek Harness 前台会话已确认" : "DeepSeek Harness 会话已离开桌面前台", CreatedAt: now(), Payload: { native_session: session, detail_snapshot: initialDetail, frame } };
            try {
              const detail = await readDetail({ NativeSessionID: sessionId });
              detail.desktop_foreground = initialDetail.desktop_foreground;
              detail.detail_stale = initialDetail.detail_stale;
              yield { ID: `dsh:host:detail:${sessionId}:${detail.desktop_foreground ? "live" : "stale"}:catalog`, Type: "dsh.desktop.state.changed", Status: detail.desktop_foreground ? "running" : "completed", Summary: detail.desktop_foreground ? "DeepSeek Harness 前台会话详情已补全" : "DeepSeek Harness 会话详情已更新", CreatedAt: now(), Payload: { native_session: session, detail_snapshot: detail, frame } };
            } catch {
              // 页面短暂重载时已保留目录投影快照，下一轮前台探测会补全详情。
            }
          }
          yield { ID: `dsh:host:${frame.type}:${sessionId || crypto.randomUUID()}`, Type: `dsh.${frame.type || "host"}`, Status: "completed", Summary: dshEventSummary(frame), CreatedAt: now(), Payload: { ...(session ? { native_session: session } : {}), frame } };
        }
        } finally {
          interactionUpdateWake = null;
          await hostIterator.return?.();
        }
        return;
      }
      for await (const frame of reconnectingDshEvents(client.baseUrl, "/api/events.host", signal)) {
        const sessionId = firstText(frame.sessionId);
        const session = sessionId ? {
          PluginID: PLUGIN_ID, NativeSessionID: sessionId, NativeThreadID: sessionId,
          Surface: MODE === "desktop" ? "deepseek-harness-desktop" : "deepseek-harness-api",
          Endpoint: `dsh://session/${encodeURIComponent(sessionId)}`, Cwd: "", Visible: MODE === "desktop",
        } : null;
        yield { ID: `dsh:host:${frame.type}:${sessionId || crypto.randomUUID()}`, Type: `dsh.${frame.type || "host"}`, Status: "completed", Summary: dshEventSummary(frame), CreatedAt: now(), Payload: { ...(session ? { native_session: session } : {}), frame } };
      }
    },
    async readAgentUsage() { return null; },
    async close() {},
  };
}

const adapter = createAdapter();

if (require.main === module) {
  pluginBridge.serve(adapter).then(() => adapter.close()).catch((error) => {
    console.error("插件进程错误：", error && error.stack ? error.stack : String(error));
    process.exit(1);
  });
}

module.exports = { createAdapter, historyTurns, nativeSession, textOf, imageAttachmentMimeType };
