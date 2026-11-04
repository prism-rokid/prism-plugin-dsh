import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const rawCommand = manifest.match(/^command:\s*(\[[^\n]+\])$/m)?.[1];
if (!id || !rawCommand) throw new Error("manifest 缺少有效的 command");
const command = JSON.parse(rawCommand).map((part) => part === "${runtime.node}" ? process.execPath : part);
if (command[0].startsWith("./")) command[0] = resolve(root, command[0]);
if (process.platform === "win32" && extname(command[0]) === "") command[0] += ".exe";
const child = spawn(command[0], command.slice(1), { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });
const response = await new Promise((resolveResponse, reject) => {
  const timer = setTimeout(() => reject(new Error(`probe 超时：${stderr}`)), 15000);
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const line = buffer.split("\n").find((value) => value.trim());
    if (!line) return;
    clearTimeout(timer);
    try { resolveResponse(JSON.parse(line)); } catch (error) { reject(error); }
  });
  child.once("error", reject);
  child.once("exit", (code) => { if (code !== 0) reject(new Error(`probe 进程退出 ${code}：${stderr}`)); });
  child.stdin.end('{"id":"release-probe","method":"adapter.probe","params":{}}\n');
});
if (response.id !== "release-probe" || response.ok !== true || response.payload?.plugin_id !== id) throw new Error(`probe 响应无效：${JSON.stringify(response)}`);
console.log(`DSH PluginBridge 探测通过；available=${Boolean(response.payload.available)}`);
