const GSC_DATA_LAG_DAYS = 3;

/**
 * Formats a Date as YYYY-MM-DD in UTC.
 */
export function formatDateUTC(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a strict YYYY-MM-DD string into a UTC Date.
 * Rejects impossible calendar dates such as 2026-02-31 that JavaScript's Date
 * constructor would otherwise silently roll over into the next month.
 */
export function parseDateUTC(dateStr: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Invalid date format "${dateStr}". Expected YYYY-MM-DD.`);
  }
  const date = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || formatDateUTC(date) !== dateStr) {
    throw new Error(`Invalid calendar date "${dateStr}".`);
  }
  return date;
}

/**
 * Adds a number of days to a UTC Date and returns a new Date.
 */
export function addDaysUTC(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

/**
 * Returns default startDate and endDate for the last `days` days,
 * shifted back by GSC's typical 3-day data availability lag.
 */
export function getDefaultDateRange(
  days = 28,
  now: Date = new Date()
): { startDate: string; endDate: string } {
  const todayUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const end = addDaysUTC(todayUTC, -GSC_DATA_LAG_DAYS);
  const start = addDaysUTC(end, -(days - 1));
  return {
    startDate: formatDateUTC(start),
    endDate: formatDateUTC(end),
  };
}

/**
 * Resolves and validates startDate and endDate for single-period analytics queries.
 * - Both omitted: last `days` days ending at today - 3 days.
 * - Only endDate provided: `days` days ending at endDate.
 * - Only startDate provided: from startDate up to default endDate (today - 3 days).
 */
export function resolveAnalyticsDateRange(params: {
  startDate?: string;
  endDate?: string;
  days?: number;
  now?: Date;
}): { startDate: string; endDate: string } {
  const days = params.days ?? 28;
  const defaults = getDefaultDateRange(days, params.now);

  let start: Date;
  let end: Date;

  if (params.startDate !== undefined && params.endDate !== undefined) {
    start = parseDateUTC(params.startDate);
    end = parseDateUTC(params.endDate);
  } else if (params.endDate !== undefined) {
    end = parseDateUTC(params.endDate);
    start = addDaysUTC(end, -(days - 1));
  } else if (params.startDate !== undefined) {
    start = parseDateUTC(params.startDate);
    end = parseDateUTC(defaults.endDate);
  } else {
    start = parseDateUTC(defaults.startDate);
    end = parseDateUTC(defaults.endDate);
  }

  if (end < start) {
    throw new Error(
      `endDate (${formatDateUTC(end)}) must be on or after startDate (${formatDateUTC(start)}).`
    );
  }

  return {
    startDate: formatDateUTC(start),
    endDate: formatDateUTC(end),
  };
}

export interface ComparisonRanges {
  currentStartDate: string;
  currentEndDate: string;
  previousStartDate: string;
  previousEndDate: string;
}

/**
 * Computes and validates current and previous date ranges for period-over-period comparisons.
 */
export function resolveComparisonRanges(params: {
  days?: number;
  currentStartDate?: string;
  currentEndDate?: string;
  previousStartDate?: string;
  previousEndDate?: string;
  now?: Date;
}): ComparisonRanges {
  const days = params.days ?? 28;

  if ((params.currentStartDate !== undefined) !== (params.currentEndDate !== undefined)) {
    throw new Error(
      "Provide both currentStartDate and currentEndDate, or omit both to use `days`."
    );
  }

  if ((params.previousStartDate !== undefined) !== (params.previousEndDate !== undefined)) {
    throw new Error(
      "Provide both previousStartDate and previousEndDate, or omit both to derive the preceding period automatically."
    );
  }

  const defaults = getDefaultDateRange(days, params.now);
  const currentStartDate = params.currentStartDate ?? defaults.startDate;
  const currentEndDate = params.currentEndDate ?? defaults.endDate;

  const currentStart = parseDateUTC(currentStartDate);
  const currentEnd = parseDateUTC(currentEndDate);
  if (currentEnd < currentStart) {
    throw new Error("currentEndDate must be on or after currentStartDate.");
  }

  if (params.previousStartDate !== undefined && params.previousEndDate !== undefined) {
    const prevStart = parseDateUTC(params.previousStartDate);
    const prevEnd = parseDateUTC(params.previousEndDate);
    if (prevEnd < prevStart) {
      throw new Error("previousEndDate must be on or after previousStartDate.");
    }
    return {
      currentStartDate: formatDateUTC(currentStart),
      currentEndDate: formatDateUTC(currentEnd),
      previousStartDate: formatDateUTC(prevStart),
      previousEndDate: formatDateUTC(prevEnd),
    };
  }

  const spanDays = Math.round((currentEnd.getTime() - currentStart.getTime()) / 86_400_000) + 1;
  const previousEnd = addDaysUTC(currentStart, -1);
  const previousStart = addDaysUTC(previousEnd, -(spanDays - 1));

  return {
    currentStartDate: formatDateUTC(currentStart),
    currentEndDate: formatDateUTC(currentEnd),
    previousStartDate: formatDateUTC(previousStart),
    previousEndDate: formatDateUTC(previousEnd),
  };
}
