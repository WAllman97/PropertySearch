import { useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { siteUrl } from "../lib/platform";
import { forgetThisPhone } from "../lib/push";

// Who's in your household, the link that lets a partner join it, and
// account deletion (Apple requires it in-app for anyone who can sign up).
export function HouseholdMembers({ household, onChange }) {
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const link = `${siteUrl}/join/${household.invite_code}`;
  const full = household.members.length >= 4;

  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      window.prompt("Copy this link:", link);
    }
  }

  async function share() {
    try {
      await navigator.share({
        title: "Join our PropertySearch household",
        text: "Sign up with this link to share our property list and viewings.",
        url: link,
      });
    } catch {
      // Cancelled, or not supported: the copy button is right there.
    }
  }

  async function resetLink() {
    if (!window.confirm("Make a new invite link? The old one will stop working.")) return;
    setBusy(true);
    setError("");
    const { error: rpcError } = await supabase.rpc("reset_household_invite");
    if (rpcError) setError("Could not make a new link. Please try again.");
    else onChange();
    setBusy(false);
  }

  return (
    <div className="household">
      <ul className="household-members">
        {household.members.map((member) => (
          <li key={member.email}>
            <strong>{member.name || member.email}</strong>
            {member.name && <span className="muted"> · {member.email}</span>}
            {member.is_me && <span className="muted"> (you)</span>}
          </li>
        ))}
      </ul>

      {full ? (
        <p className="muted">Your household is full (4 people).</p>
      ) : (
        <>
          <p className="muted">
            Send this link to your partner. When they sign up with it they'll see the same
            property list, calendar and notes.
          </p>
          <div className="household-invite">
            <input readOnly value={link} aria-label="Invite link" onFocus={(e) => e.target.select()} />
            <button type="button" className="primary-button" onClick={copy}>
              {copied ? "Copied" : "Copy link"}
            </button>
            {typeof navigator.share === "function" && (
              <button type="button" className="secondary-button" onClick={share}>
                Share
              </button>
            )}
          </div>
          <button type="button" className="link-button" onClick={resetLink} disabled={busy}>
            Make a new link (stops the old one working)
          </button>
        </>
      )}
      {error && <p className="booking-error">{error}</p>}
    </div>
  );
}

export function DeleteBuyerAccount({ household }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const others = household.members.filter((m) => !m.is_me).length;

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/delete-account", { confirm: typed });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete your account");
      // The account is gone; drop this phone's token and the local session.
      await forgetThisPhone().catch(() => {});
      await supabase.auth.signOut({ scope: "local" });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <div className="delete-account">
      {!open ? (
        <>
          <p className="muted">
            {others
              ? "Deletes your login. Your property list, notes and calendar stay with the rest of your household."
              : "Permanently deletes your login and your household's property list, notes, calendar and commute addresses."}
          </p>
          <button type="button" className="danger-button" onClick={() => setOpen(true)}>
            Delete my account
          </button>
        </>
      ) : (
        <>
          <p>
            This can't be undone. Type <strong>DELETE</strong> to confirm.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoCapitalize="characters"
            autoComplete="off"
            aria-label="Type DELETE to confirm"
          />
          {error && <p className="booking-error">{error}</p>}
          <div className="delete-account-actions">
            <button
              type="button"
              className="danger-button"
              disabled={busy || typed !== "DELETE"}
              onClick={remove}
            >
              {busy ? "Deleting..." : "Delete for good"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setTyped("");
                setError("");
              }}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </>
      )}
    </div>
  );
}
