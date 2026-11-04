import { cp, mkdir, readFile, readlink, readdir, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const platform = process.env.PRISM_PLATFORM;
const manifest = await readFile(resolve(root, "pluginbridge-plugin.yaml"), "utf8");
const id = manifest.match(/^id:\s*(.+)$/m)?.[1]?.trim();
const version = manifest.match(/^version:\s*(.+)$/m)?.[1]?.trim();
if (!platform || !id || !version) throw new Error("需要 PRISM_PLATFORM、插件 ID 和版本号");
const destination = resolve(root, "release", `${id}-${version}-${platform}`);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
const skip = new Set([".git", ".github", ".agents", "conformance", "release", "scripts", "test", ".DS_Store"]);
for (const entry of await readdir(root)) if (!skip.has(entry)) await cp(resolve(root, entry), resolve(destination, entry), { recursive: true, verbatimSymlinks: true });

async function assertNoAbsoluteSymlinks(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await readlink(path);
      if (isAbsolute(target)) throw new Error(`发布归档不能包含绝对软链接: ${path} -> ${target}`);
    } else if (entry.isDirectory()) await assertNoAbsoluteSymlinks(path);
  }
}
await assertNoAbsoluteSymlinks(destination);
console.log(destination);
