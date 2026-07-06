---
name: google-scholar-bibtex-mcp
description: Install and use the bibtex-mcp Google Scholar citation server. Use when an agent needs Scholar-sourced BibTeX for paper titles, wants multiple citation options, must prefer archival conference/journal/proceedings records over preprints, or needs add-mcp setup commands for Codex, Claude Code, Cursor, VS Code, OpenCode, or other MCP clients.
---

# Google Scholar BibTeX MCP

Use this skill when a task needs BibTeX records from Google Scholar rather than model-generated citations.

## Install The MCP

If this repository is checked out locally:

```bash
npm install
npm run build
npx add-mcp "node /absolute/path/to/bibtex-mcp/dist/mcp.js" --name scholar-bibtex -a codex -y
```

For a published npm package:

```bash
npx add-mcp bibtex-mcp --name scholar-bibtex -a codex -y
```

If direct package-name installation is not suitable, use the explicit command form:

```bash
npx add-mcp "npx -y bibtex-mcp" --name scholar-bibtex -a codex -y
```

You can also install from the public GitHub repo:

```bash
npx add-mcp "npx -y github:aryankeluskar/bibtex-mcp" --name scholar-bibtex -a codex -y
```

Adjust `-a codex` for the target client. `add-mcp` supports agents such as `codex`, `claude-code`, `cursor`, `vscode`, and `opencode`. Use `--all` only when the user explicitly wants broad installation.

## Use The MCP Tool

Call:

```text
google_scholar_bibtex
```

Input:

```json
{
  "query": "Attention Is All You Need",
  "maxResults": 10,
  "exactTitle": false
}
```

Guidelines:

- Request multiple results by default. Do not force `maxResults: 1` unless the user explicitly asks for a single record.
- Prefer returned options with `sourceType: "archival"` over `sourceType: "preprint"` when the title matches.
- Treat `origin: "versions"` as useful: the MCP follows Scholar `All versions` clusters so archival conference/journal records can beat top-level arXiv/preprint rows.
- Use `exactTitle: true` when the user gives a precise paper title and similarly named papers are likely.
- Inspect `title`, `authorsLine`, `url`, `sourceType`, and `archivalReason` before selecting the final BibTeX.
- Keep alternatives visible when the citation is for a paper, thesis, preprint, workshop version, conference version, or journal extension that could have multiple legitimate records.

## Failure Handling

If Google Scholar returns an anti-automation or CAPTCHA interstitial, report that clearly. Do not bypass CAPTCHA, rate limits, paywalls, or access controls. Ask the user to retry later or use the browser-visible Scholar flow manually.

For local stress testing without hitting Scholar:

```bash
npm run stress
```
