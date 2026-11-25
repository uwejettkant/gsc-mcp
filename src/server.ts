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
  if (typeof value !== "number" || Number.isNaN(value)) {
    return 0;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

export function formatRow(row: SearchAnalyticsRow, dimensions: string[]) {
  const keys = row.keys ?? [];
  const dimensionMap: Record<string, string> = {};
  dimensions.forEach((dim, idx) => {
    dimensionMap[dim] = keys[idx] ?? "";
  });

  return {
    ...dimensionMap,
    clicks: row.clicks ?? 0,
    impressions: row.impressions ?? 0,
    ctrPercent: roundMetric((row.ctr ?? 0) * 100, 2),
    position: roundMetric(row.position ?? 0, 2),
  };
}

export function sortRows(
  rows: SearchAnalyticsRow[],
  sortBy: z.infer<typeof SortByEnum>,
  sortOrder: z.infer<typeof SortOrderEnum>
): SearchAnalyticsRow[] {
  const direction = sortOrder === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    const valA = a[sortBy] ?? 0;
    const valB = b[sortBy] ?? 0;
    return (valA - valB) * direction;
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
    const clicks = single.clicks ?? 0;
    const impressions = single.impressions ?? 0;
    const ctr =
      typeof single.ctr === "number"
        ? single.ctr
        : impressions > 0
          ? clicks / impressions
          : 0;
    return {
      clicks,
      impressions,
      ctrPercent: roundMetric(ctr * 100, 2),
      avgPosition: impressions > 0 || (single.position ?? 0) > 0 ? roundMetric(single.position ?? 0, 2) : 0,
    };
  }

  let clicks = 0;
  let impressions = 0;
  let weightedPosition = 0;

  for (const row of rows) {
    const rowClicks = row.clicks ?? 0;
    const rowImpressions = row.impressions ?? 0;
    const rowPos = row.position ?? 0;
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
}) {
  const minImpressions = params.minImpressions ?? 0;

  const currentMap = new Map<string, SearchAnalyticsRow>();
  for (const row of params.currentRows) {
    const key = row.keys?.[0];
    if (key !== undefined) currentMap.set(key, row);
  }

  const previousMap = new Map<string, SearchAnalyticsRow>();
  for (const row of params.previousRows) {
    const key = row.keys?.[0];
    if (key !== undefined) previousMap.set(key, row);
  }

  const allKeys = new Set([...currentMap.keys(), ...previousMap.keys()]);
  const comparisons = Array.from(allKeys)
    .map((key) => {
      const cur = currentMap.get(key);
      const prev = previousMap.get(key);

      const curClicks = cur?.clicks ?? 0;
      const prevClicks = prev?.clicks ?? 0;
      const curImpr = cur?.impressions ?? 0;
      const prevImpr = prev?.impressions ?? 0;
      const curPos = cur?.position ?? null;
      const prevPos = prev?.position ?? null;

      // Positive positionDiff means ranking improved (e.g., pos 10 -> pos 4 => +6).
      const positionDiff =
        curPos !== null && prevPos !== null ? roundMetric(prevPos - curPos, 2) : null;

      return {
        [params.dimension]: key,
        currentClicks: curClicks,
        previousClicks: prevClicks,
        clicksDiff: curClicks - prevClicks,
        currentImpressions: curImpr,
        previousImpressions: prevImpr,
        impressionsDiff: curImpr - prevImpr,
        currentPosition: curPos !== null ? roundMetric(curPos, 2) : null,
        previousPosition: prevPos !== null ? roundMetric(prevPos, 2) : null,
        positionDiff,
      };
    })
    .filter((item) => item.currentImpressions + item.previousImpressions >= minImpressions);

  const getSortVal = (item: (typeof comparisons)[number]) => {
    if (params.sortBy === "positionDiff") return item.positionDiff ?? 0;
    return item[params.sortBy];
  };

  const winners = [...comparisons]
    .filter((item) => getSortVal(item) > 0)
    .sort((a, b) => getSortVal(b) - getSortVal(a))
    .slice(0, params.limit);

  const losers = [...comparisons]
    .filter((item) => getSortVal(item) < 0)
    .sort((a, b) => getSortVal(a) - getSortVal(b))
    .slice(0, params.limit);

  return {
    comparedKeysCount: allKeys.size,
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
          .describe("End date in YYYY-MM-DD format. Defaults to today minus 3 days (GSC data lag)."),
        dimensions: z
          .array(DimensionEnum)
          .min(1)
          .max(3)
          .default(["query"])
          .describe("Dimensions to group by (query, page, country, device, searchAppearance, date)."),
        filters: z.array(FilterSchema).optional().describe("Optional AND-combined dimension filters."),
        searchType: SearchTypeEnum.default("web").describe("Search type (default: web)."),
        rowLimit: z.number().int().min(1).max(25000).default(25).describe("Max rows to return (1-25000)."),
        startRow: z.number().int().min(0).default(0).describe("Zero-based offset for pagination."),
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
          now: nowProvider(),
        });

        const needsClientSort = args.sortBy !== "clicks" || args.sortOrder !== "desc";
        if (needsClientSort && args.startRow + args.rowLimit > 25000) {
          throw new Error(
            "startRow + rowLimit cannot exceed 25000 when sorting by impressions, ctr, position, or ascending order."
          );
        }
        const fetchRowLimit = needsClientSort
          ? Math.min(Math.max(args.startRow + args.rowLimit, 1000), 25000)
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
        "Compares two date ranges (e.g., last 28 or 90 days vs. the previous period) to identify true property-wide totals as well as top dimension winners and losers.",
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
          .default(28)
          .describe("Number of days per period when explicit dates are omitted (e.g., 28 or 90)."),
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
          .max(5000)
          .default(1000)
          .describe("Max dimension rows fetched per period for winner/loser comparison (default: 1000)."),
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

        const { comparedKeysCount, winners, losers } = comparePeriodRows({
          currentRows,
          previousRows,
          dimension: args.dimension,
          sortBy: args.sortBy,
          limit: args.limit,
          minImpressions: args.minImpressions,
        });

        return jsonResult({
          siteUrl: args.siteUrl,
          dimension: args.dimension,
          searchType: args.searchType,
          periods: ranges,
          comparedKeysCount,
          dimensionRowsTruncated:
            currentRows.length >= args.fetchLimit || previousRows.length >= args.fetchLimit,
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
          .describe("Full URL to inspect (must belong to siteUrl), e.g. https://example.com/."),
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
