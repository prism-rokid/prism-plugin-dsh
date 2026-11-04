import { readFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const manifest = await readFile(new URL("pluginbridge-plugin.yaml", root), "utf8");
const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const field = (name) => manifest.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^(?:"|')|(?:"|')$/g, "");
const required = ["id", "schema_version", "version", "plugin_protocol_version", "min_hub_version", "icon_url", "icon_svg_url"];
for (const name of required) if (!field(name)) throw new Error(`manifest 缺少 ${name}`);
if (field("id") !== "dsh") throw new Error("插件 ID 必须为 dsh");
if (field("version") !== pkg.version) throw new Error("manifest 与 package.json 版本不一致");
if (field("schema_version") !== "1" || field("plugin_protocol_version") !== "4") throw new Error("manifest 协议版本不符合 Prism 要求");
if (!/^https:\/\/www\.deepseek\.com\/harness\/favicon\.svg$/.test(field("icon_url")) || field("icon_svg_url") !== field("icon_url")) throw new Error("DSH 必须使用 DeepSeek Harness favicon");
const command = manifest.match(/^command:\s*(\[[^\r\n]+\])\r?$/m)?.[1];
const nodeRange = manifest.match(/^runtime_dependencies:\r?\n\s+node:\s*["']([^"']+)["']\r?$/m)?.[1];
if (!command || !command.includes("${runtime.node}") || !nodeRange) throw new Error("Node 插件必须声明 Hub 托管 Node 运行时和 command");
const platforms = new Set(["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]);
if (process.env.GITHUB_ACTIONS && !platforms.has(process.env.PRISM_PLATFORM || "")) throw new Error("CI 缺少有效的 PRISM_PLATFORM");
if (process.env.GITHUB_REF_TYPE === "tag" && process.env.GITHUB_REF_NAME !== `v${field("version")}`) throw new Error("tag、manifest 和 package 版本必须一致");
console.log(JSON.stringify({ id: field("id"), version: field("version"), protocol: field("plugin_protocol_version"), platform: process.env.PRISM_PLATFORM || "local" }));
