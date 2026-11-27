// Viewings happen in the UK, so the buyer app shows them in London time
// even when the phone is set to another timezone (e.g. on holiday).

export const LONDON = "Europe/London";

const dayParts = new Intl.DateTimeFormat("en-GB", {
  timeZone: LONDON,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

// The London calendar day an instant falls on, as a local-midnight Date (the
// form the calendar grid and day strip use for days), so it can be compared
// with isSameDay / getTime keys and shown with getDate().
export function londonDay(instant) {
  const parts = Object.fromEntries(dayParts.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}
