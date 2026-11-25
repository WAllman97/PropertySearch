import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";
import ViewingRequest from "./ViewingRequest";
import "../views/AgentPortal.css";

// Viewing times that agents have published for homes the household saved
// (migration 006). Buyers pick a time and it's booked instantly.

const dayFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
});
const timeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Loads every open slot for the household's saved homes, grouped by
// property, and each home's latest viewing request to an agent who isn't on
// ViewPal (migration 023).
export function useAvailableViewings() {
  const [byProperty, setByProperty] = useState({});
  const [requestsByProperty, setRequestsByProperty] = useState({});

  const reload = useCallback(async () => {
    const [slots, requests] = await Promise.all([
      supabase.rpc("available_viewings"),
      supabase
        .from("viewing_requests")
        // Named columns: the agent's private link (token) isn't readable by
        // the household (migration 032), so "*" would be refused.
        .select(
          "id, household_id, property_id, requested_by, buyer_name, buyer_email, buyer_phone, agent_email, agent_name, message, options, duration_minutes, status, confirmed_start, proposed_start, agent_note, created_at, responded_at, updated_at, buyer_token"
        )
        .neq("status", "cancelled")
        .order("created_at", { ascending: false }),
    ]);
    // Before a migration is run its function or table doesn't exist: show nothing.
    if (!slots.error) {
      const map = {};
      for (const row of slots.data || []) (map[row.property_id] ||= []).push(row);
      setByProperty(map);
    }
    if (!requests.error) {
      const latest = {};
      for (const row of requests.data || []) latest[row.property_id] ||= row;
      setRequestsByProperty(latest);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { byProperty, requestsByProperty, reload };
}

function ViewingSlots({ property, slots, request, onChanged }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [phone, setPhone] = useState(() => {
    try {
      return localStorage.getItem("viewing-phone") || "";
    } catch {
      return "";
    }
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const mine = slots?.find((slot) => slot.my_booking_id);
  const bookable = (slots || []).filter((slot) => slot.booked < slot.capacity);

  const days = useMemo(() => {
    const groups = new Map();
    for (const slot of bookable) {
      const day = dayFormatter.format(new Date(slot.starts_at));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(slot);
    }
    return [...groups.entries()];
  }, [bookable]);

  // No agent on ViewPal for this home (or no times left): ask the
  // agent by email instead.
  if (!slots?.length || (!mine && !bookable.length)) {
    return <ViewingRequest property={property} request={request} onChanged={onChanged} />;
  }

  const agent = slots[0];
  const agentText = [agent.agent_name, agent.agency].filter(Boolean).join(", ");

  async function send(body) {
    setBusy(true);
    setMessage("");
    try {
      const response = await postAuthed("/api/viewings", body);
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        setMessage(result.error || "Something went wrong");
        onChanged();
        return false;
      }
      return true;
    } catch (err) {
      // Network dropped: say so rather than leaving "Booking..." up forever.
      setMessage(friendlyError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function book(event) {
    event.stopPropagation();
    try {
      localStorage.setItem("viewing-phone", phone);
    } catch {
      // Private mode: just don't remember it.
    }
    const ok = await send({ action: "book", slotId: selected.slot_id, propertyId: property.id, phone });
    if (ok) {
      setSelected(null);
      setOpen(false);
      onChanged();
    }
  }

  async function cancel(event) {
    event.stopPropagation();
    if (!window.confirm("Cancel this viewing? The agent will be emailed.")) return;
    if (await send({ action: "cancel", bookingId: mine.my_booking_id })) onChanged();
  }

  if (mine) {
    return (
      <div className="viewing-slots" onClick={(event) => event.stopPropagation()}>
        <div className="viewing-booked">
          <span>
            <strong>Viewing booked</strong>{" "}
            {dayFormatter.format(new Date(mine.starts_at))},{" "}
            {timeFormatter.format(new Date(mine.starts_at))}
            {mine.capacity > 1 ? " (open house)" : ""} · {agentText}
          </span>
          <button type="button" className="link-button" disabled={busy} onClick={cancel}>
            Cancel
          </button>
        </div>
        {mine.listing_notes && <p className="viewing-note">{mine.listing_notes}</p>}
        {message && <p className="booking-error">{message}</p>}
      </div>
    );
  }

  return (
    <div className="viewing-slots" onClick={(event) => event.stopPropagation()}>
      <div className="viewing-slots-head">
        <span>
          <strong>Book a viewing</strong> · {bookable.length} time{bookable.length === 1 ? "" : "s"}{" "}
          from {dayFormatter.format(new Date(bookable[0].starts_at))}
        </span>
        <button type="button" className="link-button" onClick={() => setOpen(!open)}>
          {open ? "Hide times" : "See times"}
        </button>
      </div>

      {open && (
        <>
          <p className="viewing-note">
            Published by {agentText}. Booking is instant and goes in your calendar.
            {agent.listing_notes ? ` ${agent.listing_notes}` : ""}
          </p>

          {days.map(([day, daySlots]) => (
            <div key={day} className="viewing-day">
              <h5>{day}</h5>
              <div className="viewing-times">
                {daySlots.map((slot) => (
                  <button
                    type="button"
                    key={slot.slot_id}
                    className={selected?.slot_id === slot.slot_id ? "selected" : ""}
                    onClick={() => setSelected(slot)}
                  >
                    {timeFormatter.format(new Date(slot.starts_at))}
                    {slot.capacity > 1 && (
                      <small>
                        open house · {slot.capacity - slot.booked} left
                      </small>
                    )}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {selected && (
            <div className="viewing-confirm">
              <label>
                Your phone (for the agent)
                <input
                  type="tel"
                  maxLength={40}
                  value={phone}
                  onChange={(event) => setPhone(event.target.value)}
                />
              </label>
              <button type="button" className="primary-button" disabled={busy} onClick={book}>
                {busy
                  ? "Booking..."
                  : `Book ${dayFormatter.format(new Date(selected.starts_at))}, ${timeFormatter.format(
                      new Date(selected.starts_at)
                    )}`}
              </button>
            </div>
          )}
        </>
      )}

      {message && <p className="booking-error">{message}</p>}
    </div>
  );
}

export default ViewingSlots;
