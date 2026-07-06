#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fixtureEnv = { ...process.env, BIBTEX_MCP_FIXTURE_MODE: "internal-stress-test-only" };

await run("build", async () => {
  await execFileAsync("npm", ["run", "build"], { cwd: projectRoot, env: process.env });
});

await run("CLI fixture export", async () => {
  const { stdout } = await execFileAsync(
    "node",
    ["dist/cli.js", "--limit", "12", "--json", "Fixture Research Paper"],
    { cwd: projectRoot, env: fixtureEnv, maxBuffer: 1024 * 1024 * 10 },
  );
  const payload = JSON.parse(stdout);
  assert(payload.results.length === 12, `expected 12 CLI results, got ${payload.results.length}`);
  assert(payload.results.every((result) => result.sourceType === "archival"), "expected returned CLI options to prefer archival records");
  assert(payload.results.every((result) => result.origin === "versions"), "expected archival records to come from version clusters");
  assert(payload.results.every((result) => result.bibtex.startsWith("@inproceedings")), "expected archival fixture BibTeX first");
});

await run("CLI argument validation", async () => {
  try {
    await execFileAsync("node", ["dist/cli.js", "--limit", "not-a-number", "Fixture Research Paper"], {
      cwd: projectRoot,
      env: fixtureEnv,
    });
  } catch (error) {
    const stderr = String(error.stderr ?? "");
    assert(stderr.includes("--limit requires a positive integer"), "expected invalid --limit to fail clearly");
    return;
  }

  throw new Error("invalid --limit unexpectedly succeeded");
});

await run("MCP stdio concurrency", async () => {
  const client = new Client({ name: "bibtex-mcp-stress", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/mcp.js"],
    cwd: projectRoot,
    env: fixtureEnv,
    stderr: "pipe",
  });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(
      tools.tools.some((tool) => tool.name === "google_scholar_bibtex"),
      "google_scholar_bibtex tool was not registered",
    );

    const calls = Array.from({ length: 40 }, () =>
      client.callTool({
        name: "google_scholar_bibtex",
        arguments: { query: "Fixture Research Paper", maxResults: 12 },
      }),
    );

    const results = await Promise.all(calls);
    for (const [index, result] of results.entries()) {
      const text = result.content?.[0]?.type === "text" ? result.content[0].text : "";
      const payload = JSON.parse(text);
      assert(payload.results.length === 12, `MCP call ${index} returned ${payload.results.length} results`);
      assert(
        payload.results.every((entry) => entry.sourceType === "archival"),
        `MCP call ${index} did not prefer archival records`,
      );
    }

    const defaultResult = await client.callTool({
      name: "google_scholar_bibtex",
      arguments: { query: "Fixture Research Paper" },
    });
    const defaultText = defaultResult.content?.[0]?.type === "text" ? defaultResult.content[0].text : "";
    const defaultPayload = JSON.parse(defaultText);
    assert(defaultPayload.results.length === 10, `default MCP call returned ${defaultPayload.results.length} results`);
  } finally {
    await client.close();
  }
});

await run("add-mcp Codex project install", async () => {
  const tempHome = await mkdtemp(join(tmpdir(), "bibtex-mcp-home-"));
  const tempProject = await mkdtemp(join(tmpdir(), "bibtex-mcp-project-"));
  const tempConfig = join(tempHome, ".config");

  try {
    await execFileAsync(
      "npx",
      [
        "--yes",
        "add-mcp",
        `node ${join(projectRoot, "dist", "mcp.js")}`,
        "--name",
        "scholar-bibtex",
        "-a",
        "codex",
        "-y",
      ],
      {
        cwd: tempProject,
        env: { ...process.env, HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
        maxBuffer: 1024 * 1024 * 10,
      },
    );

    const config = await readFile(join(tempProject, ".codex", "config.toml"), "utf8");
    assert(config.includes("scholar-bibtex"), "add-mcp Codex config is missing the server name");
    assert(config.includes(join(projectRoot, "dist", "mcp.js")), "add-mcp Codex config is missing the server path");
  } finally {
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  }
});

await run("add-mcp npx package install", async () => {
  const tempPack = await mkdtemp(join(tmpdir(), "bibtex-mcp-pack-"));
  const tempHome = await mkdtemp(join(tmpdir(), "bibtex-mcp-home-"));
  const tempProject = await mkdtemp(join(tmpdir(), "bibtex-mcp-project-"));
  const tempConfig = join(tempHome, ".config");

  try {
    const { stdout } = await execFileAsync("npm", ["pack", "--pack-destination", tempPack], {
      cwd: projectRoot,
      env: process.env,
      maxBuffer: 1024 * 1024 * 10,
    });
    const tarballName = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .findLast((line) => /^bibtex-mcp-\d.*\.tgz$/.test(line));
    assert(tarballName, "npm pack did not report a tarball name");

    const tarballPath = join(tempPack, tarballName);
    const command = `npx --yes --package ${tarballPath} bibtex-mcp`;
    await execFileAsync(
      "npx",
      ["--yes", "add-mcp", command, "--name", "scholar-bibtex", "-a", "codex", "-y"],
      {
        cwd: tempProject,
        env: { ...process.env, HOME: tempHome, XDG_CONFIG_HOME: tempConfig },
        maxBuffer: 1024 * 1024 * 10,
      },
    );

    const config = await readFile(join(tempProject, ".codex", "config.toml"), "utf8");
    assert(config.includes("scholar-bibtex"), "package add-mcp config is missing the server name");
    assert(config.includes("bibtex-mcp"), "package add-mcp config is missing the package bin");
    assert(config.includes(tarballPath), "package add-mcp config is missing the package tarball path");
  } finally {
    await rm(tempPack, { recursive: true, force: true });
    await rm(tempHome, { recursive: true, force: true });
    await rm(tempProject, { recursive: true, force: true });
  }
});

console.log("stress: all checks passed");

async function run(name, fn) {
  const started = Date.now();
  process.stdout.write(`stress: ${name}... `);
  await fn();
  console.log(`${Date.now() - started}ms`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
