import { describe, expect, it } from "vitest";
import {
  addDaysUTC,
  formatDateUTC,
  getDefaultDateRange,
  parseDateUTC,
  resolveAnalyticsDateRange,
  resolveComparisonRanges,
} from "../src/date-utils.js";

describe("date-utils", () => {
  const fixedNow = new Date("2026-11-25T16:00:00.000Z");

  it("parses valid YYYY-MM-DD strings and formats them back identically", () => {
    const parsed = parseDateUTC("2026-02-28");
    expect(formatDateUTC(parsed)).toBe("2026-02-28");
  });

  it("rejects malformed date strings and impossible calendar dates that roll over", () => {
    expect(() => parseDateUTC("25.11.2026")).toThrow(/Invalid date format/);
    expect(() => parseDateUTC("2026-2-5")).toThrow(/Invalid date format/);
    expect(() => parseDateUTC("2026-02-29")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-02-31")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-04-31")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-13-01")).toThrow(/Invalid calendar date/);
  });

  it("computes the 28-day default window shifted back by the 3-day GSC lag", () => {
    const range = getDefaultDateRange(28, fixedNow);
    expect(range).toEqual({
      startDate: "2026-10-26",
      endDate: "2026-11-22",
    });
    expect(addDaysUTC(parseDateUTC(range.startDate), 27)).toEqual(parseDateUTC(range.endDate));
  });

  it("anchors startDate relative to explicit endDate when startDate is omitted", () => {
    const range = resolveAnalyticsDateRange({
      endDate: "2026-09-30",
      days: 28,
      now: fixedNow,
    });
    expect(range).toEqual({
      startDate: "2026-09-03",
      endDate: "2026-09-30",
    });
  });

  it("anchors endDate to default lag-adjusted date when only startDate is provided", () => {
    const range = resolveAnalyticsDateRange({
      startDate: "2026-11-01",
      now: fixedNow,
    });
    expect(range).toEqual({
      startDate: "2026-11-01",
      endDate: "2026-11-22",
    });
  });

  it("rejects analytics ranges where endDate precedes startDate", () => {
    expect(() =>
      resolveAnalyticsDateRange({
        startDate: "2026-11-20",
        endDate: "2026-11-10",
        now: fixedNow,
      })
    ).toThrow(/must be on or after startDate/);

    expect(() =>
      resolveAnalyticsDateRange({
        startDate: "2026-11-24",
        now: fixedNow,
      })
    ).toThrow(/must be on or after startDate/);
  });

  it("derives contiguous equal-length comparison periods by default", () => {
    const ranges = resolveComparisonRanges({ days: 28, now: fixedNow });
    expect(ranges).toEqual({
      currentStartDate: "2026-10-26",
      currentEndDate: "2026-11-22",
      previousStartDate: "2026-09-28",
      previousEndDate: "2026-10-25",
    });
  });

  it("derives matching previous period span from explicit current dates", () => {
    const ranges = resolveComparisonRanges({
      currentStartDate: "2026-11-01",
      currentEndDate: "2026-11-10",
      now: fixedNow,
    });
    expect(ranges).toEqual({
      currentStartDate: "2026-11-01",
      currentEndDate: "2026-11-10",
      previousStartDate: "2026-10-22",
      previousEndDate: "2026-10-31",
    });
  });

  it("rejects half-specified current or previous date pairs instead of ignoring them", () => {
    expect(() =>
      resolveComparisonRanges({
        currentStartDate: "2026-11-01",
        now: fixedNow,
      })
    ).toThrow(/both currentStartDate and currentEndDate/);

    expect(() =>
      resolveComparisonRanges({
        previousStartDate: "2026-09-01",
        now: fixedNow,
      })
    ).toThrow(/both previousStartDate and previousEndDate/);
  });
});
