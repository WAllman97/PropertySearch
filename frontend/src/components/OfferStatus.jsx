import { useState } from "react";
import { postAuthed } from "../lib/api";

// "Offer accepted" on a saved home (migration 015, /api/offers). It only
// counts as verified once the selling agent confirms it.
const STATUS_TEXT = {
  awaiting_agent: "Waiting for the agent to confirm",
  confirmed: "✓ Confirmed by the agent",
  disputed: "The agent says this isn't right: check with them",
  unverified: "Not confirmed (this agent isn't on PropertySearch)",
};

function pounds(amount) {
  return `£${Number(amount).toLocaleString("en-GB")}`;
}

export function OfferStatus({ offer, onChanged }) {
  const [busy, setBusy] = useState(false);
  if (!offer) return null;

  async function withdraw() {
    if (!window.confirm("Withdraw this accepted offer? Use this if the sale fell through or it was a mistake.")) return;
    setBusy(true);
    const response = await postAuthed("/api/offers", { action: "withdraw", offerId: offer.id });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) window.alert(body.error || "Could not withdraw the offer");
    onChanged();
  }

  return (
    <div className={`offer-status offer-${offer.status}`} onClick={(e) => e.stopPropagation()}>
      <strong>Offer accepted: {pounds(offer.amount)}</strong>
      <span>{STATUS_TEXT[offer.status] || offer.status}</span>
      <button type="button" className="link-button" disabled={busy} onClick={withdraw}>
        Withdraw
      </button>
    </div>
  );
}

export function OfferAcceptedButton({ property, onChanged }) {
  const [busy, setBusy] = useState(false);

  async function report() {
    const typed = window.prompt(
      `Congratulations! What offer was accepted on ${property.address}? (in pounds)`,
      property.price ? String(property.price) : ""
    );
    if (typed === null) return;
    const amount = Number(typed.replace(/[£,\s]/g, ""));
    if (!amount) {
      window.alert("Enter the amount in pounds, e.g. 625000");
      return;
    }
    setBusy(true);
    const response = await postAuthed("/api/offers", {
      action: "report",
      propertyId: property.id,
      amount,
    });
    const body = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) {
      window.alert(body.error || "Could not save the offer");
      return;
    }
    window.alert(
      body.offer?.status === "awaiting_agent"
        ? "Saved. We've asked the agent to confirm it."
        : "Saved."
    );
    onChanged();
  }

  return (
    <button type="button" disabled={busy} onClick={report}>
      Offer accepted
    </button>
  );
}
