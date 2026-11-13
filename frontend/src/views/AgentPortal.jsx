import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { listingKey } from "../../api/_lib/listing.js";
import { londonToUtc } from "../../api/_lib/time.js";
import "./AgentPortal.css";

// Estate agent area at /agent: sign up or log in, add listings, publish
// viewing times, and see who has booked. Agents are separate accounts from
// the household and never see household data (see migration 006).

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

function timeRange(slot) {
  return `${timeFormatter.format(new Date(slot.starts_at))}–${timeFormatter.format(
    new Date(slot.ends_at)
  )}`;
}

function todayInputValue() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Sign up / log in

function AgentAuth() {
  const [mode, setMode] = useState("signup");
  const [form, setForm] = useState({
    name: "",
    agency: "",
    branch: "",
    phone: "",
    email: "",
    password: "",
    code: "",
    website: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function logIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      if (mode === "signup") {
        const response = await fetch("/api/agent-signup", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || "Could not create your account");
      }
      await logIn(form.email.trim(), form.password);
    } catch (error) {
      setMessage(error.message);
    }

    setBusy(false);
  }

  return (
    <div className="booking-shell">
      <header className="booking-header">
        <p className="eyebrow">For estate agents</p>
        <h1>Let buyers book viewings themselves</h1>
        <p className="muted">
          Add your listings and the times you can show them. Buyers who have the home saved in
          PropertySearch see those times and book straight in: no phone tag, and you get their
          details and a calendar invite for every booking.
        </p>
      </header>

      <section className="card agent-auth">
        <div className="booking-kind" role="tablist">
          <button
            type="button"
            className={mode === "signup" ? "primary" : ""}
            onClick={() => setMode("signup")}
          >
            Create agent account
          </button>
          <button
            type="button"
            className={mode === "login" ? "primary" : ""}
            onClick={() => setMode("login")}
          >
            Log in
          </button>
        </div>

        <form className="booking-form" onSubmit={submit}>
          {mode === "signup" && (
            <div className="booking-form-grid">
              <label>
                Your name *
                <input required maxLength={100} value={form.name} onChange={update("name")} />
              </label>
              <label>
                Agency *
                <input required maxLength={100} value={form.agency} onChange={update("agency")} />
              </label>
              <label>
                Branch
                <input maxLength={100} value={form.branch} onChange={update("branch")} />
              </label>
              <label>
                Phone (shown to buyers who book)
                <input type="tel" maxLength={40} value={form.phone} onChange={update("phone")} />
              </label>
            </div>
          )}

          <div className="booking-form-grid">
            <label>
              Work email *
              <input
                required
                type="email"
                autoComplete="email"
                value={form.email}
                onChange={update("email")}
              />
            </label>
            <label>
              Password *
              <input
                required
                type="password"
                minLength={mode === "signup" ? 8 : undefined}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
                value={form.password}
                onChange={update("password")}
              />
            </label>
            {mode === "signup" && (
              <label>
                Agency code (if you were given one)
                <input maxLength={100} value={form.code} onChange={update("code")} />
              </label>
            )}
          </div>

          <input
            className="booking-honeypot"
            tabIndex={-1}
            autoComplete="off"
            aria-hidden="true"
            value={form.website}
            onChange={update("website")}
          />

          {message && <p className="booking-error">{message}</p>}

          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Please wait..." : mode === "signup" ? "Create account" : "Log in"}
          </button>
        </form>
      </section>
    </div>
  );
}

// Signed in with an existing (e.g. household) account but no agent profile.
function AgentProfileForm({ user, onCreated }) {
  const [form, setForm] = useState({ name: "", agency: "", branch: "", phone: "" });
  const [error, setError] = useState("");
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    const { error: insertError } = await supabase.from("agents").insert({
      user_id: user.id,
      email: user.email,
      name: form.name.trim(),
      agency: form.agency.trim(),
      branch: form.branch.trim() || null,
      phone: form.phone.trim() || null,
    });
    if (insertError) setError(insertError.message);
    else onCreated();
  }

  return (
    <div className="booking-shell">
      <section className="card">
        <h2>Set up your agent profile</h2>
        <p className="muted">You're signed in as {user.email}.</p>
        <form className="booking-form" onSubmit={submit}>
          <div className="booking-form-grid">
            <label>
              Your name *
              <input required maxLength={100} value={form.name} onChange={update("name")} />
            </label>
            <label>
              Agency *
              <input required maxLength={100} value={form.agency} onChange={update("agency")} />
            </label>
            <label>
              Branch
              <input maxLength={100} value={form.branch} onChange={update("branch")} />
            </label>
            <label>
              Phone
              <input type="tel" maxLength={40} value={form.phone} onChange={update("phone")} />
            </label>
          </div>
          {error && <p className="booking-error">{error}</p>}
          <button type="submit" className="primary-button">
            Save profile
          </button>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard

function AddListingForm({ agentId, onAdded }) {
  const [form, setForm] = useState({ url: "", address: "", price: "", notes: "" });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!listingKey(form.url)) {
      setError("Paste the full Rightmove, Zoopla or OnTheMarket link for the listing.");
      return;
    }

    setBusy(true);
    const price = Number(String(form.price).replace(/[^0-9]/g, ""));
    const { error: insertError } = await supabase.from("agent_listings").insert({
      agent_id: agentId,
      listing_url: form.url.trim(),
      address: form.address.trim(),
      price: price > 0 ? price : null,
      notes: form.notes.trim() || null,
    });
    setBusy(false);

    if (insertError) {
      setError(
        insertError.code === "23505"
          ? "You've already added this listing."
          : insertError.message
      );
      return;
    }

    setForm({ url: "", address: "", price: "", notes: "" });
    onAdded();
  }

  return (
    <form className="booking-form agent-add-listing" onSubmit={submit}>
      <div className="booking-form-grid">
        <label className="agent-wide">
          Listing link *
          <input
            required
            type="url"
            placeholder="https://www.rightmove.co.uk/properties/..."
            value={form.url}
            onChange={update("url")}
          />
        </label>
        <label>
          Address *
          <input required maxLength={200} value={form.address} onChange={update("address")} />
        </label>
        <label>
          Asking price
          <input inputMode="numeric" placeholder="£" value={form.price} onChange={update("price")} />
        </label>
        <label className="agent-wide">
          Note for buyers
          <input
            maxLength={500}
            placeholder="e.g. Meet outside, street parking only"
            value={form.notes}
            onChange={update("notes")}
          />
        </label>
      </div>
      {error && <p className="booking-error">{error}</p>}
      <button type="submit" className="primary-button" disabled={busy}>
        {busy ? "Adding..." : "Add listing"}
      </button>
    </form>
  );
}

const LENGTHS = [15, 20, 30, 45, 60];

function AddTimesForm({ listing, agentId, onAdded }) {
  const [form, setForm] = useState({
    date: todayInputValue(),
    from: "10:00",
    to: "12:00",
    length: 15,
    kind: "private",
    capacity: 6,
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  // Private: back-to-back slots of `length` minutes. Open house: one slot
  // covering the whole window for up to `capacity` buyers.
  const planned = useMemo(() => {
    const [y, mo, d] = form.date.split("-").map(Number);
    const [fh, fm] = form.from.split(":").map(Number);
    const [th, tm] = form.to.split(":").map(Number);
    if (!y || Number.isNaN(fh) || Number.isNaN(th)) return [];
    const startMin = fh * 60 + fm;
    const endMin = th * 60 + tm;
    if (endMin <= startMin) return [];

    const at = (m) => londonToUtc(y, mo, d, Math.floor(m / 60), m % 60);

    if (form.kind === "open") {
      return [{ starts_at: at(startMin), ends_at: at(endMin), capacity: Number(form.capacity) }];
    }

    const length = Number(form.length);
    const slots = [];
    for (let m = startMin; m + length <= endMin; m += length) {
      slots.push({ starts_at: at(m), ends_at: at(m + length), capacity: 1 });
    }
    return slots;
  }, [form]);

  async function submit(event) {
    event.preventDefault();
    setError("");

    const future = planned.filter((slot) => slot.starts_at.getTime() > Date.now());
    if (!future.length) {
      setError("Pick a time in the future, with the end after the start.");
      return;
    }

    setBusy(true);
    const { error: insertError } = await supabase.from("viewing_slots").insert(
      future.map((slot) => ({
        listing_id: listing.id,
        agent_id: agentId,
        starts_at: slot.starts_at.toISOString(),
        ends_at: slot.ends_at.toISOString(),
        capacity: slot.capacity,
      }))
    );
    setBusy(false);

    if (insertError) setError(insertError.message);
    else onAdded();
  }

  return (
    <form className="agent-times-form" onSubmit={submit}>
      <div className="agent-times-row">
        <label>
          Date
          <input type="date" required value={form.date} onChange={update("date")} />
        </label>
        <label>
          From
          <input type="time" required step={300} value={form.from} onChange={update("from")} />
        </label>
        <label>
          To
          <input type="time" required step={300} value={form.to} onChange={update("to")} />
        </label>
        <label>
          Type
          <select value={form.kind} onChange={update("kind")}>
            <option value="private">Private viewings</option>
            <option value="open">Open house</option>
          </select>
        </label>
        {form.kind === "private" ? (
          <label>
            Each
            <select value={form.length} onChange={update("length")}>
              {LENGTHS.map((m) => (
                <option key={m} value={m}>
                  {m} min
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label>
            Buyers
            <input
              type="number"
              min={2}
              max={30}
              value={form.capacity}
              onChange={update("capacity")}
            />
          </label>
        )}
      </div>
      <div className="agent-times-actions">
        <button type="submit" className="primary-button" disabled={busy || !planned.length}>
          {busy
            ? "Adding..."
            : form.kind === "open"
              ? "Add open house"
              : `Add ${planned.length} viewing time${planned.length === 1 ? "" : "s"}`}
        </button>
        {error && <span className="booking-error">{error}</span>}
      </div>
    </form>
  );
}

function SlotRow({ slot, bookings, onChanged }) {
  const [busy, setBusy] = useState(false);
  const isOpenHouse = slot.capacity > 1;

  async function call(body, confirmText) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(true);
    const response = await postAuthed("/api/viewings", body);
    const result = await response.json().catch(() => ({}));
    setBusy(false);
    if (!response.ok) window.alert(result.error || "Something went wrong");
    onChanged();
  }

  async function removeSlot() {
    if (bookings.length) {
      await call(
        { action: "cancel_slot", slotId: slot.id },
        `Cancel this time? ${bookings.length} buyer${bookings.length === 1 ? "" : "s"} will be emailed that it's cancelled.`
      );
      return;
    }
    setBusy(true);
    const { error } = await supabase.from("viewing_slots").delete().eq("id", slot.id);
    setBusy(false);
    if (error) window.alert(error.message);
    onChanged();
  }

  return (
    <li className={`agent-slot ${bookings.length ? "booked" : ""}`}>
      <div className="agent-slot-main">
        <strong>{timeRange(slot)}</strong>
        <span className="muted">
          {isOpenHouse
            ? `Open house · ${bookings.length} of ${slot.capacity} booked`
            : bookings.length
              ? "Booked"
              : "Free"}
        </span>
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={removeSlot}
        >
          {bookings.length ? "Cancel time" : "Remove"}
        </button>
      </div>
      {bookings.map((booking) => (
        <div key={booking.id} className="agent-booking">
          <span>
            <strong>{booking.buyer_name}</strong>
            {!booking.buyer_id && <span className="agent-via"> via your link</span>}
            {booking.buyer_phone && (
              <>
                {" · "}
                <a href={`tel:${booking.buyer_phone}`}>{booking.buyer_phone}</a>
              </>
            )}
            {" · "}
            <a href={`mailto:${booking.buyer_email}`}>{booking.buyer_email}</a>
          </span>
          <button
            type="button"
            className="link-button"
            disabled={busy}
            onClick={() =>
              call(
                { action: "cancel", bookingId: booking.id },
                `Cancel ${booking.buyer_name}'s viewing? They'll get an email.`
              )
            }
          >
            Cancel booking
          </button>
        </div>
      ))}
    </li>
  );
}

// The public booking link for one listing, with quick ways to send it.
function ShareLink({ listing }) {
  const [copied, setCopied] = useState(false);
  const url = `${window.location.origin}/viewings/${listing.id}`;
  const text = `Book a viewing of ${listing.address} here: ${url}`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this link:", url);
    }
  }

  async function share() {
    try {
      await navigator.share({ title: `Viewings: ${listing.address}`, text, url });
    } catch {
      // Cancelled, or not supported: the other buttons still work.
    }
  }

  return (
    <div className="agent-share">
      <span className="agent-share-label">Send to buyers:</span>
      <a href={url} target="_blank" rel="noreferrer" className="agent-share-url">
        {url.replace(/^https?:\/\//, "")}
      </a>
      <div className="agent-share-buttons">
        <button type="button" className="secondary-button" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
        <a
          className="secondary-button"
          href={`https://wa.me/?text=${encodeURIComponent(text)}`}
          target="_blank"
          rel="noreferrer"
        >
          WhatsApp
        </a>
        <a
          className="secondary-button"
          href={`mailto:?subject=${encodeURIComponent(`Viewings: ${listing.address}`)}&body=${encodeURIComponent(
            `Hi,

You can book a viewing of ${listing.address} at a time that suits you here:
${url}

Thanks`
          )}`}
        >
          Email
        </a>
        {typeof navigator !== "undefined" && navigator.share && (
          <button type="button" className="secondary-button" onClick={share}>
            Share
          </button>
        )}
      </div>
    </div>
  );
}

function ListingCard({ listing, slots, bookingsBySlot, agentId, onChanged }) {
  const [adding, setAdding] = useState(slots.length === 0);

  const days = useMemo(() => {
    const groups = new Map();
    for (const slot of slots) {
      const day = dayFormatter.format(new Date(slot.starts_at));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(slot);
    }
    return [...groups.entries()];
  }, [slots]);

  async function toggleActive() {
    await supabase
      .from("agent_listings")
      .update({ is_active: !listing.is_active })
      .eq("id", listing.id);
    onChanged();
  }

  return (
    <section className={`card agent-listing ${listing.is_active ? "" : "paused"}`}>
      <div className="agent-listing-head">
        <div>
          <h3>{listing.address}</h3>
          <p className="muted">
            {listing.price ? `£${listing.price.toLocaleString("en-GB")} · ` : ""}
            <a href={listing.listing_url} target="_blank" rel="noreferrer">
              View listing
            </a>
            {listing.notes ? ` · ${listing.notes}` : ""}
          </p>
        </div>
        <button type="button" className="secondary-button" onClick={toggleActive}>
          {listing.is_active ? "Hide from buyers" : "Show to buyers"}
        </button>
      </div>

      {listing.is_active ? (
        <ShareLink listing={listing} />
      ) : (
        <p className="muted">Hidden: buyers can't see or book these times, and the link is off.</p>
      )}

      {days.length === 0 ? (
        <p className="muted">No upcoming viewing times yet.</p>
      ) : (
        days.map(([day, daySlots]) => (
          <div key={day} className="agent-day">
            <h4>{day}</h4>
            <ul className="agent-slots">
              {daySlots.map((slot) => (
                <SlotRow
                  key={slot.id}
                  slot={slot}
                  bookings={bookingsBySlot[slot.id] || []}
                  onChanged={onChanged}
                />
              ))}
            </ul>
          </div>
        ))
      )}

      {adding ? (
        <AddTimesForm
          listing={listing}
          agentId={agentId}
          onAdded={() => {
            setAdding(false);
            onChanged();
          }}
        />
      ) : (
        <button type="button" className="secondary-button" onClick={() => setAdding(true)}>
          Add viewing times
        </button>
      )}
    </section>
  );
}

function AgentDashboard({ agent }) {
  const [listings, setListings] = useState([]);
  const [slots, setSlots] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    const [listingsResult, slotsResult, bookingsResult] = await Promise.all([
      supabase.from("agent_listings").select("*").order("created_at", { ascending: false }),
      supabase
        .from("viewing_slots")
        .select("*")
        .is("cancelled_at", null)
        .gte("ends_at", since)
        .order("starts_at"),
      supabase
        .from("viewing_bookings")
        .select("*")
        .eq("status", "confirmed")
        .order("created_at"),
    ]);
    setListings(listingsResult.data || []);
    setSlots(slotsResult.data || []);
    setBookings(bookingsResult.data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const bookingsBySlot = useMemo(() => {
    const map = {};
    for (const booking of bookings) (map[booking.slot_id] ||= []).push(booking);
    return map;
  }, [bookings]);

  const slotsByListing = useMemo(() => {
    const map = {};
    for (const slot of slots) (map[slot.listing_id] ||= []).push(slot);
    return map;
  }, [slots]);

  const upcomingBooked = slots.filter((slot) => bookingsBySlot[slot.id]?.length).length;
  const bookedCount = slots.reduce((sum, slot) => sum + (bookingsBySlot[slot.id]?.length || 0), 0);

  return (
    <div className="agent-dashboard">
      <header className="agent-dashboard-head">
        <div>
          <p className="eyebrow">{[agent.agency, agent.branch].filter(Boolean).join(" · ")}</p>
          <h2>Viewings</h2>
          <p className="muted">
            {bookedCount
              ? `${bookedCount} buyer${bookedCount === 1 ? "" : "s"} booked across ${upcomingBooked} upcoming time${upcomingBooked === 1 ? "" : "s"}.`
              : "No bookings yet. Buyers who've saved one of your listings will see the times you add."}
          </p>
        </div>
      </header>

      <section className="card">
        <h3>Add a listing</h3>
        <AddListingForm agentId={agent.user_id} onAdded={load} />
      </section>

      {loading ? (
        <p className="muted">Loading...</p>
      ) : (
        listings.map((listing) => (
          <ListingCard
            key={listing.id}
            listing={listing}
            slots={slotsByListing[listing.id] || []}
            bookingsBySlot={bookingsBySlot}
            agentId={agent.user_id}
            onChanged={load}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function AgentPortal() {
  const [user, setUser] = useState(undefined);
  const [agent, setAgent] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setUser(session?.user ?? null));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  const loadAgent = useCallback(async () => {
    if (!user) {
      setAgent(null);
      return;
    }
    const { data } = await supabase.from("agents").select("*").eq("user_id", user.id).maybeSingle();
    setAgent(data || null);
  }, [user]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">PropertySearch for agents</p>
          <h1>{agent ? agent.name : "Viewing bookings"}</h1>
        </div>
        {user && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => supabase.auth.signOut({ scope: "local" })}
          >
            Log Out
          </button>
        )}
      </header>

      <main className="app-main">
        {user === undefined || (user && agent === undefined) ? (
          <p className="muted">Loading...</p>
        ) : !user ? (
          <AgentAuth />
        ) : !agent ? (
          <AgentProfileForm user={user} onCreated={loadAgent} />
        ) : (
          <AgentDashboard agent={agent} />
        )}
      </main>
    </div>
  );
}

export default AgentPortal;
