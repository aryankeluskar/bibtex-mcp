#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getScholarBibtex, ScholarError } from "./scholar.js";

const server = new McpServer({
  name: "bibtex-mcp",
  version: "0.1.0",
});

server.registerTool(
  "google_scholar_bibtex",
  {
    title: "Google Scholar BibTeX",
    description:
      "Search Google Scholar for a paper title and return multiple BibTeX options from Scholar's citation export flow, ranked to prefer archival conference/journal records over preprints. Does not bypass CAPTCHA or access controls.",
    inputSchema: {
      query: z.string().min(1).describe("Paper title or Scholar search query."),
      maxResults: z.number().int().min(1).default(10).describe("Number of Scholar options to return."),
      exactTitle: z.boolean().default(false).describe("Prefer exact title matches before archival ranking."),
    },
  },
  async ({ query, maxResults, exactTitle }) => {
    try {
      const results = await getScholarBibtex(query, { maxResults, exactTitle });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ query, results }, null, 2),
          },
        ],
      };
    } catch (error) {
      if (error instanceof ScholarError) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: error.message,
            },
          ],
        };
      }

      throw error;
    }
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error: unknown) => {
  process.stderr.write(error instanceof Error ? `${error.message}\n` : `${String(error)}\n`);
  process.exit(1);
});
