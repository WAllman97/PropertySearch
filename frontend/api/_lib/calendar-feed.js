// Busy times from a private calendar link (iCal / .ics), for setup calls.
//
// CALL_CALENDAR_ICS_URL in Vercel holds the link: Google Calendar ->
// Settings -> the calendar -> "Secret address in iCal format". Several links
// can be given, separated by spaces or commas. It's a secret (anyone with it
// can read the calendar), so it lives only in the environment, never in the
// database or the app, and is never sent to the browser.
//
// Only "busy" events count: anything marked Free (TRANSP:TRANSPARENT, which
// is how Google exports all-day events by default) or cancelled is ignored.
// Repeating meetings are expanded, with moved or cancelled occurrences.
import ICAL from "ical.js";
import { londonToUtc } from "./time.js";

const CACHE_MS = 2 * 60 * 1000;
const MAX_OCCURRENCES = 20000; // per repeating event: a daily one for 50 years
let cache = null; // { at, urls, text[] }

export function calendarUrls() {
  return String(process.env.CALL_CALENDAR_ICS_URL || "")
    .split(/[\s,]+/)
    .map((url) => url.trim().replace(/^webcal:\/\//i, "https://"))
    .filter((url) => /^https:\/\//i.test(url));
}

async function fetchFeeds(urls, fresh) {
  const key = urls.join(" ");
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < CACHE_MS) return cache.texts;
  const texts = await Promise.all(
    urls.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000);
      try {
        const response = await fetch(url, { signal: controller.signal, headers: { Accept: "text/calendar" } });
        if (!response.ok) throw new Error(`calendar feed returned ${response.status}`);
        const text = await response.text();
        if (!text.includes("BEGIN:VCALENDAR")) throw new Error("calendar feed isn't an iCal file");
        return text;
      } finally {
        clearTimeout(timer);
      }
    })
  );
  cache = { key, at: Date.now(), texts };
  return texts;
}

// A real instant for an iCal time. Times in a zone the file describes (or
// UTC) convert exactly; all-day dates and "floating" times (no zone, or one
// the file doesn't describe) are read as London time.
function toDate(time) {
  if (time.isDate) return londonToUtc(time.year, time.month, time.day, 0, 0);
  const zone = time.zone;
  const known = zone && (zone.tzid === "UTC" || zone.tzid === "Z" || (zone.tzid !== "floating" && zone.component));
  if (known) return time.toJSDate();
  return londonToUtc(time.year, time.month, time.day, time.hour, time.minute);
}

function isBusy(component) {
  const status = String(component.getFirstPropertyValue("status") || "").toUpperCase();
  const transp = String(component.getFirstPropertyValue("transp") || "").toUpperCase();
  return status !== "CANCELLED" && transp !== "TRANSPARENT";
}

// [{ start, end }] for one iCal file, overlapping from..to.
export function busyFromIcs(text, from, to) {
  const root = new ICAL.Component(ICAL.parse(text));
  for (const zone of root.getAllSubcomponents("vtimezone")) {
    ICAL.TimezoneService.register(zone);
  }

  const events = root.getAllSubcomponents("vevent");
  const masters = new Map();
  const exceptions = [];
  for (const vevent of events) {
    if (vevent.hasProperty("recurrence-id")) exceptions.push(vevent);
    else masters.set(vevent.getFirstPropertyValue("uid"), new ICAL.Event(vevent, { strictExceptions: false }));
  }
  const orphans = [];
  for (const vevent of exceptions) {
    const master = masters.get(vevent.getFirstPropertyValue("uid"));
    if (master) master.relateException(vevent);
    else orphans.push(new ICAL.Event(vevent));
  }

  const busy = [];
  const add = (component, startTime, endTime) => {
    if (!isBusy(component)) return;
    const start = toDate(startTime);
    // No end: a timed event lasts no time, an all-day one the whole day.
    let end = endTime ? toDate(endTime) : null;
    if (!end || end <= start) end = new Date(start.getTime() + (startTime.isDate ? 24 * 3600000 : 0));
    if (end > from && start < to) busy.push({ start, end });
  };

  for (const event of [...masters.values(), ...orphans]) {
    if (!event.startDate) continue;
    if (!event.isRecurring()) {
      add(event.component, event.startDate, event.endDate);
      continue;
    }
    // Each occurrence is checked on its own: one moved out of a "free"
    // series can still be busy.
    const iterator = event.iterator();
    let next;
    let count = 0;
    while ((next = iterator.next()) && count++ < MAX_OCCURRENCES) {
      if (toDate(next) >= to) break;
      const details = event.getOccurrenceDetails(next);
      add(details.item.component, details.startDate, details.endDate);
    }
  }
  return busy;
}

// Busy times across every linked calendar. Throws if a link can't be read,
// so the caller can refuse to offer times rather than book over a meeting.
// fresh: skip the 2-minute cache (used just before a booking is saved).
export async function calendarBusy(from, to, { fresh = false } = {}) {
  const urls = calendarUrls();
  if (!urls.length) return [];
  const texts = await fetchFeeds(urls, fresh);
  return texts.flatMap((text) => busyFromIcs(text, from, to));
}
