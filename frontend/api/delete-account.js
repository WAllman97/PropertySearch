// In-app account deletion, required by Apple for apps that let people sign
// up (buyers and agents both can).
//   POST /api/delete-account { confirm: "DELETE" }
//
// Buyers: if a partner is still in the household, only this login goes and
// the shared list stays with them. If it was the last member, the household
// and everything in it (properties, notes, price history, commute addresses)
// is deleted too. The original household (the one the scraper fills) is
// never deleted from here.
//
// Agents: future viewings are cancelled first so every buyer is emailed;
// then the auth user is deleted, which cascades to the agent profile,
// listings, times and bookings (migration 006).
import { householdMemberIds, requireUser, supabaseAdmin } from "./_lib/household.js";
import { cancelSlotAndNotify, loadSlot } from "./_lib/viewings.js";
import { withCors } from "./_lib/cors.js";

export default withCors(handler);

async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const user = await requireUser(req, res);
  if (!user) return;

  if (req.body?.confirm !== "DELETE") {
    return res.status(400).json({ error: "Type DELETE to confirm" });
  }

  const [{ data: member }, { data: agent }] = await Promise.all([
    supabaseAdmin
      .from("household_members")
      .select("household_id, households(is_original)")
      .eq("user_id", user.id)
      .maybeSingle(),
    supabaseAdmin.from("agents").select("user_id").eq("user_id", user.id).maybeSingle(),
  ]);

  let emptyHousehold = null;

  if (member) {
    const others = (await householdMemberIds(member.household_id)).filter((id) => id !== user.id);

    if (others.length) {
      // The shared commute addresses may be filed under this login; hand them
      // to a remaining member so they aren't deleted with it.
      const { error: moveError } = await supabaseAdmin
        .from("buyer_profiles")
        .update({ user_id: others[0] })
        .eq("household_id", member.household_id)
        .eq("user_id", user.id);
      if (moveError) {
        console.error("Could not hand over buyer profile:", moveError);
        return res.status(500).json({ error: "Could not delete your account. Please try again." });
      }
    } else if (member.households?.is_original) {
      return res.status(409).json({
        error: "This is the main household and can't be deleted in the app. Email us and we'll help.",
      });
    } else {
      emptyHousehold = member.household_id;
    }
  }

  if (agent) {
    const { data: slots } = await supabaseAdmin
      .from("viewing_slots")
      .select("id")
      .eq("agent_id", user.id)
      .is("cancelled_at", null)
      .gt("starts_at", new Date().toISOString());

    for (const { id } of slots || []) {
      const slot = await loadSlot(id);
      if (slot) await cancelSlotAndNotify(slot);
    }
  }

  const { error } = await supabaseAdmin.auth.admin.deleteUser(user.id);
  if (error) {
    console.error("deleteUser failed:", error);
    return res.status(500).json({ error: "Could not delete your account. Please try again." });
  }

  if (emptyHousehold) {
    const failed = await deleteHousehold(emptyHousehold);
    // The login is already gone; anything left is unreachable, so log it for
    // a manual clean-up rather than failing the request.
    if (failed) console.error(`Household ${emptyHousehold} only partly deleted:`, failed);
  }

  return res.status(200).json({ success: true });
}

// Everything a household owned. Properties go with the household (migration
// 013); notes are removed first in case their link to properties doesn't
// cascade. Returns the first error, if any.
async function deleteHousehold(householdId) {
  const { data: properties, error: listError } = await supabaseAdmin
    .from("properties")
    .select("id")
    .eq("household_id", householdId);
  if (listError) return listError;

  const ids = (properties || []).map((p) => p.id);
  for (let i = 0; i < ids.length; i += 200) {
    const { error } = await supabaseAdmin
      .from("property_notes")
      .delete()
      .in("property_id", ids.slice(i, i + 200));
    if (error) return error;
  }

  // Proof documents (migration 017) live in storage, outside the database
  // cascade: delete the household's folder.
  const { data: files, error: filesError } = await supabaseAdmin.storage
    .from("position-proofs")
    .list(householdId, { limit: 1000 });
  if (filesError) return filesError;
  if (files?.length) {
    const { error: removeError } = await supabaseAdmin.storage
      .from("position-proofs")
      .remove(files.map((f) => `${householdId}/${f.name}`));
    if (removeError) return removeError;
  }

  const { error } = await supabaseAdmin.from("households").delete().eq("id", householdId);
  return error || null;
}
