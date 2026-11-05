const assert = require("node:assert/strict");
const { test } = require("node:test");
const { mkdtemp, readFile, rm, writeFile } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const packageVersion = require("../package.json").version;

const run = promisify(execFile);
const root = join(__dirname, "..");

test("发布元数据保留 DeepSeek Harness 图标 URL", async () => {
  const artifacts = await mkdtemp(join(tmpdir(), "dsh-release-metadata-"));
  try {
    for (const target of ["macos-arm64", "macos-x64", "windows-x64", "linux-x64"]) {
      await writeFile(join(artifacts, `dsh-${packageVersion}-${target}.tar.gz`), `${target}\n`);
    }
    await run(process.execPath, [join(root, "scripts/create-release-metadata.mjs"), artifacts], { cwd: root });
    const metadata = JSON.parse(await readFile(join(artifacts, "plugin-release.json"), "utf8"));
    assert.equal(metadata.display_name, "DeepSeek Harness");
    assert.equal(metadata.description, "连接本机 DeepSeek Harness，会话可在 Prism Hub、移动端和桌面端之间继续使用。");
    assert.equal(metadata.icon_url, "https://www.deepseek.com/harness/favicon.svg");
    assert.equal(metadata.icon_svg_url, "https://www.deepseek.com/harness/favicon.svg");
  } finally {
    await rm(artifacts, { recursive: true, force: true });
  }
});
