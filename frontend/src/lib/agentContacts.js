import { supabase } from "./supabaseClient";

// The household's agent address book, from what's already in their homes'
// notes: once they have an email or phone for "Savills, Battersea Park" on
// one home, every other home from that branch fills it in too. Portals'
// link previews only give the agent's name, so this is where the email and
// phone come from without typing them again.

const normalise = (name) =>
  String(name || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

// -> { email, phone } for that agent from the household's other homes (the
// most recently updated wins), or null. Row-level security keeps this to the
// household's own notes.
export async function findAgentContact(name) {
  const key = normalise(name);
  if (!key) return null;
  const { data, error } = await supabase
    .from("property_notes")
    .select("estate_agent, estate_agent_email, estate_agent_phone, updated_at")
    .not("estate_agent", "is", null)
    .or("estate_agent_email.not.is.null,estate_agent_phone.not.is.null")
    .order("updated_at", { ascending: false, nullsFirst: false })
    .limit(300);
  if (error || !data) return null;
  let email = "";
  let phone = "";
  for (const row of data) {
    if (normalise(row.estate_agent) !== key) continue;
    if (!email && row.estate_agent_email) email = row.estate_agent_email;
    if (!phone && row.estate_agent_phone) phone = row.estate_agent_phone;
    if (email && phone) break;
  }
  return email || phone ? { email, phone } : null;
}
