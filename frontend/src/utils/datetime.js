// <input type="datetime-local"> works in the browser's local time with no
// offset ("2026-07-01T14:00"). The database stores real instants
// (timestamptz). Sending the raw input value made Postgres read it as UTC,
// so every viewing during British Summer Time was saved an hour out.

const pad = (n) => String(n).padStart(2, "0");

// DB timestamp -> value for a datetime-local input (local time).
export function toLocalInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

// datetime-local value -> ISO string with offset, or null when empty.
export function fromLocalInputValue(value) {
  if (!value) return null;
  const date = new Date(value); // parsed as local time
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}
