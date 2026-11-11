// Europe/London wall-clock <-> UTC without a date library. Booking windows
// are stored as London times ("weekdays 12:30-13:30"), so slots must be
// generated in London time and stored as real instants (UTC).

const TZ = "Europe/London";

const partsFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  weekday: "short",
});

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

// London calendar fields for an instant.
export function londonParts(date) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, p.value])
  );

  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAYS[parts.weekday],
  };
}

// Minutes London is ahead of UTC at this instant (0 in winter, 60 in BST).
function londonOffsetMinutes(date) {
  const p = londonParts(date);
  const asIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
  return Math.round((asIfUtc - Math.floor(date.getTime() / 60000) * 60000) / 60000);
}

// The UTC instant for a London wall-clock time.
export function londonToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const offset = londonOffsetMinutes(new Date(guess));
  const result = new Date(guess - offset * 60000);
  // Re-check across a DST boundary.
  const offset2 = londonOffsetMinutes(result);
  return offset2 === offset ? result : new Date(guess - offset2 * 60000);
}

// Add whole days to a London calendar date (no time component).
export function addLondonDays({ year, month, day }, days) {
  const d = new Date(Date.UTC(year, month - 1, day + days));
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: ((d.getUTCDay() + 6) % 7) + 1,
  };
}

export function formatLondon(date, options = {}) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...options,
  }).format(date);
}

function parseTime(value) {
  const [h, m] = String(value).split(":").map(Number);
  return h * 60 + m;
}

function overlaps(aStart, aEnd, bStart, bEnd) {
  return aStart < bEnd && bStart < aEnd;
}

// Free slots for a booking page.
//   windows: [{ weekday, start_time: "12:30:00", end_time: "13:30:00" }]
//   busy:    [{ start: Date, end: Date }]
// Returns [{ start: Date, end: Date }] in chronological order.
export function generateSlots({ page, windows, busy, now = new Date() }) {
  const slotMs = page.slot_minutes * 60000;
  const earliest = now.getTime() + page.min_notice_hours * 3600000;
  const today = londonParts(now);
  const slots = [];

  for (let offset = 0; offset <= page.days_ahead; offset++) {
    const date = addLondonDays(today, offset);
    const dayWindows = windows.filter((w) => Number(w.weekday) === date.weekday);

    for (const window of dayWindows) {
      const startMin = parseTime(window.start_time);
      const endMin = parseTime(window.end_time);

      for (let m = startMin; m + page.slot_minutes <= endMin; m += page.slot_minutes) {
        const start = londonToUtc(
          date.year, date.month, date.day, Math.floor(m / 60), m % 60
        );
        const end = new Date(start.getTime() + slotMs);

        if (start.getTime() < earliest) continue;
        if (busy.some((b) => overlaps(start, end, b.start, b.end))) continue;

        slots.push({ start, end });
      }
    }
  }

  return slots.sort((a, b) => a.start - b.start);
}
