import * as cheerio from "cheerio";

export interface ScholarOptions {
  hl?: string;
  maxResults?: number;
  exactTitle?: boolean;
  userAgent?: string;
}

export interface ScholarSearchResult {
  rank: number;
  pageRank: number;
  scholarId: string;
  title: string;
  url?: string;
  authorsLine?: string;
  snippet?: string;
  citedBy?: number;
  versions?: number;
  versionsUrl?: string;
  origin: "search" | "versions";
  parentScholarId?: string;
  parentRank?: number;
  sourceType: SourceType;
  archivalScore: number;
  archivalReason: string;
}

export interface ScholarBibtexResult extends ScholarSearchResult {
  bibtex: string;
  bibtexUrl: string;
  citeUrl: string;
}

export class ScholarError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly url?: string,
  ) {
    super(message);
    this.name = "ScholarError";
  }
}

export type SourceType = "archival" | "preprint" | "citation" | "unknown";

const SCHOLAR_BASE = "https://scholar.google.com";
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export async function getScholarBibtex(
  query: string,
  options: ScholarOptions = {},
): Promise<ScholarBibtexResult[]> {
  const requestedResults = normalizeMaxResults(options.maxResults ?? 10);
  const candidateLimit = Math.max(requestedResults * 2, requestedResults + 10);
  const results = await searchScholar(query, { ...options, maxResults: candidateLimit });
  const bibtexResults: ScholarBibtexResult[] = [];
  const recoverableErrors: ScholarError[] = [];

  for (const result of results) {
    if (bibtexResults.length >= requestedResults) break;

    try {
      const citation = await getCitationBibtex(result, options);
      bibtexResults.push({ ...result, ...citation });
    } catch (error) {
      if (!isRecoverableCitationError(error)) throw error;
      recoverableErrors.push(error);
    }
  }

  if (bibtexResults.length === 0) {
    const detail = recoverableErrors[0]?.message ?? "No usable citation export was found.";
    throw new ScholarError(`Unable to retrieve BibTeX from Scholar results. ${detail}`);
  }

  return bibtexResults;
}

export async function searchScholar(
  query: string,
  options: ScholarOptions = {},
): Promise<ScholarSearchResult[]> {
  const normalizedQuery = normalizeQuery(query);
  const maxResults = normalizeMaxResults(options.maxResults ?? 10);
  const searchResults: ScholarSearchResult[] = [];
  let lastSearchUrl: string | undefined;

  for (let start = 0; searchResults.length < maxResults; start += 10) {
    const url = new URL("/scholar", SCHOLAR_BASE);
    url.searchParams.set("q", normalizedQuery);
    url.searchParams.set("hl", options.hl ?? "en");
    url.searchParams.set("as_sdt", "0,3");
    if (start > 0) url.searchParams.set("start", String(start));
    lastSearchUrl = url.toString();

    const html = await fetchText(url, options);
    assertScholarPage(html, url.toString());

    const pageResults = parseScholarResultsPage(html, start, { origin: "search" });
    searchResults.push(...pageResults);
    if (pageResults.length === 0 || !hasNextPage(html)) break;
  }

  const expandedResults = await expandVersionClusters(searchResults, options);
  const orderedResults = orderResults(expandedResults, query, options.exactTitle).slice(0, maxResults);

  if (orderedResults.length === 0) {
    throw new ScholarError(
      "No Scholar results with citation identifiers were found. Google may have changed the page shape or returned an interstitial.",
      undefined,
      lastSearchUrl,
    );
  }

  return orderedResults;
}

async function getCitationBibtex(
  result: ScholarSearchResult,
  options: ScholarOptions,
): Promise<Pick<ScholarBibtexResult, "bibtex" | "bibtexUrl" | "citeUrl">> {
  const citeUrl = new URL("/scholar", SCHOLAR_BASE);
  citeUrl.searchParams.set("q", `info:${result.scholarId}:scholar.google.com/`);
  citeUrl.searchParams.set("output", "cite");
  citeUrl.searchParams.set("scirp", String(result.pageRank));
  citeUrl.searchParams.set("hl", options.hl ?? "en");

  const citationHtml = await fetchText(citeUrl, options);
  assertScholarPage(citationHtml, citeUrl.toString());

  const $ = cheerio.load(citationHtml);
  const bibtexUrl = $("a.gs_citi")
    .filter((_, element) => cleanText($(element).text()).toLowerCase() === "bibtex")
    .first()
    .attr("href");

  if (!bibtexUrl) {
    throw new ScholarError(
      `Scholar did not return a BibTeX link for result "${result.title}".`,
      undefined,
      citeUrl.toString(),
    );
  }

  const normalizedBibtexUrl = normalizeScholarExportUrl(bibtexUrl);
  const bibtex = await fetchText(normalizedBibtexUrl, options);
  if (!bibtex.trim().startsWith("@")) {
    assertScholarPage(bibtex, bibtexUrl);
    throw new ScholarError("The Scholar BibTeX URL did not return a BibTeX record.", undefined, bibtexUrl);
  }

  return {
    bibtex: bibtex.trim(),
    bibtexUrl: normalizedBibtexUrl.toString(),
    citeUrl: citeUrl.toString(),
  };
}

async function fetchText(url: URL | string, options: ScholarOptions): Promise<string> {
  const fixture = getFixtureText(url);
  if (fixture) return fixture;

  const response = await fetch(url, {
    redirect: "follow",
    headers: {
      "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "accept-language": `${options.hl ?? "en"},en-US;q=0.9,en;q=0.8`,
      "user-agent": options.userAgent ?? DEFAULT_USER_AGENT,
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new ScholarError(`Scholar request failed with HTTP ${response.status}.`, response.status, response.url);
  }

  return text;
}

function getFixtureText(urlInput: URL | string): string | undefined {
  if (process.env.BIBTEX_MCP_FIXTURE_MODE !== "internal-stress-test-only") return undefined;

  const url = new URL(urlInput.toString());
  if (url.hostname === "scholar.google.com" && url.pathname === "/scholar" && url.searchParams.get("output") === "cite") {
    const scholarId = extractScholarId(url.searchParams.get("q") ?? "");
    if (!scholarId) return undefined;
    return fixtureCitationPage(scholarId);
  }

  if (url.hostname === "scholar.google.com" && url.pathname === "/scholar") {
    if (url.searchParams.has("cluster")) {
      return fixtureClusterPage(Number(url.searchParams.get("cluster") ?? "0"));
    }

    const start = Number(url.searchParams.get("start") ?? "0");
    return fixtureSearchPage(start);
  }

  if (url.hostname === "scholar.googleusercontent.com" && url.pathname === "/scholar.bib") {
    const scholarId = extractScholarId(url.searchParams.get("q") ?? "");
    if (!scholarId) return undefined;
    return fixtureBibtex(scholarId);
  }

  return undefined;
}

function assertScholarPage(html: string, url: string): void {
  const lower = html.toLowerCase();
  if (
    url.includes("/sorry/") ||
    lower.includes("unusual traffic") ||
    lower.includes("our systems have detected") ||
    lower.includes("recaptcha")
  ) {
    throw new ScholarError(
      "Google Scholar returned an anti-automation interstitial. Open Scholar in a browser and try again later; this tool does not bypass CAPTCHA or access controls.",
      undefined,
      url,
    );
  }
}

function normalizeQuery(query: string): string {
  const trimmed = query.trim();
  if (!trimmed) throw new ScholarError("A paper title or search query is required.");
  return trimmed;
}

function normalizeMaxResults(maxResults: number): number {
  if (!Number.isFinite(maxResults)) return 10;
  return Math.max(1, Math.trunc(maxResults));
}

function cleanText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function parseCountFromLinkText(texts: string[], label: string): number | undefined {
  const found = texts.find((text) => text.includes(label));
  if (!found) return undefined;
  const match = found.replaceAll(",", "").match(/(\d+)/);
  return match ? Number(match[1]) : undefined;
}

async function expandVersionClusters(
  searchResults: ScholarSearchResult[],
  options: ScholarOptions,
): Promise<ScholarSearchResult[]> {
  const byScholarId = new Map<string, ScholarSearchResult>();
  for (const result of searchResults) {
    byScholarId.set(result.scholarId, result);
  }

  const expandableResults = searchResults.filter(
    (result) => result.versionsUrl && result.sourceType !== "archival",
  );

  for (const result of expandableResults) {
    try {
      const html = await fetchText(result.versionsUrl as string, options);
      assertScholarPage(html, result.versionsUrl as string);
      const versionResults = parseScholarResultsPage(html, 0, {
        origin: "versions",
        parentScholarId: result.scholarId,
        parentRank: result.rank,
      });

      for (const version of versionResults) {
        if (!byScholarId.has(version.scholarId)) {
          byScholarId.set(version.scholarId, version);
        }
      }
    } catch (error) {
      if (!isRecoverableCitationError(error)) throw error;
    }
  }

  return [...byScholarId.values()];
}

function parseScholarResultsPage(
  html: string,
  start: number,
  source: Pick<ScholarSearchResult, "origin" | "parentScholarId" | "parentRank">,
): ScholarSearchResult[] {
  const $ = cheerio.load(html);
  const results: ScholarSearchResult[] = [];

  $(".gs_r.gs_or.gs_scl").each((index, element) => {
    const row = $(element);
    const scholarId = row.attr("data-cid")?.trim();
    const hasCiteButton = row.find(".gs_or_cit").length > 0;
    const titleLink = row.find(".gs_rt a").first();
    const rawTitle = cleanText(row.find(".gs_rt").first().text());
    const title = rawTitle.replace(/^(\[[^\]]+\]\s*)+/, "").trim();

    if (!scholarId || !hasCiteButton || !title) return;

    const authorsLine = cleanText(row.find(".gs_a").first().text()) || undefined;
    const url = titleLink.attr("href") || undefined;
    const versionLink = row
      .find(".gs_fl a")
      .toArray()
      .map((a) => ({ text: cleanText($(a).text()), href: $(a).attr("href") }))
      .find((link) => /versions/i.test(link.text));
    const classification = classifySource(rawTitle, authorsLine, url);

    results.push({
      rank: source.parentRank ?? start + index,
      pageRank: index,
      scholarId,
      title,
      url,
      authorsLine,
      snippet: cleanText(row.find(".gs_rs").first().text()) || undefined,
      citedBy: parseCountFromLinkText(row.find(".gs_fl a").toArray().map((a) => $(a).text()), "Cited by"),
      versions: parseCountFromLinkText(row.find(".gs_fl a").toArray().map((a) => $(a).text()), "versions"),
      versionsUrl: versionLink?.href ? new URL(versionLink.href, SCHOLAR_BASE).toString() : undefined,
      origin: source.origin,
      parentScholarId: source.parentScholarId,
      parentRank: source.parentRank,
      sourceType: classification.sourceType,
      archivalScore: classification.archivalScore,
      archivalReason: classification.archivalReason,
    });
  });

  return results;
}

function hasNextPage(html: string): boolean {
  const $ = cheerio.load(html);
  return $("#gs_n td a").toArray().some((link) => cleanText($(link).text()).toLowerCase() === "next");
}

function orderResults(
  results: ScholarSearchResult[],
  query: string,
  exactTitle?: boolean,
): ScholarSearchResult[] {
  const target = normalizeTitle(query);
  return [...results].sort((a, b) => {
    const titleDelta = titleScore(a.title, target) - titleScore(b.title, target);
    if (exactTitle && titleDelta !== 0) return titleDelta;

    const archivalDelta = a.archivalScore - b.archivalScore;
    if (archivalDelta !== 0) return archivalDelta;

    if (!exactTitle && titleDelta !== 0) return titleDelta;
    return a.rank - b.rank;
  });
}

function titleScore(title: string, target: string): number {
  const normalizedTitle = normalizeTitle(title);
  if (normalizedTitle === target) return 0;
  if (normalizedTitle.includes(target)) return 1;
  if (target.includes(normalizedTitle)) return 2;
  return 3;
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\u2010-\u2015]/g, "-")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function isRecoverableCitationError(error: unknown): error is ScholarError {
  if (!(error instanceof ScholarError)) return false;
  return (
    error.status === 404 ||
    error.message.includes("did not return a BibTeX link") ||
    error.message.includes("did not return a BibTeX record")
  );
}

function normalizeScholarExportUrl(href: string): URL {
  const url = new URL(href);
  const query = url.searchParams.get("q");
  if (query?.startsWith("info:")) {
    url.searchParams.set("q", query);
  }
  return url;
}

function extractScholarId(infoQuery: string): string | undefined {
  const match = infoQuery.match(/^info:([^:]+):scholar\.google\.com\/?$/);
  return match?.[1];
}

function fixtureSearchPage(start: number): string {
  const total = 30;
  const rows: string[] = [];
  for (let pageRank = 0; pageRank < 10 && start + pageRank < total; pageRank += 1) {
    const rank = start + pageRank;
    const scholarId = `fixture-${rank}`;
    const venue = `arXiv preprint arXiv:2401.${String(rank).padStart(5, "0")}, 2024 - arxiv.org`;
    const url = `https://arxiv.org/abs/2401.${String(rank).padStart(5, "0")}`;

    rows.push(`
      <div class="gs_r gs_or gs_scl" data-cid="${scholarId}" data-rp="${pageRank}">
        <div class="gs_ri">
          <h3 class="gs_rt"><a href="${url}" id="${scholarId}">Fixture Research Paper</a></h3>
          <div class="gs_a">A Author, B Writer - ${venue}</div>
          <div class="gs_rs">Fixture abstract ${rank}</div>
          <div class="gs_fl">
            <a href="javascript:void(0)" class="gs_or_cit gs_or_btn gs_nph" role="button"><span>Cite</span></a>
            <a href="/scholar?cites=${rank}&hl=en">Cited by ${1000 - rank}</a>
            <a href="/scholar?cluster=${rank}&hl=en">All 2 versions</a>
          </div>
        </div>
      </div>
    `);
  }

  const next = start + 10 < total ? `<div id="gs_n"><table><tr><td><a href="/scholar?start=${start + 10}">Next</a></td></tr></table></div>` : "";
  return `<html><body><div id="gs_res_ccl_mid">${rows.join("\n")}</div>${next}</body></html>`;
}

function fixtureClusterPage(cluster: number): string {
  const archivalId = `fixture-archival-${cluster}`;
  const preprintId = `fixture-${cluster}`;
  return `<html><body><div id="gs_res_ccl_mid">
    <div class="gs_r gs_or gs_scl" data-cid="${archivalId}" data-rp="0">
      <div class="gs_ri">
        <h3 class="gs_rt"><a href="https://proceedings.fixtureconf.org/paper/${cluster}" id="${archivalId}">Fixture Research Paper</a></h3>
        <div class="gs_a">A Author, B Writer - Proceedings of FixtureConf, 2024 - proceedings.fixtureconf.org</div>
        <div class="gs_rs">Archival fixture abstract ${cluster}</div>
        <div class="gs_fl">
          <a href="javascript:void(0)" class="gs_or_cit gs_or_btn gs_nph" role="button"><span>Cite</span></a>
          <a href="/scholar?cites=${cluster}&hl=en">Cited by ${1000 - cluster}</a>
        </div>
      </div>
    </div>
    <div class="gs_r gs_or gs_scl" data-cid="${preprintId}" data-rp="1">
      <div class="gs_ri">
        <h3 class="gs_rt"><a href="https://arxiv.org/abs/2401.${String(cluster).padStart(5, "0")}" id="${preprintId}">Fixture Research Paper</a></h3>
        <div class="gs_a">A Author, B Writer - arXiv preprint arXiv:2401.${String(cluster).padStart(5, "0")}, 2024 - arxiv.org</div>
        <div class="gs_rs">Preprint fixture abstract ${cluster}</div>
        <div class="gs_fl">
          <a href="javascript:void(0)" class="gs_or_cit gs_or_btn gs_nph" role="button"><span>Cite</span></a>
        </div>
      </div>
    </div>
  </div></body></html>`;
}

function fixtureCitationPage(scholarId: string): string {
  return `
    <div id="gs_citt"><table><tr><th class="gs_cith">APA</th><td><div class="gs_citr">Fixture citation.</div></td></tr></table></div>
    <div id="gs_citi">
      <a class="gs_citi" href="https://scholar.googleusercontent.com/scholar.bib?q=info:${scholarId}:scholar.google.com/&amp;output=citation&amp;scisdr=fixture&amp;scisig=fixture&amp;scisf=4&amp;ct=citation&amp;cd=-1&amp;hl=en">BibTeX</a>
    </div>
  `;
}

function fixtureBibtex(scholarId: string): string {
  const archival = scholarId.startsWith("fixture-archival-");
  const rank = Number(scholarId.replace("fixture-archival-", "").replace("fixture-", ""));
  if (archival) {
    return `@inproceedings{fixture${rank},\n  title={Fixture Research Paper},\n  author={Author, Alice and Writer, Bob},\n  booktitle={Proceedings of FixtureConf},\n  year={2024}\n}`;
  }

  return `@article{fixture${rank},\n  title={Fixture Research Paper},\n  author={Author, Alice and Writer, Bob},\n  journal={arXiv preprint arXiv:2401.${String(rank).padStart(5, "0")}},\n  year={2024}\n}`;
}

function classifySource(
  title: string,
  authorsLine: string | undefined,
  url: string | undefined,
): Pick<ScholarSearchResult, "sourceType" | "archivalScore" | "archivalReason"> {
  const haystack = `${title} ${authorsLine ?? ""} ${url ?? ""}`.toLowerCase();

  if (/\[citation\]/i.test(title)) {
    return {
      sourceType: "citation",
      archivalScore: 30,
      archivalReason: "Scholar marks this as a citation-only record.",
    };
  }

  if (matchesAny(haystack, PREPRINT_PATTERNS)) {
    return {
      sourceType: "preprint",
      archivalScore: 80,
      archivalReason: "Looks like a preprint or repository record.",
    };
  }

  if (matchesAny(haystack, ARCHIVAL_PATTERNS)) {
    return {
      sourceType: "archival",
      archivalScore: 0,
      archivalReason: "Looks like a conference, proceedings, journal, or publisher record.",
    };
  }

  return {
    sourceType: "unknown",
    archivalScore: 50,
    archivalReason: "No clear archival or preprint signal was found in the Scholar row.",
  };
}

function matchesAny(value: string, patterns: RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

const PREPRINT_PATTERNS = [
  /\barxiv\b/,
  /\bbiorxiv\b/,
  /\bmedrxiv\b/,
  /\bchemrxiv\b/,
  /\bssrn\b/,
  /\bresearch square\b/,
  /\bpreprint\b/,
];

const ARCHIVAL_PATTERNS = [
  /\bproceedings\b/,
  /\bconference\b/,
  /\bjournal\b/,
  /\btransactions\b/,
  /\bletters\b/,
  /\bneurips\b/,
  /\bnips\b/,
  /\bicml\b/,
  /\biclr\b/,
  /\bnaacl\b/,
  /\bemnlp\b/,
  /\bacl\b/,
  /\baaai\b/,
  /\bijcai\b/,
  /\bcvpr\b/,
  /\biccv\b/,
  /\beccv\b/,
  /\bacm\.org\b/,
  /\bieee\.org\b/,
  /\bspringer\b/,
  /\belsevier\b/,
  /\bwiley\b/,
  /\btaylorfrancis\b/,
  /\boxford academic\b/,
  /\baclanthology\.org\b/,
  /\bproceedings\.neurips\.cc\b/,
  /\bnature\.com\b/,
  /\bscience\.org\b/,
  /\bcell\.com\b/,
];
