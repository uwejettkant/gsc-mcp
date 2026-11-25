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

  it("parses valid YYYY-MM-DD strings including leap years and formats them back identically", () => {
    expect(formatDateUTC(parseDateUTC("2026-02-28"))).toBe("2026-02-28");
    expect(formatDateUTC(parseDateUTC("2024-02-29"))).toBe("2024-02-29");
  });

  it("rejects malformed date strings and impossible calendar dates that roll over", () => {
    expect(() => parseDateUTC("25.11.2026")).toThrow(/Invalid date format/);
    expect(() => parseDateUTC("2026-2-5")).toThrow(/Invalid date format/);
    expect(() => parseDateUTC("2026-02-29")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-02-31")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-04-31")).toThrow(/Invalid calendar date/);
    expect(() => parseDateUTC("2026-13-01")).toThrow(/Invalid calendar date/);
  });

  it("computes the 28-day default window shifted back by the 3-day GSC lag or 0-day fresh lag", () => {
    const range = getDefaultDateRange(28, fixedNow);
    expect(range).toEqual({
      startDate: "2026-10-26",
      endDate: "2026-11-22",
    });
    expect(addDaysUTC(parseDateUTC(range.startDate), 27)).toEqual(parseDateUTC(range.endDate));

    const freshRange = resolveAnalyticsDateRange({ days: 7, lagDays: 0, now: fixedNow });
    expect(freshRange).toEqual({
      startDate: "2026-11-19",
      endDate: "2026-11-25",
    });
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

  it("derives matching previous period span from explicit current dates and accepts valid explicit previous ranges", () => {
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

    const yoy = resolveComparisonRanges({
      currentStartDate: "2026-11-01",
      currentEndDate: "2026-11-10",
      previousStartDate: "2025-11-01",
      previousEndDate: "2025-11-10",
      now: fixedNow,
    });
    expect(yoy).toEqual({
      currentStartDate: "2026-11-01",
      currentEndDate: "2026-11-10",
      previousStartDate: "2025-11-01",
      previousEndDate: "2025-11-10",
    });
  });

  it("rejects half-specified, conflicting, overlapping, or unequal-length comparison periods", () => {
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

    expect(() =>
      resolveComparisonRanges({
        days: 90,
        currentStartDate: "2026-11-01",
        currentEndDate: "2026-11-10",
        now: fixedNow,
      })
    ).toThrow(/either `days` or explicit/);

    expect(() =>
      resolveComparisonRanges({
        currentStartDate: "2026-11-01",
        currentEndDate: "2026-11-10",
        previousStartDate: "2026-10-25",
        previousEndDate: "2026-11-03",
        now: fixedNow,
      })
    ).toThrow(/do not overlap/);

    expect(() =>
      resolveComparisonRanges({
        currentStartDate: "2026-11-01",
        currentEndDate: "2026-11-10",
        previousStartDate: "2026-10-01",
        previousEndDate: "2026-10-05",
        now: fixedNow,
      })
    ).toThrow(/equal length/);
  });
});
