import fs from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { searchconsole_v1 } from "@googleapis/searchconsole";
import { z } from "zod";
import { resolveAnalyticsDateRange, resolveComparisonRanges } from "./date-utils.js";
import {
  formatGscError,
  getSearchConsoleClient,
  type SearchConsoleClient,
} from "./gsc-client.js";

const DimensionEnum = z.enum(["query", "page", "country", "device", "searchAppearance", "date"]);
const ComparisonDimensionEnum = z.enum(["query", "page", "country", "device"]);
const FilterOperatorEnum = z.enum([
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
]);
const SearchTypeEnum = z.enum(["web", "image", "video", "news", "discover", "googleNews"]);
const SortByEnum = z.enum(["clicks", "impressions", "ctr", "position"]);
const SortOrderEnum = z.enum(["desc", "asc"]);
const ComparisonSortByEnum = z.enum(["clicksDiff", "impressionsDiff", "positionDiff"]);

export const FilterSchema = z.object({
  dimension: z.enum(["query", "page", "country", "device", "searchAppearance"]),
  operator: FilterOperatorEnum.default("contains"),
  expression: z.string().min(1),
});

export type SearchAnalyticsRow = searchconsole_v1.Schema$ApiDataRow;
export type DimensionFilter = z.infer<typeof FilterSchema>;

function readPackageVersion(): string {
  try {
    const pkgUrl = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(fs.readFileSync(pkgUrl, "utf8")) as { version?: string };
    return pkg.version ?? "1.0.0";
  } catch {
    return "1.0.0";
  }
}

function finiteOrZero(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function buildDimensionFilterGroups(
  filters?: DimensionFilter[]
): searchconsole_v1.Schema$ApiDimensionFilterGroup[] | undefined {
  if (!filters || filters.length === 0) {
    return undefined;
  }
  return [
    {
      groupType: "and",
      filters: filters.map((f) => ({
        dimension: f.dimension,
        operator: f.operator,
        expression: f.expression,
      })),
    },
  ];
}

export function roundMetric(value: number | null | undefined, decimals = 2): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatRow(row: SearchAnalyticsRow, dimensions: string[]) {
  const keys = row.keys ?? [];
  const dimensionMap: Record<string, string> = {};
  dimensions.forEach((dim, idx) => {
    dimensionMap[dim] = keys[idx] ?? "";
  });

  return {
    ...dimensionMap,
    clicks: finiteOrZero(row.clicks),
    impressions: finiteOrZero(row.impressions),
    ctrPercent: roundMetric(finiteOrZero(row.ctr) * 100, 2),
    position: roundMetric(finiteOrZero(row.position), 2),
  };
}

export function sortRows(
  rows: SearchAnalyticsRow[],
  sortBy: z.infer<typeof SortByEnum>,
  sortOrder: z.infer<typeof SortOrderEnum>
): SearchAnalyticsRow[] {
  const direction = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const valA = finiteOrZero(a[sortBy]);
    const valB = finiteOrZero(b[sortBy]);
    const primary = (valA - valB) * direction;
    if (primary !== 0) {
      return primary;
    }

    const imprDiff = finiteOrZero(b.impressions) - finiteOrZero(a.impressions);
    if (imprDiff !== 0) {
      return imprDiff;
    }

    const clicksDiff = finiteOrZero(b.clicks) - finiteOrZero(a.clicks);
    if (clicksDiff !== 0) {
      return clicksDiff;
    }

    const keyA = (a.keys ?? []).join("\0");
    const keyB = (b.keys ?? []).join("\0");
    return keyA.localeCompare(keyB);
  });
}

export interface PeriodTotals {
  clicks: number;
  impressions: number;
  ctrPercent: number;
  avgPosition: number;
}

/**
 * Computes aggregate metrics across Search Analytics rows.
 * Note: For true property-wide totals in `gsc_compare_periods`, pass the response
 * of an ungrouped query (`dimensions` omitted) so anonymized queries and row limits
 * do not undercount clicks and impressions.
 */
export function computeTotals(rows: SearchAnalyticsRow[]): PeriodTotals {
  if (rows.length === 1 && (!rows[0].keys || rows[0].keys.length === 0)) {
    const single = rows[0];
    const clicks = finiteOrZero(single.clicks);
    const impressions = finiteOrZero(single.impressions);
    const rawCtr = finiteOrNull(single.ctr);
    const rawPosition = finiteOrZero(single.position);
    const ctr = rawCtr !== null ? rawCtr : impressions > 0 ? clicks / impressions : 0;
    return {
      clicks,
      impressions,
      ctrPercent: roundMetric(ctr * 100, 2),
      avgPosition: impressions > 0 || rawPosition > 0 ? roundMetric(rawPosition, 2) : 0,
    };
  }

  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;

  for (const row of rows) {
    const rowClicks = finiteOrZero(row.clicks);
    const rowImpressions = finiteOrZero(row.impressions);
    const rowPos = finiteOrZero(row.position);
    clicks += rowClicks;
    impressions += rowImpressions;
    weightedPosition += rowPos * rowImpressions;
  }

  return {
    clicks,
    impressions,
    ctrPercent: impressions > 0 ? roundMetric((clicks / impressions) * 100, 2) : 0,
    avgPosition: impressions > 0 ? roundMetric(weightedPosition / impressions, 2) : 0,
  };
}

export function comparePeriodRows(params: {
  currentRows: SearchAnalyticsRow[];
  previousRows: SearchAnalyticsRow[];
  dimension: z.infer<typeof ComparisonDimensionEnum>;
  sortBy: z.infer<typeof ComparisonSortByEnum>;
  limit: number;
  minImpressions?: number;
  currentTruncated?: boolean;
  previousTruncated?: boolean;
}) {
  const minImpressions = params.minImpressions ?? 0;
  const currentTruncated = params.currentTruncated ?? false;
  const previousTruncated = params.previousTruncated ?? false;

  const currentMap = new Map<string, SearchAnalyticsRow>();
  for (const row of params.currentRows) {
    const key = row.keys?.[0];
    if (key !== undefined && !currentMap.has(key)) {
      currentMap.set(key, row);
    }
  }

  const previousMap = new Map<string, SearchAnalyticsRow>();
  for (const row of params.previousRows) {
    const key = row.keys?.[0];
    if (key !== undefined && !previousMap.has(key)) {
      previousMap.set(key, row);
    }
  }

  const allKeys = new Set([...currentMap.keys(), ...previousMap.keys()]);
  let skippedDueToTruncationCount = 0;

  interface ComparisonEntry {
    key: string;
    currentClicks: number;
    previousClicks: number;
    clicksDiff: number;
    currentImpressions: number;
    previousImpressions: number;
    impressionsDiff: number;
    currentPosition: number | null;
    previousPosition: number | null;
    positionDiff: number | null;
  }

  const comparisons: ComparisonEntry[] = [];

  for (const key of allKeys) {
    const cur = currentMap.get(key);
    const prev = previousMap.get(key);

    // When one period hit `fetchLimit`, a key missing from that period may simply
    // have fallen below the click-sorted fetch cutoff rather than dropping to 0.
    if ((cur === undefined && currentTruncated) || (prev === undefined && previousTruncated)) {
      skippedDueToTruncationCount += 1;
      continue;
    }

    const curClicks = finiteOrZero(cur?.clicks);
    const prevClicks = finiteOrZero(prev?.clicks);
    const curImpr = finiteOrZero(cur?.impressions);
    const prevImpr = finiteOrZero(prev?.impressions);
    const curPos = finiteOrNull(cur?.position);
    const prevPos = finiteOrNull(prev?.position);

    if (curImpr + prevImpr < minImpressions) {
      continue;
    }

    // Positive positionDiff means ranking improved (e.g., pos 10 -> pos 4 => +6).
    const positionDiff =
      curPos !== null && prevPos !== null ? roundMetric(prevPos - curPos, 2) : null;

    comparisons.push({
      key,
      currentClicks: curClicks,
      previousClicks: prevClicks,
      clicksDiff: curClicks - prevClicks,
      currentImpressions: curImpr,
      previousImpressions: prevImpr,
      impressionsDiff: curImpr - prevImpr,
      currentPosition: curPos !== null ? roundMetric(curPos, 2) : null,
      previousPosition: prevPos !== null ? roundMetric(prevPos, 2) : null,
      positionDiff,
    });
  }

  const getSortVal = (item: ComparisonEntry) => {
    if (params.sortBy === "positionDiff") return item.positionDiff ?? 0;
    return item[params.sortBy];
  };

  const tieBreak = (a: ComparisonEntry, b: ComparisonEntry) => {
    const absImpr = Math.abs(b.impressionsDiff) - Math.abs(a.impressionsDiff);
    if (absImpr !== 0) return absImpr;

    const totalImpr =
      b.currentImpressions +
      b.previousImpressions -
      (a.currentImpressions + a.previousImpressions);
    if (totalImpr !== 0) return totalImpr;

    return a.key.localeCompare(b.key);
  };

  const toPublicItem = (item: ComparisonEntry) => ({
    [params.dimension]: item.key,
    currentClicks: item.currentClicks,
    previousClicks: item.previousClicks,
    clicksDiff: item.clicksDiff,
    currentImpressions: item.currentImpressions,
    previousImpressions: item.previousImpressions,
    impressionsDiff: item.impressionsDiff,
    currentPosition: item.currentPosition,
    previousPosition: item.previousPosition,
    positionDiff: item.positionDiff,
  });

  const winners = [...comparisons]
    .filter((item) => getSortVal(item) > 0)
    .sort((a, b) => getSortVal(b) - getSortVal(a) || tieBreak(a, b))
    .slice(0, params.limit)
    .map(toPublicItem);

  const losers = [...comparisons]
    .filter((item) => getSortVal(item) < 0)
    .sort((a, b) => getSortVal(a) - getSortVal(b) || tieBreak(a, b))
    .slice(0, params.limit)
    .map(toPublicItem);

  return {
    comparedKeysCount: comparisons.length,
    skippedDueToTruncationCount,
    winners,
    losers,
  };
}

function jsonResult(data: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function errorResult(error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: formatGscError(error),
      },
    ],
  };
}

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
} as const;

export function createGscServer(
  clientProvider: () => SearchConsoleClient = getSearchConsoleClient,
  nowProvider: () => Date = () => new Date()
): McpServer {
  const server = new McpServer({
    name: "gsc-mcp",
    version: readPackageVersion(),
  });

  server.registerTool(
    "gsc_list_sites",
    {
      title: "List Search Console Properties",
      description:
        "Lists all Google Search Console properties accessible to the configured read-only service account.",
      inputSchema: {},
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async () => {
      try {
        const client = clientProvider();
        const res = await client.sites.list();
        const sites = (res.data.siteEntry ?? []).map((entry) => ({
          siteUrl: entry.siteUrl ?? "",
          permissionLevel: entry.permissionLevel ?? "",
        }));
        return jsonResult({ count: sites.length, sites });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "gsc_search_analytics",
    {
      title: "Query Search Analytics",
      description:
        "Queries Google Search Console performance data (clicks, impressions, CTR, position) by dimensions such as query, page, country, device, searchAppearance, or date.",
      inputSchema: {
        siteUrl: z
          .string()
          .min(1)
          .describe('Property URL, e.g. "sc-domain:example.com" or "https://example.com/".'),
        startDate: z
          .string()
          .optional()
          .describe("Start date in YYYY-MM-DD format. Defaults to 28 days ending at endDate."),
        endDate: z
          .string()
          .optional()
          .describe(
            'End date in YYYY-MM-DD format. Defaults to today minus 3 days (or today when dataState is "all").'
          ),
        dimensions: z
          .array(DimensionEnum)
          .min(1)
          .max(3)
          .refine((dims) => new Set(dims).size === dims.length, {
            message: "dimensions must not contain duplicate entries.",
          })
          .default(["query"])
          .describe("Unique dimensions to group by (query, page, country, device, searchAppearance, date)."),
        filters: z.array(FilterSchema).optional().describe("Optional AND-combined dimension filters."),
        searchType: SearchTypeEnum.default("web").describe("Search type (default: web)."),
        rowLimit: z.number().int().min(1).max(25000).default(25).describe("Max rows to return (1-25000)."),
        startRow: z.number().int().min(0).default(0).describe("Zero-based offset for pagination."),
        fetchLimit: z
          .number()
          .int()
          .min(100)
          .max(25000)
          .default(25000)
          .describe(
            "Max raw rows fetched from Google before client-side sorting (default: 25000, the API maximum, so zero-click high-impression rows are included)."
          ),
        sortBy: SortByEnum.default("clicks").describe("Metric to sort by (clicks, impressions, ctr, position)."),
        sortOrder: SortOrderEnum.default("desc").describe("Sort direction (desc or asc)."),
        dataState: z.enum(["all", "final"]).optional().describe('Set "all" to include fresh/unfinalized data.'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const client = clientProvider();
        const { startDate, endDate } = resolveAnalyticsDateRange({
          startDate: args.startDate,
          endDate: args.endDate,
          days: 28,
          lagDays: args.dataState === "all" ? 0 : undefined,
          now: nowProvider(),
        });

        const needsClientSort = args.sortBy !== "clicks" || args.sortOrder !== "desc";
        if (needsClientSort && args.startRow + args.rowLimit > 25000) {
          throw new Error(
            "startRow + rowLimit cannot exceed 25000 when sorting by impressions, ctr, position, or ascending order."
          );
        }
        const fetchRowLimit = needsClientSort
          ? Math.min(Math.max(args.startRow + args.rowLimit, args.fetchLimit), 25000)
          : args.rowLimit;

        const res = await client.searchanalytics.query({
          siteUrl: args.siteUrl,
          requestBody: {
            startDate,
            endDate,
            dimensions: args.dimensions,
            dimensionFilterGroups: buildDimensionFilterGroups(args.filters),
            type: args.searchType,
            rowLimit: fetchRowLimit,
            startRow: needsClientSort ? 0 : args.startRow,
            dataState: args.dataState,
          },
        });

        const rawRows = res.data.rows ?? [];
        const orderedRows = needsClientSort
          ? sortRows(rawRows, args.sortBy, args.sortOrder).slice(
              args.startRow,
              args.startRow + args.rowLimit
            )
          : rawRows;

        return jsonResult({
          siteUrl: args.siteUrl,
          startDate,
          endDate,
          searchType: args.searchType,
          dimensions: args.dimensions,
          sortBy: args.sortBy,
          sortOrder: args.sortOrder,
          ...(needsClientSort
            ? { clientSortTruncated: rawRows.length >= fetchRowLimit }
            : {}),
          returnedRows: orderedRows.length,
          rows: orderedRows.map((row) => formatRow(row, args.dimensions)),
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "gsc_compare_periods",
    {
      title: "Compare Two Search Analytics Periods",
      description:
        "Compares two equal-length date ranges (e.g., last 28 or 90 days vs. the previous period) to identify true property-wide totals as well as top dimension winners and losers.",
      inputSchema: {
        siteUrl: z
          .string()
          .min(1)
          .describe('Property URL, e.g. "sc-domain:example.com" or "https://example.com/".'),
        days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Number of days per period when explicit dates are omitted (default: 28, e.g. 28 or 90)."),
        currentStartDate: z.string().optional().describe("Optional explicit current start date (YYYY-MM-DD)."),
        currentEndDate: z.string().optional().describe("Optional explicit current end date (YYYY-MM-DD)."),
        previousStartDate: z.string().optional().describe("Optional explicit previous start date (YYYY-MM-DD)."),
        previousEndDate: z.string().optional().describe("Optional explicit previous end date (YYYY-MM-DD)."),
        dimension: ComparisonDimensionEnum.default("query").describe(
          "Dimension to compare (query, page, country, or device)."
        ),
        filters: z.array(FilterSchema).optional().describe("Optional AND-combined dimension filters."),
        searchType: SearchTypeEnum.default("web").describe("Search type (default: web)."),
        limit: z.number().int().min(1).max(200).default(20).describe("Number of winners and losers to return."),
        fetchLimit: z
          .number()
          .int()
          .min(100)
          .max(25000)
          .default(5000)
          .describe("Max dimension rows fetched per period for winner/loser comparison (default: 5000, max: 25000)."),
        minImpressions: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe(
            "Minimum combined impressions (current + previous) required for winners/losers (filters single-impression noise)."
          ),
        sortBy: ComparisonSortByEnum.default("clicksDiff").describe(
          "Metric delta used to rank winners and losers."
        ),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const client = clientProvider();
        const ranges = resolveComparisonRanges({
          days: args.days,
          currentStartDate: args.currentStartDate,
          currentEndDate: args.currentEndDate,
          previousStartDate: args.previousStartDate,
          previousEndDate: args.previousEndDate,
          now: nowProvider(),
        });

        const filterGroups = buildDimensionFilterGroups(args.filters);

        // Query ungrouped totals alongside dimension breakdowns so Google's privacy
        // thresholding on `query` rows and `fetchLimit` never undercount site totals.
        const [currentDimRes, previousDimRes, currentTotalRes, previousTotalRes] = await Promise.all([
          client.searchanalytics.query({
            siteUrl: args.siteUrl,
            requestBody: {
              startDate: ranges.currentStartDate,
              endDate: ranges.currentEndDate,
              dimensions: [args.dimension],
              dimensionFilterGroups: filterGroups,
              type: args.searchType,
              rowLimit: args.fetchLimit,
            },
          }),
          client.searchanalytics.query({
            siteUrl: args.siteUrl,
            requestBody: {
              startDate: ranges.previousStartDate,
              endDate: ranges.previousEndDate,
              dimensions: [args.dimension],
              dimensionFilterGroups: filterGroups,
              type: args.searchType,
              rowLimit: args.fetchLimit,
            },
          }),
          client.searchanalytics.query({
            siteUrl: args.siteUrl,
            requestBody: {
              startDate: ranges.currentStartDate,
              endDate: ranges.currentEndDate,
              dimensionFilterGroups: filterGroups,
              type: args.searchType,
              rowLimit: 1,
            },
          }),
          client.searchanalytics.query({
            siteUrl: args.siteUrl,
            requestBody: {
              startDate: ranges.previousStartDate,
              endDate: ranges.previousEndDate,
              dimensionFilterGroups: filterGroups,
              type: args.searchType,
              rowLimit: 1,
            },
          }),
        ]);

        const currentRows = currentDimRes.data.rows ?? [];
        const previousRows = previousDimRes.data.rows ?? [];
        const currentTotals = computeTotals(currentTotalRes.data.rows ?? []);
        const previousTotals = computeTotals(previousTotalRes.data.rows ?? []);
        const currentTruncated = currentRows.length >= args.fetchLimit;
        const previousTruncated = previousRows.length >= args.fetchLimit;

        const { comparedKeysCount, skippedDueToTruncationCount, winners, losers } =
          comparePeriodRows({
            currentRows,
            previousRows,
            dimension: args.dimension,
            sortBy: args.sortBy,
            limit: args.limit,
            minImpressions: args.minImpressions,
            currentTruncated,
            previousTruncated,
          });

        return jsonResult({
          siteUrl: args.siteUrl,
          dimension: args.dimension,
          searchType: args.searchType,
          periods: ranges,
          comparedKeysCount,
          dimensionRowsTruncated: currentTruncated || previousTruncated,
          ...(skippedDueToTruncationCount > 0 ? { skippedDueToTruncationCount } : {}),
          summary: {
            current: currentTotals,
            previous: previousTotals,
            delta: {
              clicks: currentTotals.clicks - previousTotals.clicks,
              impressions: currentTotals.impressions - previousTotals.impressions,
              ctrPercentPoints: roundMetric(currentTotals.ctrPercent - previousTotals.ctrPercent, 2),
              avgPositionChange:
                currentTotals.impressions > 0 && previousTotals.impressions > 0
                  ? roundMetric(previousTotals.avgPosition - currentTotals.avgPosition, 2)
                  : null,
            },
          },
          winners,
          losers,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "gsc_inspect_url",
    {
      title: "Inspect URL Indexing Status",
      description:
        "Checks Google Search Console URL Inspection indexing status, crawl state, canonicals, and robots.txt state for a specific URL.",
      inputSchema: {
        siteUrl: z
          .string()
          .min(1)
          .describe('Property URL, e.g. "sc-domain:example.com" or "https://example.com/".'),
        inspectionUrl: z
          .string()
          .url()
          .refine(
            (val) => {
              try {
                const protocol = new URL(val).protocol;
                return protocol === "http:" || protocol === "https:";
              } catch {
                return false;
              }
            },
            { message: "inspectionUrl must use http:// or https://." }
          )
          .describe("Full HTTP(S) URL to inspect (must belong to siteUrl), e.g. https://example.com/."),
        languageCode: z
          .string()
          .default("en-US")
          .describe('BCP-47 language code for localized issue messages (default: "en-US", e.g. "de-DE").'),
      },
      annotations: READ_ONLY_ANNOTATIONS,
    },
    async (args) => {
      try {
        const client = clientProvider();
        const res = await client.urlInspection.index.inspect({
          requestBody: {
            siteUrl: args.siteUrl,
            inspectionUrl: args.inspectionUrl,
            languageCode: args.languageCode,
          },
        });

        const result = res.data.inspectionResult;
        const indexStatus = result?.indexStatusResult;

        return jsonResult({
          siteUrl: args.siteUrl,
          inspectionUrl: args.inspectionUrl,
          inspectionResultLink: result?.inspectionResultLink ?? null,
          indexStatus: {
            verdict: indexStatus?.verdict ?? null,
            coverageState: indexStatus?.coverageState ?? null,
            indexingState: indexStatus?.indexingState ?? null,
            pageFetchState: indexStatus?.pageFetchState ?? null,
            robotsTxtState: indexStatus?.robotsTxtState ?? null,
            lastCrawlTime: indexStatus?.lastCrawlTime ?? null,
            crawledAs: indexStatus?.crawledAs ?? null,
            googleCanonical: indexStatus?.googleCanonical ?? null,
            userCanonical: indexStatus?.userCanonical ?? null,
            sitemap: indexStatus?.sitemap ?? [],
            referringUrls: indexStatus?.referringUrls ?? [],
          },
          mobileUsability: result?.mobileUsabilityResult ?? null,
          richResults: result?.richResultsResult ?? null,
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  return server;
}
