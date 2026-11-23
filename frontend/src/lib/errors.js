// Turn whatever went wrong into something a person can act on. Raw messages
// like "Load failed", "Failed to fetch" or database codes mean nothing to a
// buyer or an agent.
export function friendlyError(error, fallback = "Something went wrong. Please try again.") {
  const message = String(error?.message || error || "");
  if (typeof navigator !== "undefined" && navigator.onLine === false) {
    return "You're offline. Check your connection and try again.";
  }
  if (/load failed|failed to fetch|network|timed? ?out|fetch/i.test(message)) {
    return "Couldn't reach PropertySearch. Check your connection and try again.";
  }
  if (/jwt|session|auth|token|401/i.test(message)) {
    return "You've been signed out. Please log in again.";
  }
  if (/permission|row-level|policy|403/i.test(message)) {
    return "You don't have access to that.";
  }
  // Short, readable messages we wrote ourselves can pass through.
  if (message && message.length < 120 && !/[_{}]|column|relation|rows|sql|null value/i.test(message)) {
    return message;
  }
  return fallback;
}
