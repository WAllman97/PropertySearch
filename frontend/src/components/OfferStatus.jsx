import { useState } from "react";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";
import { resumeSearches } from "./SearchStatus";
import MoneyInput from "./MoneyInput";

// "Offer accepted" on a saved home (migration 015, /api/offers). It only
// counts as verified once the selling agent confirms it.
//
// Everything is asked and answered inline (no pop-up dialogs): they look out
// of place in the iPhone app and can't show a numeric keypad.
const STATUS_TEXT = {
  awaiting_agent: "Waiting for the agent to confirm",
  confirmed: "✓ Confirmed by the agent",
  disputed: "The agent says this isn't right: check with them",
  unverified: "Not confirmed (this agent isn't on ViewPal)",
};

function pounds(amount) {
  return `£${Number(amount).toLocaleString("en-GB")}`;
}

// "£625,000" / "625000" to whole pounds; 0 when it isn't a number.
function parsePounds(text) {
  const clean = String(text || "").replace(/[£,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return 0;
  return Math.round(Number(clean));
}

// onChanged(message) reloads the list; message (if any) says what happened.
export function OfferStatus({ offer, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  if (!offer) return null;

  async function withdraw() {
    setBusy(true);
    setError("");
    let response;
    let body;
    try {
      response = await postAuthed("/api/offers", { action: "withdraw", offerId: offer.id });
      body = await response.json().catch(() => ({}));
    } catch (err) {
      // Network dropped: say so, and don't leave the button disabled.
      setError(friendlyError(err));
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      setError(body.error || "Could not withdraw the offer");
      return;
    }
    setConfirming(false);
    if (body.lookingAgain) resumeSearches();
    onChanged?.(
      body.lookingAgain ? "Withdrawn. You're looking again, so agents will send you matching homes." : "Offer withdrawn."
    );
  }

  return (
    <div className={`offer-status offer-${offer.status}`} onClick={(e) => e.stopPropagation()}>
      <strong>Offer accepted: {pounds(offer.amount)}</strong>
      <span>{STATUS_TEXT[offer.status] || offer.status}</span>
      {confirming ? (
        <div className="inline-confirm" role="group" aria-label="Withdraw this offer?">
          <p>Withdraw this offer? Use this if the sale fell through or it was a mistake.</p>
          <div className="inline-confirm-actions">
            <button type="button" className="danger-button" disabled={busy} onClick={withdraw}>
              {busy ? "Withdrawing..." : "Withdraw"}
            </button>
            <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <button type="button" className="link-button" onClick={() => setConfirming(true)}>
          Withdraw
        </button>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

// "Offer accepted" button that opens an amount field in place.
// startOpen: open straight away (chosen from the stage list).
export function OfferAcceptedButton({ property, onChanged, startOpen = false, onCancel }) {
  const [open, setOpen] = useState(startOpen);
  const [amount, setAmount] = useState(() => (property.price ? Number(property.price).toLocaleString("en-GB") : ""));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  function cancel() {
    setOpen(false);
    setError("");
    onCancel?.();
  }

  async function report(event) {
    event.preventDefault();
    const value = parsePounds(amount);
    if (!value) {
      setError("Enter the amount in pounds, e.g. 625,000");
      return;
    }
    setBusy(true);
    setError("");
    let response;
    let body;
    try {
      response = await postAuthed("/api/offers", {
        action: "report",
        propertyId: property.id,
        amount: value,
      });
      body = await response.json().catch(() => ({}));
    } catch (err) {
      setError(friendlyError(err));
      return;
    } finally {
      setBusy(false);
    }
    if (!response.ok) {
      setError(body.error || "Could not save the offer");
      return;
    }
    const lines = [
      body.offer?.status === "awaiting_agent" ? "Congratulations! Saved, and we've asked the agent to confirm it." : "Congratulations! Saved.",
    ];
    if (body.foundHome) {
      lines.push(
        "We've told agents you've found somewhere, so they'll stop sending you homes. " +
          "If it falls through, withdraw the offer and you'll be looking again."
      );
    }
    setOpen(false);
    onChanged?.(lines.join(" "));
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Offer accepted
      </button>
    );
  }

  return (
    <form className="offer-amount-form" onSubmit={report} onClick={(e) => e.stopPropagation()}>
      <label>
        Accepted offer
        <span className="pounds-input">
          <span aria-hidden="true">£</span>
          <MoneyInput
            value={amount}
            onChange={(event) => {
              setAmount(event.target.value);
              setError("");
            }}
            aria-invalid={Boolean(error)}
            autoFocus
          />
        </span>
      </label>
      <div className="inline-confirm-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Saving..." : "Confirm"}
        </button>
        <button type="button" disabled={busy} onClick={cancel}>
          Cancel
        </button>
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
