"use strict";

const { firstText } = require("./dsh_client");

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Harness 的 Web 端使用 WebSocket 发送 server-request 信封。
 * 这里不依赖 Harness 源码包，以便插件发布后仍可独立运行。
 */
async function* readDshEventStream(baseUrl, path, signal) {
  const root = String(baseUrl).replace(/\/+$/, "");
  const url = `${root.replace(/^http:/, "ws:").replace(/^https:/, "wss:")}${path}`;
  const socket = new WebSocket(url);
  const inbox = [];
  let wake = null;
  let closed = false;
  const enqueue = (item) => {
    inbox.push(item);
    if (wake) {
      wake();
      wake = null;
    }
  };
  const onMessage = (event) => {
    try {
      const message = JSON.parse(String(event.data));
      if (message && message.type === "server-request" && message.payload) enqueue({ type: "frame", value: message.payload });
    } catch {
      // 单条损坏事件不应使整个同步通道失效。
    }
  };
  const onClose = () => {
    closed = true;
    enqueue({ type: "end" });
  };
  const onError = () => {
    closed = true;
    enqueue({ type: "end" });
    try { socket.close(); } catch {}
  };
  const onAbort = () => {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close();
  };
  socket.addEventListener("message", onMessage);
  socket.addEventListener("error", onError);
  socket.addEventListener("close", onClose, { once: true });
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      while (inbox.length) {
        const item = inbox.shift();
        if (item.type === "end") return;
        yield item.value;
      }
      if (closed) return;
      await new Promise((resolve) => { wake = resolve; });
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    socket.removeEventListener("message", onMessage);
    socket.removeEventListener("error", onError);
    socket.removeEventListener("close", onClose);
    onAbort();
  }
}

async function* reconnectingDshEvents(baseUrl, path, signal) {
  while (!signal?.aborted) {
    try {
      yield* readDshEventStream(baseUrl, path, signal);
    } catch (error) {
      if (signal?.aborted) return;
      // 本地应用重启时短暂断流是预期情况，采用有界重连避免忙循环。
      await sleep(800);
    }
    if (!signal?.aborted) await sleep(250);
  }
}

function dshEventSummary(frame) {
  const type = firstText(frame && frame.type, "unknown");
  if (type === "host/session-added") return "DeepSeek Harness 新建了会话";
  if (type === "host/session-removed") return "DeepSeek Harness 移除了会话";
  if (type === "host/session-status") return frame.running ? "DeepSeek Harness 会话正在运行" : "DeepSeek Harness 会话已空闲";
  if (type === "session/event") return firstText(frame.event && frame.event.type, "DeepSeek Harness 会话更新");
  return `DeepSeek Harness 事件：${type}`;
}

module.exports = { dshEventSummary, reconnectingDshEvents, sleep };
