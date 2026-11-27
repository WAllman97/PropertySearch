// The monthly branch report's figures as words (migration 040). Shared by
// the email (_lib/monthly-report.js) and the agent portal's card, so both
// say the same thing. No server code here: the app bundles this file.

export function hoursAndMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

const word = (n, one, many = `${one}s`) => (n === 1 ? one : many);

// figures (branch_report) -> [{ n, label }]. Rows that are 0 are left out,
// except viewings booked.
export function reportRows(f) {
  const rows = [
    [f.bookings, `${word(f.bookings, "viewing")} booked online, no phone call`, true],
    [f.buyers, `different ${word(f.buyers, "buyer")} booked`],
    [f.buyers_ready, `${word(f.buyers_ready, "buyer")} with proof of funds, cash or a mortgage in principle`],
    [f.viewings_held, `${word(f.viewings_held, "viewing")} held`],
    [f.cancelled_with_notice, `${word(f.cancelled_with_notice, "cancellation")} with notice: time freed, everyone told`],
    [f.feedback, `feedback ${word(f.feedback, "answer")} from buyers after viewings`],
    [f.homes_sent, `${word(f.homes_sent, "home")} sent to matching buyers`],
    [f.offers, `accepted ${word(f.offers, "offer")} reported by buyers`],
  ];
  return rows.filter(([n, , always]) => always || n > 0).map(([n, label]) => ({ n: n || 0, label }));
}

export const ESTIMATES =
  "Time saved is an estimate: 10 minutes for each viewing booked without a call, 5 for each cancellation handled, 2 for each home sent to a buyer, 5 for each offer confirmed with one tap and 3 for each buyer not chased because they'd stopped looking.";
