# bibtex-mcp

CLI and MCP server for fetching multiple BibTeX options from Google Scholar's visible citation export flow.

## What Was Reverse Engineered

Google Scholar search results include a per-result Scholar id in the result container. The visible `Cite` button loads:

```text
https://scholar.google.com/scholar?q=info:{scholarId}:scholar.google.com/&output=cite&scirp={rank}&hl=en
```

That citation dialog HTML contains a signed `scholar.bib` link on `scholar.googleusercontent.com`. This package follows that same two-step flow:

1. Search Scholar for the paper title.
2. Read the result ids from the Scholar result HTML.
3. Follow `All versions` links for preprint/unknown rows so archival versions hidden behind an arXiv result can be found.
4. Fetch the matching citation dialog HTML.
5. Extract and fetch Scholar's BibTeX link.
6. Rank options so archival conference/journal/publisher records come before preprints when Scholar exposes both.

The tool does not bypass CAPTCHA, paywalls, rate limits, or access controls.

## Install

```bash
npm install
npm run build
```

## CLI

```bash
npm run cli -- "Attention Is All You Need"
npm run cli -- --exact --json "Attention Is All You Need"
npm run cli -- --limit 20 --json "Attention Is All You Need"
```

After a global install or `npm link`:

```bash
scholar-bibtex "Attention Is All You Need"
```

## MCP

Build first, then configure your MCP client to run:

```bash
node /absolute/path/to/bibtex-mcp/dist/mcp.js
```

### Install With add-mcp

For a local checkout:

```bash
npm install
npm run build
npx add-mcp "node $(pwd)/dist/mcp.js" --name scholar-bibtex -a codex -y
```

For a published npm package:

```bash
npx add-mcp bibtex-mcp --name scholar-bibtex -a codex -y
```

Equivalently, use the explicit stdio command form:

```bash
npx add-mcp "npx -y bibtex-mcp" --name scholar-bibtex -a codex -y
```

You can also install directly from the public GitHub repo:

```bash
npx add-mcp "npx -y github:aryankeluskar/bibtex-mcp" --name scholar-bibtex -a codex -y
```

Change `-a codex` to another supported agent such as `claude-code`, `cursor`, `vscode`, or `opencode`.

The server exposes one tool:

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

## Agent Skill

This repo includes an installable skill for agents that use the `skills` CLI:

```bash
npx skills add aryankeluskar/bibtex-mcp --skill google-scholar-bibtex-mcp --full-depth
```

From a local checkout, list or install it with:

```bash
npx skills add . --list --full-depth
npx skills add . --skill google-scholar-bibtex-mcp --full-depth -y
```

The skill tells agents how to install this MCP with `add-mcp`, call `google_scholar_bibtex`, and select archival records over preprints.

## Stress Test

Run the deterministic stress test without hitting Google Scholar:

```bash
npm run stress
```

The stress test uses fixture mode to validate the CLI, stdio MCP concurrency, archival ranking, and `add-mcp` Codex project config generation.

## Accuracy Notes

The BibTeX is sourced from Google Scholar's citation export, which is better than generated citations but still not infallible. Scholar can contain duplicate records, incomplete metadata, or venue variants.

By default the tool returns multiple options and ranks likely archival records above preprints. It also follows Scholar `All versions` clusters for non-archival rows so the conference or journal version can outrank a top-level preprint result. The ranking uses signals from the Scholar row, such as venue text and publisher/proceedings domains. For camera-ready bibliographies, pick the highest-ranked archival option whose title and venue match the paper PDF, proceedings page, DOI/Crossref, or publisher page.
