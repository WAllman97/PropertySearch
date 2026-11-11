import { supabase } from "./supabaseClient";

export const SESSION_EXPIRED_MESSAGE = "Your login has expired. Please log in again.";

// POST JSON to one of our /api routes as the signed-in user.
//
// A stored session can look valid in the browser (unexpired JWT) after it has
// been revoked on the server, e.g. by logging out elsewhere. The API then
// answers 401. When that happens, clear the local session so the app returns
// to the login screen instead of leaving buttons that silently fail.
export async function postAuthed(path, body) {
  const {
    data: { session },
  } = await supabase.auth.getSession();

  if (!session) {
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  const response = await fetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
    },
    body: JSON.stringify(body),
  });

  if (response.status === 401) {
    alert(SESSION_EXPIRED_MESSAGE);
    await supabase.auth.signOut({ scope: "local" });
    throw new Error(SESSION_EXPIRED_MESSAGE);
  }

  return response;
}
