#!/usr/bin/env node
import { getScholarBibtex, ScholarError } from "./scholar.js";

interface CliOptions {
  query: string;
  maxResults: number;
  exactTitle: boolean;
  json: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const results = await getScholarBibtex(options.query, {
    maxResults: options.maxResults,
    exactTitle: options.exactTitle,
  });

  if (options.json) {
    process.stdout.write(`${JSON.stringify({ query: options.query, results }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`${results.map((result, index) => formatBibtexOption(result, index)).join("\n\n")}\n`);
}

function parseArgs(args: string[]): CliOptions {
  let maxResults = 10;
  let exactTitle = false;
  let json = false;
  const queryParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--limit" || arg === "-n") {
      const value = args[index + 1];
      if (!value) throw new Error("--limit requires a number.");
      maxResults = parsePositiveInteger(value, "--limit");
      index += 1;
    } else if (arg === "--exact") {
      exactTitle = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      queryParts.push(arg);
    }
  }

  return {
    query: queryParts.join(" "),
    maxResults,
    exactTitle,
    json,
  };
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${option} requires a positive integer.`);
  }
  return parsed;
}

function printHelp(): void {
  process.stdout.write(`Usage: scholar-bibtex [options] <paper title>

Options:
  -n, --limit <n>  Number of Scholar options to return (default: 10)
  --exact         Prefer exact title matches before archival ranking
  --json          Return result metadata plus BibTeX as JSON
  -h, --help      Show this help

Examples:
  scholar-bibtex "Attention Is All You Need"
  scholar-bibtex --exact --json "Attention Is All You Need"
`);
}

function formatBibtexOption(result: Awaited<ReturnType<typeof getScholarBibtex>>[number], index: number): string {
  const lines = [
    `% Scholar option ${index + 1}: ${result.sourceType} (${result.archivalReason})`,
    `% Title: ${result.title}`,
  ];

  if (result.origin === "versions") {
    lines.push(
      `% Scholar source: All versions cluster from search rank ${(result.parentRank ?? 0) + 1}, cluster rank ${result.pageRank + 1}`,
    );
  } else {
    lines.push(`% Scholar source: search rank ${result.rank + 1}`);
  }

  if (result.authorsLine) lines.push(`% Source: ${result.authorsLine}`);
  if (result.url) lines.push(`% URL: ${result.url}`);

  return `${lines.join("\n")}\n${result.bibtex}`;
}

main().catch((error: unknown) => {
  if (error instanceof ScholarError || error instanceof Error) {
    process.stderr.write(`${error.message}\n`);
  } else {
    process.stderr.write(`${String(error)}\n`);
  }
  process.exit(1);
});
