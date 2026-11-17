// The iPhone/Android app (Capacitor) loads its pages from the phone, so its
// calls to /api/* are cross-origin. Allow exactly those app origins; browsers
// on any other site still get no CORS headers and are blocked as before.
// Auth is a Bearer token, not cookies, so credentials are not allowed.
const APP_ORIGINS = new Set([
  "capacitor://localhost", // iOS
  "ionic://localhost", // older iOS default
  "https://localhost", // Android
  "http://localhost", // Android (http scheme)
]);

export function withCors(handler) {
  return async function corsHandler(req, res) {
    const origin = req.headers.origin;

    if (origin && APP_ORIGINS.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.setHeader("Access-Control-Max-Age", "86400");
    }

    // Preflight: answer before the route runs (routes reject non-POST/GET).
    if (req.method === "OPTIONS") {
      return res.status(204).end();
    }

    return handler(req, res);
  };
}
