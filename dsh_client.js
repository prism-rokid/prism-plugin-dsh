"use strict";

const crypto = require("crypto");

function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function baseUrl(value = process.env.DSH_API_BASE_URL || "http://127.0.0.1:3080") {
  const normalized = String(value).replace(/\/+$/, "");
  return normalized.endsWith("/api") ? normalized.slice(0, -4) : normalized;
}

class DshRpcError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

class DshClient {
  constructor(options = {}) {
    this.baseUrl = baseUrl(options.baseUrl);
    this.fetch = options.fetch || globalThis.fetch;
    this.timeoutMs = Number(options.timeoutMs || 30000);
    this.launchToken = firstText(options.launchToken, process.env.DSH_API_TOKEN);
    this.cookie = firstText(options.cookie, process.env.DSH_API_COOKIE);
    this.authPromise = null;
  }

  apiUrl(method) {
    return `${this.baseUrl}/api/${String(method)}`;
  }

  async call(method, payload = {}, options = {}) {
    if (typeof this.fetch !== "function") throw new Error("当前 Node 运行时不支持 fetch。");
    await this.authenticate();
    const rpcId = crypto.randomUUID();
    const wireMethod = String(method);
    const timeout = options.timeoutMs === 0 ? null : AbortSignal.timeout(Number(options.timeoutMs || this.timeoutMs));
    const signal = options.signal && timeout ? AbortSignal.any([options.signal, timeout]) : options.signal || timeout || undefined;
    let response;
    try {
      const headers = { "content-type": "application/json" };
      if (this.cookie) headers.cookie = this.cookie;
      response = await this.fetch(this.apiUrl(method), {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "client-request", rpcId, method: wireMethod, payload }),
        signal,
      });
    } catch (error) {
      throw new Error(`无法连接 DeepSeek Harness（${this.baseUrl}）：${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      if (response.status === 401) {
        throw new Error("DeepSeek Harness 未认证：请配置 DSH_API_TOKEN（启动 URL 中的 token）或 DSH_API_COOKIE。");
      }
      throw new Error(`DeepSeek Harness 请求 ${method} 失败：HTTP ${response.status}`);
    }
    let message;
    try {
      message = await response.json();
    } catch {
      throw new Error(`DeepSeek Harness 请求 ${method} 返回了无效 JSON。`);
    }
    if (!message || message.type !== "server-response" || message.rpcId !== rpcId || !message.result) {
      throw new Error(`DeepSeek Harness 请求 ${method} 返回了无效 RPC 信封。`);
    }
    if (!message.result.ok) {
      const error = message.result.error || {};
      throw new DshRpcError(firstText(error.code, "internal"), firstText(error.message, `DeepSeek Harness 拒绝 ${method}`), error.details || {});
    }
    return message.result.value;
  }

  async probe() {
    await this.call("session.list", {});
  }

  async authenticate() {
    if (this.cookie || !this.launchToken) return;
    if (!this.authPromise) this.authPromise = this.exchangeLaunchToken();
    await this.authPromise;
  }

  async exchangeLaunchToken() {
    const response = await this.fetch(`${this.baseUrl}/?token=${encodeURIComponent(this.launchToken)}`, {
      method: "GET",
      redirect: "manual",
    });
    if (response.status !== 302 && response.status !== 303) {
      throw new Error(`DeepSeek Harness 认证失败：启动 token 无效（HTTP ${response.status}）。`);
    }
    const setCookie = response.headers.get("set-cookie");
    if (!setCookie) throw new Error("DeepSeek Harness 认证失败：未返回会话 Cookie。");
    this.cookie = setCookie.split(",")[0].split(";")[0];
  }
}

module.exports = { DshClient, DshRpcError, baseUrl, firstText };
