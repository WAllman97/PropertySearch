// In-app account deletion, required by Apple for apps that let people sign
// up (agents can, in the agent portal).
//   POST /api/delete-account { confirm: "DELETE" }
//
// Agents only for now. Household (buyer) accounts are invite-only and share
// data with the rest of the household, so they are refused here and handled
// by support instead of risking the household's properties and notes.
//
// Future viewings are cancelled first so every buyer is emailed; then the
// auth user is deleted, which cascades to the agent profile, listings, times
// and bookings (migration 006).
import { requireUser, supabaseAdmin } from "./_lib/household.js";
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
    supabaseAdmin.from("household_members").select("user_id").eq("user_id", user.id).maybeSingle(),
    supabaseAdmin.from("agents").select("user_id").eq("user_id", user.id).maybeSingle(),
  ]);

  if (member) {
    return res.status(409).json({
      error: "Household accounts can't be deleted in the app yet. Email us and we'll do it for you.",
    });
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

  return res.status(200).json({ success: true });
}
