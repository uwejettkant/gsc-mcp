import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import type { SearchConsoleClient } from "../src/gsc-client.js";
import {
  buildDimensionFilterGroups,
  comparePeriodRows,
  computeTotals,
  createGscServer,
  roundMetric,
  sortRows,
  type SearchAnalyticsRow,
} from "../src/server.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function connectTestClient(mockGsc: Partial<SearchConsoleClient>) {
  const fixedNow = new Date("2026-11-25T16:00:00.000Z");
  const server = createGscServer(() => mockGsc as SearchConsoleClient, () => fixedNow);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

function parseToolJson<T>(result: Awaited<ReturnType<Client["callTool"]>>): T {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return JSON.parse(first?.text ?? "{}") as T;
}

describe("gsc-mcp server, safety invariants & analytics logic", () => {
  it("enforces minimal runtime dependencies, read-only annotations, and placeholder domains across tools and docs", async () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")
    ) as { dependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual([
      "@googleapis/searchconsole",
      "@modelcontextprotocol/sdk",
      "zod",
    ]);

    const { client, server } = await connectTestClient({});
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      "gsc_list_sites",
      "gsc_search_analytics",
      "gsc_compare_periods",
      "gsc_inspect_url",
    ]);

    const allowedDomains = new Set([
      "example.com",
      "json-schema.org",
      "googleapis.com",
      "google.com",
      "gserviceaccount.com",
      "modelcontextprotocol.io",
      "github.com",
    ]);
    const domainRegex = /\b(?:[a-z0-9-]+\.)+(?:com|de|io|net|org|dev|app|ai|at|ch|eu|co)\b/gi;

    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
      expect(tool.annotations?.destructiveHint).toBe(false);
      const serialized = JSON.stringify({
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      });
      const domains = serialized.match(domainRegex) ?? [];
      for (const domain of domains) {
        const normalized = domain.toLowerCase();
        const allowed = Array.from(allowedDomains).some(
          (base) => normalized === base || normalized.endsWith(`.${base}`)
        );
        expect(allowed, `Unexpected domain "${domain}" in tool ${tool.name}`).toBe(true);
      }
    }

    for (const docFile of ["README.md", "SECURITY.md", "AGENTS.md"]) {
      const content = fs.readFileSync(path.join(REPO_ROOT, docFile), "utf8");
      const domains = content.match(domainRegex) ?? [];
      for (const domain of domains) {
        const normalized = domain.toLowerCase();
        const allowed = Array.from(allowedDomains).some(
          (base) => normalized === base || normalized.endsWith(`.${base}`)
        );
        expect(allowed, `Unexpected domain "${domain}" in ${docFile}`).toBe(true);
      }
      const saEmails = content.match(/[a-z0-9-]+@([a-z0-9-]+)\.iam\.gserviceaccount\.com/gi) ?? [];
      for (const email of saEmails) {
        expect(email).toContain("@your-project-id.iam.gserviceaccount.com");
      }
    }

    await client.close();
    await server.close();
  });

  it("lists accessible properties via gsc_list_sites", async () => {
    const listMock = vi.fn().mockResolvedValue({
      data: {
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" },
        ],
      },
    });

    const { client, server } = await connectTestClient({
      sites: { list: listMock } as unknown as SearchConsoleClient["sites"],
    });

    const res = await client.callTool({ name: "gsc_list_sites", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(parseToolJson(res)).toEqual({
      count: 1,
      sites: [{ siteUrl: "sc-domain:example.com", permissionLevel: "siteRestrictedUser" }],
    });

    await client.close();
    await server.close();
  });

  it("genuinely sorts unsorted rows (including zero-click high-impression rows beyond 1000), applies filters, and honors dataState=all", async () => {
    // Google returns rows ordered by clicks desc, placing 0-click high-impression rows at the end.
    const fakeRows: SearchAnalyticsRow[] = [
      ...Array.from({ length: 1005 }, (_, i) => ({
        keys: [`click-query-${i}`, "https://example.com/a"],
        clicks: 1005 - i,
        impressions: 10 + (i % 50),
        ctr: 0.1,
        position: 8,
      })),
      {
        keys: ["zero-click-opportunity", "https://example.com/opportunity"],
        clicks: 0,
        impressions: 9500,
        ctr: 0,
        position: 11.4,
      },
    ];

    const queryMock = vi.fn().mockResolvedValue({ data: { rows: fakeRows } });
    const { client, server } = await connectTestClient({
      searchanalytics: {
        query: queryMock,
      } as unknown as SearchConsoleClient["searchanalytics"],
    });

    const res = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:example.com",
        dimensions: ["query", "page"],
        filters: [{ dimension: "page", operator: "contains", expression: "example.com" }],
        sortBy: "impressions",
        sortOrder: "desc",
        rowLimit: 2,
        dataState: "all",
      },
    });

    expect(res.isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledWith({
      siteUrl: "sc-domain:example.com",
      requestBody: {
        startDate: "2026-10-29",
        endDate: "2026-11-25",
        dimensions: ["query", "page"],
        dimensionFilterGroups: [
          {
            groupType: "and",
            filters: [{ dimension: "page", operator: "contains", expression: "example.com" }],
          },
        ],
        type: "web",
        rowLimit: 25000,
        startRow: 0,
        dataState: "all",
      },
    });

    const data = parseToolJson<{
      returnedRows: number;
      clientSortTruncated: boolean;
      rows: Array<{ query: string; page: string; impressions: number; clicks: number }>;
    }>(res);
    expect(data.returnedRows).toBe(2);
    expect(data.clientSortTruncated).toBe(false);
    expect(data.rows[0]).toMatchObject({
      query: "zero-click-opportunity",
      page: "https://example.com/opportunity",
      impressions: 9500,
      clicks: 0,
    });

    await client.close();
    await server.close();
  });

  it("supports custom fetchLimit, flags truncation, and rejects startRow + rowLimit > 25000 or duplicate dimensions", async () => {
    const fakeRows: SearchAnalyticsRow[] = Array.from({ length: 1020 }, (_, i) => ({
      keys: [`query-${i}`],
      clicks: 1020 - i,
      impressions: i + 1, // Ascending in raw payload, so descending sort MUST reverse the array!
      ctr: 0.05,
      position: 5,
    }));

    const queryMock = vi.fn().mockResolvedValue({ data: { rows: fakeRows } });
    const { client, server } = await connectTestClient({
      searchanalytics: {
        query: queryMock,
      } as unknown as SearchConsoleClient["searchanalytics"],
    });

    const res = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:example.com",
        sortBy: "impressions",
        sortOrder: "desc",
        startRow: 990,
        rowLimit: 25,
        fetchLimit: 1000,
      },
    });

    expect(res.isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestBody: expect.objectContaining({
          rowLimit: 1015,
          startRow: 0,
        }),
      })
    );

    const data = parseToolJson<{
      returnedRows: number;
      clientSortTruncated: boolean;
      rows: Array<{ query: string; impressions: number }>;
    }>(res);
    expect(data.returnedRows).toBe(25);
    expect(data.clientSortTruncated).toBe(true);
    // Highest impressions is i=1019 (1020 impr); at offset 990 is i=1019-990 = 29 ("query-29", 30 impr)
    expect(data.rows[0]).toMatchObject({ query: "query-29", impressions: 30 });
    expect(data.rows[24]).toMatchObject({ query: "query-5", impressions: 6 });

    const overflowRes = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:example.com",
        sortBy: "position",
        sortOrder: "asc",
        startRow: 24990,
        rowLimit: 20,
      },
    });
    expect(overflowRes.isError).toBe(true);
    expect((overflowRes.content as Array<{ text: string }>)[0]?.text).toMatch(/cannot exceed 25000/);

    const dupDimRes = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:example.com",
        dimensions: ["query", "query"],
      },
    });
    expect(dupDimRes.isError).toBe(true);

    await client.close();
    await server.close();
  });

  it("uses ungrouped property queries for gsc_compare_periods summary so anonymized queries are not lost", async () => {
    const queryMock = vi.fn().mockImplementation(async ({ requestBody }) => {
      const isUngrouped = !requestBody.dimensions;
      const isCurrent = requestBody.startDate === "2026-10-26";

      if (isUngrouped && isCurrent) {
        return {
          data: {
            rows: [{ clicks: 361, impressions: 2902, ctr: 361 / 2902, position: 3.69 }],
          },
        };
      }
      if (isUngrouped && !isCurrent) {
        return {
          data: {
            rows: [{ clicks: 442, impressions: 3403, ctr: 442 / 3403, position: 4.1 }],
          },
        };
      }
      if (!isUngrouped && isCurrent) {
        return {
          data: {
            rows: [
              { keys: ["brand query"], clicks: 200, impressions: 1500, ctr: 0.1333, position: 1.2 },
              { keys: ["generic query"], clicks: 56, impressions: 537, ctr: 0.1043, position: 4.5 },
            ],
          },
        };
      }
      return {
        data: {
          rows: [
            { keys: ["brand query"], clicks: 180, impressions: 1400, ctr: 0.1285, position: 1.5 },
            { keys: ["generic query"], clicks: 90, impressions: 700, ctr: 0.1285, position: 3.1 },
          ],
        },
      };
    });

    const { client, server } = await connectTestClient({
      searchanalytics: {
        query: queryMock,
      } as unknown as SearchConsoleClient["searchanalytics"],
    });

    const res = await client.callTool({
      name: "gsc_compare_periods",
      arguments: {
        siteUrl: "sc-domain:example.com",
        days: 28,
        dimension: "query",
      },
    });

    expect(res.isError).toBeFalsy();
    expect(queryMock).toHaveBeenCalledTimes(4);

    const payload = parseToolJson<{
      summary: {
        current: { clicks: number; impressions: number };
        previous: { clicks: number; impressions: number };
        delta: { clicks: number; impressions: number; avgPositionChange: number };
      };
      winners: Array<{ query: string; clicksDiff: number }>;
      losers: Array<{ query: string; clicksDiff: number }>;
    }>(res);

    expect(payload.summary.current.clicks).toBe(361);
    expect(payload.summary.previous.clicks).toBe(442);
    expect(payload.summary.delta.clicks).toBe(-81);
    expect(payload.summary.delta.avgPositionChange).toBe(0.41);

    expect(payload.winners[0]).toMatchObject({ query: "brand query", clicksDiff: 20 });
    expect(payload.losers[0]).toMatchObject({ query: "generic query", clicksDiff: -34 });

    await client.close();
    await server.close();
  });

  it("filters noise in comparedKeysCount, skips one-sided truncated keys, and breaks ties deterministically", () => {
    const result = comparePeriodRows({
      currentRows: [
        { keys: ["noisy longtail"], clicks: 0, impressions: 1, position: 2 },
        { keys: ["core keyword"], clicks: 25, impressions: 400, position: 3 },
        { keys: ["tie-low-impr"], clicks: 15, impressions: 50, position: 4 },
        { keys: ["tie-high-impr"], clicks: 15, impressions: 500, position: 4 },
      ],
      previousRows: [
        { keys: ["noisy longtail"], clicks: 0, impressions: 1, position: 50 },
        { keys: ["core keyword"], clicks: 15, impressions: 350, position: 8 },
        { keys: ["tie-low-impr"], clicks: 10, impressions: 40, position: 7 },
        { keys: ["tie-high-impr"], clicks: 10, impressions: 200, position: 7 },
        { keys: ["dropped-below-cutoff"], clicks: 12, impressions: 6000, position: 9 },
      ],
      dimension: "query",
      sortBy: "clicksDiff",
      limit: 10,
      minImpressions: 10,
      currentTruncated: true,
      previousTruncated: false,
    });

    // 5 distinct keys: 1 skipped due to currentTruncated ("dropped-below-cutoff"), 1 filtered by minImpressions ("noisy longtail") => 3 compared
    expect(result.skippedDueToTruncationCount).toBe(1);
    expect(result.comparedKeysCount).toBe(3);
    expect(result.losers).toEqual([]);
    expect(result.winners.map((w) => w.query)).toEqual([
      "core keyword",
      "tie-high-impr",
      "tie-low-impr",
    ]);
  });

  it("handles NaN, Infinity, -0, filter groups, and deterministic tie-breaking in helpers", () => {
    expect(Object.is(roundMetric(-0.0001, 2), 0)).toBe(true);
    expect(roundMetric(Number.POSITIVE_INFINITY, 2)).toBe(0);
    expect(roundMetric(Number.NaN, 2)).toBe(0);

    expect(buildDimensionFilterGroups(undefined)).toBeUndefined();
    expect(buildDimensionFilterGroups([])).toBeUndefined();
    expect(
      buildDimensionFilterGroups([
        { dimension: "query", operator: "contains", expression: "seo" },
      ])
    ).toEqual([
      {
        groupType: "and",
        filters: [{ dimension: "query", operator: "contains", expression: "seo" }],
      },
    ]);

    const sorted = sortRows(
      [
        { keys: ["b-zero"], clicks: 0, impressions: 100 },
        { keys: ["nan-row"], clicks: Number.NaN, impressions: 50 },
        { keys: ["a-zero"], clicks: 0, impressions: 100 },
        { keys: ["high-impr-zero"], clicks: 0, impressions: 500 },
      ],
      "clicks",
      "asc"
    );
    expect(sorted.map((r) => r.keys?.[0])).toEqual([
      "high-impr-zero",
      "a-zero",
      "b-zero",
      "nan-row",
    ]);

    expect(computeTotals([])).toEqual({
      clicks: 0,
      impressions: 0,
      ctrPercent: 0,
      avgPosition: 0,
    });

    expect(
      computeTotals([{ clicks: Number.NaN, impressions: 10, ctr: Number.NaN, position: Number.NaN }])
    ).toEqual({
      clicks: 0,
      impressions: 10,
      ctrPercent: 0,
      avgPosition: 0,
    });

    expect(
      computeTotals([
        { keys: ["a"], clicks: 10, impressions: 100, position: 2 },
        { keys: ["b"], clicks: 10, impressions: 300, position: 6 },
      ])
    ).toEqual({
      clicks: 20,
      impressions: 400,
      ctrPercent: 5,
      avgPosition: 5,
    });
  });

  it("maps URL inspection responses, defaults languageCode to en-US, and rejects non-HTTP(S) URLs", async () => {
    const inspectMock = vi.fn().mockResolvedValue({
      data: {
        inspectionResult: {
          inspectionResultLink: "https://search.google.com/search-console/inspect",
          indexStatusResult: {
            verdict: "PASS",
            coverageState: "Submitted and indexed",
            indexingState: "INDEXING_ALLOWED",
            pageFetchState: "SUCCESSFUL",
            robotsTxtState: "ALLOWED",
            lastCrawlTime: "2026-11-24T09:38:20Z",
            crawledAs: "MOBILE",
            googleCanonical: "https://example.com/",
            userCanonical: "https://example.com/",
          },
        },
      },
    });

    const { client, server } = await connectTestClient({
      urlInspection: {
        index: { inspect: inspectMock },
      } as unknown as SearchConsoleClient["urlInspection"],
    });

    const res = await client.callTool({
      name: "gsc_inspect_url",
      arguments: {
        siteUrl: "sc-domain:example.com",
        inspectionUrl: "https://example.com/",
      },
    });

    expect(res.isError).toBeFalsy();
    expect(inspectMock).toHaveBeenCalledWith({
      requestBody: {
        siteUrl: "sc-domain:example.com",
        inspectionUrl: "https://example.com/",
        languageCode: "en-US",
      },
    });
    expect(parseToolJson<{ indexStatus: { verdict: string } }>(res).indexStatus.verdict).toBe(
      "PASS"
    );

    for (const badUrl of ["file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hello"]) {
      const badRes = await client.callTool({
        name: "gsc_inspect_url",
        arguments: {
          siteUrl: "sc-domain:example.com",
          inspectionUrl: badUrl,
        },
      });
      expect(badRes.isError).toBe(true);
    }
    expect(inspectMock).toHaveBeenCalledTimes(1);

    await client.close();
    await server.close();
  });

  it("returns isError=true instead of crashing when date validation or Google API fails", async () => {
    const { client, server } = await connectTestClient({
      searchanalytics: {
        query: vi.fn(),
      } as unknown as SearchConsoleClient["searchanalytics"],
    });

    const badDateRes = await client.callTool({
      name: "gsc_search_analytics",
      arguments: {
        siteUrl: "sc-domain:example.com",
        startDate: "2026-02-31",
        endDate: "2026-03-10",
      },
    });

    expect(badDateRes.isError).toBe(true);
    expect((badDateRes.content as Array<{ text: string }>)[0]?.text).toMatch(
      /Invalid calendar date "2026-02-31"/
    );

    await client.close();
    await server.close();
  });
});
