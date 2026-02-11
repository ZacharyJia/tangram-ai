type LocalDate = {
  year: number;
  month: number;
  day: number;
};

type LocalDateTime = LocalDate & {
  hour: number;
  minute: number;
};

function toNumber(v: string | undefined): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return NaN;
  return n;
}

function dateTimeFormatter(timezone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function assertValidTimeZone(timezone: string): void {
  try {
    dateTimeFormatter(timezone).format(new Date());
  } catch {
    throw new Error(`Invalid timezone: ${timezone}`);
  }
}

export function parseLocalTime(time: string): { hour: number; minute: number } {
  const m = time.trim().match(/^(\d{2}):(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid local time '${time}', expected HH:mm`);
  }
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    throw new Error(`Invalid local time '${time}', expected HH:mm`);
  }
  return { hour, minute };
}

export function parseLocalDate(date: string): LocalDate {
  const m = date.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    throw new Error(`Invalid local date '${date}', expected YYYY-MM-DD`);
  }
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);

  const check = new Date(Date.UTC(year, month - 1, day));
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() + 1 !== month ||
    check.getUTCDate() !== day
  ) {
    throw new Error(`Invalid local date '${date}', expected valid YYYY-MM-DD`);
  }

  return { year, month, day };
}

function formatToPartsMs(ms: number, timezone: string): LocalDateTime {
  const parts = dateTimeFormatter(timezone).formatToParts(new Date(ms));
  const byType: Record<string, string> = {};
  for (const p of parts) {
    if (p.type === "literal") continue;
    byType[p.type] = p.value;
  }

  const year = toNumber(byType.year);
  const month = toNumber(byType.month);
  const day = toNumber(byType.day);
  const hour = toNumber(byType.hour);
  const minute = toNumber(byType.minute);

  if (![year, month, day, hour, minute].every((n) => Number.isFinite(n))) {
    throw new Error(`Failed to resolve timezone parts for ${timezone}`);
  }

  return { year, month, day, hour, minute };
}

function addDays(date: LocalDate, days: number): LocalDate {
  const dt = new Date(Date.UTC(date.year, date.month - 1, date.day) + days * 24 * 3600 * 1000);
  return {
    year: dt.getUTCFullYear(),
    month: dt.getUTCMonth() + 1,
    day: dt.getUTCDate(),
  };
}

export function zonedDateTimeToUtcMs(params: {
  timezone: string;
  date: LocalDate;
  time: { hour: number; minute: number };
}): number {
  const { timezone, date, time } = params;
  assertValidTimeZone(timezone);

  const target = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute, 0, 0);
  let guess = target;

  for (let i = 0; i < 8; i++) {
    const p = formatToPartsMs(guess, timezone);
    const observed = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
    const diff = target - observed;
    if (diff === 0) break;
    guess += diff;
  }

  const finalParts = formatToPartsMs(guess, timezone);
  if (
    finalParts.year !== date.year ||
    finalParts.month !== date.month ||
    finalParts.day !== date.day ||
    finalParts.hour !== time.hour ||
    finalParts.minute !== time.minute
  ) {
    throw new Error(
      `Local datetime does not exist or is ambiguous in timezone ${timezone}: ${date.year}-${String(
        date.month
      ).padStart(2, "0")}-${String(date.day).padStart(2, "0")} ${String(time.hour).padStart(2, "0")}:${String(
        time.minute
      ).padStart(2, "0")}`
    );
  }

  return guess;
}

export function localDateTimeToUtcIso(params: {
  timezone: string;
  localDate: string;
  localTime: string;
}): string {
  const date = parseLocalDate(params.localDate);
  const time = parseLocalTime(params.localTime);
  return new Date(
    zonedDateTimeToUtcMs({
      timezone: params.timezone,
      date,
      time,
    })
  ).toISOString();
}

export function nextLocalTimeUtcIso(params: {
  timezone: string;
  localTime: string;
  fromMs?: number;
}): string {
  const fromMs = params.fromMs ?? Date.now();
  const time = parseLocalTime(params.localTime);
  const nowLocal = formatToPartsMs(fromMs, params.timezone);
  const startDate: LocalDate = {
    year: nowLocal.year,
    month: nowLocal.month,
    day: nowLocal.day,
  };

  for (let i = 0; i < 3660; i++) {
    const date = addDays(startDate, i);
    const utcMs = zonedDateTimeToUtcMs({
      timezone: params.timezone,
      date,
      time,
    });
    if (utcMs > fromMs) {
      return new Date(utcMs).toISOString();
    }
  }

  throw new Error(`Unable to compute next local time for timezone ${params.timezone}`);
}

