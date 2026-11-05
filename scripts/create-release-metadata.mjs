import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const artifacts = resolve(root, process.argv[2] || "release-artifacts");
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const field = (name) => manifest.match(new RegExp(`^${name}:\\s*(.+)$`, "m"))?.[1]?.trim().replace(/^(?:"|')|(?:"|')$/g, "");
const id = field("id");
const version = field("version");
const displayName = field("display_name");
const description = field("description");
const iconURL = field("icon_url");
const iconSVGURL = field("icon_svg_url");
if (!id || !version || !displayName || !iconURL || !iconSVGURL) throw new Error("manifest 必须声明 id、version、display_name、icon_url 和 icon_svg_url");
const names = (await readdir(artifacts)).filter((name) => name.endsWith(".tar.gz")).sort();
if (names.length !== 4) throw new Error(`需要四个目标平台包，当前为 ${names.length}`);
const assets = await Promise.all(names.map(async (name) => {
  const match = name.match(new RegExp(`^${id}-${version}-(macos-arm64|macos-x64|windows-x64|linux-x64)\\.tar\\.gz$`));
  if (!match) throw new Error(`无效的插件包名：${name}`);
  const bytes = await readFile(resolve(artifacts, name));
  return { target: match[1], filename: name, sha256: createHash("sha256").update(bytes).digest("hex"), supported: true };
}));
await writeFile(resolve(artifacts, "plugin-release.json"), JSON.stringify({
  schema_version: 1, plugin_id: id, version, release_tag: `v${version}`, channel: "stable",
  plugin_protocol_version: field("plugin_protocol_version"), min_hub_version: field("min_hub_version"),
  display_name: displayName, description,
  icon_url: iconURL, icon_svg_url: iconSVGURL,
  supported_platforms: assets.map((asset) => asset.target), assets,
}, null, 2) + "\n");
