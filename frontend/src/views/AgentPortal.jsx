import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { apiUrl, siteUrl } from "../lib/platform";
import { listingKey } from "../../api/_lib/listing.js";
import { londonToUtc } from "../../api/_lib/time.js";
import { openProof, proofLabel } from "../components/PositionProof";
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

// Sign-up links carry the agency's code: /agent?code=BROOKS-7F3A2
function codeFromLink() {
  const params = new URLSearchParams(window.location.search);
  return (params.get("code") || "").trim().toUpperCase();
}

function AgentAuth() {
  const [linkCode] = useState(codeFromLink);
  const [mode, setMode] = useState(() =>
    linkCode || new URLSearchParams(window.location.search).get("mode") === "signup" ? "signup" : "login"
  );
  const [form, setForm] = useState({
    name: "",
    agency: "",
    branch: "",
    phone: "",
    email: "",
    password: "",
    code: linkCode,
    website: "",
  });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  // The agency and branch a valid code belongs to (shown, and fixed on the
  // form: the code decides them, since pricing is per branch).
  const [codeAgency, setCodeAgency] = useState("");
  const [codeBranch, setCodeBranch] = useState("");
  // Every seat on the code is taken: ask for a place instead of signing up.
  const [full, setFull] = useState(false);
  const [requested, setRequested] = useState(false);

  useEffect(() => {
    if (!linkCode) return;
    (async () => {
      const response = await fetch(apiUrl(`/api/agent-signup?code=${encodeURIComponent(linkCode)}`));
      const body = await response.json().catch(() => ({}));
      if (response.ok && body.agency) {
        setCodeAgency([body.agency, body.branch].filter(Boolean).join(" · "));
        setCodeBranch(body.branch || "");
        setFull(Boolean(body.full));
        setForm((current) => ({
          ...current,
          agency: body.agency,
          branch: body.branch || current.branch,
        }));
      } else {
        setMessage(body.error || "That sign-up link isn't valid any more.");
      }
    })();
  }, [linkCode]);

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function logIn(email, password) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  }

  async function requestSeat() {
    const response = await fetch(apiUrl("/api/agent-signup"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...form, password: undefined, action: "request_seat" }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || "Could not send your request");
    if (body.available) {
      // A seat came free (or was added): sign up as normal.
      setFull(false);
      setMessage("There's a place for you now. Choose a password and create your account.");
      return;
    }
    setRequested(true);
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");

    try {
      if (mode === "signup" && full) {
        await requestSeat();
      } else {
        if (mode === "signup") {
          const response = await fetch(apiUrl("/api/agent-signup"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(form),
          });
          const body = await response.json().catch(() => ({}));
          if (response.status === 409 && body.full) {
            setFull(true);
            throw new Error(body.error);
          }
          if (!response.ok) throw new Error(body.error || "Could not create your account");
        }
        await logIn(form.email.trim(), form.password);
      }
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
        {mode === "signup" && codeAgency && !full && (
          <p className="agent-joining">
            Joining as <strong>{codeAgency}</strong>
          </p>
        )}
        {mode === "signup" && full && !requested && (
          <p className="agent-joining agent-full">
            <strong>{codeAgency || "Your agency"}</strong> has used all its places on
            PropertySearch. Add your details and request a place: once it's added, use the same
            link to sign up.
          </p>
        )}
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

        {mode === "signup" && requested ? (
          <div className="agent-requested" role="status">
            <h3>Request sent</h3>
            <p>
              We'll add a place for {codeAgency || "your agency"} and let you know at{" "}
              <strong>{form.email}</strong>. Then open the same sign-up link again to create your
              account.
            </p>
          </div>
        ) : (
        <form className="booking-form" onSubmit={submit}>
          {mode === "signup" && (
            <div className="booking-form-grid">
              <label>
                Your name *
                <input required maxLength={100} value={form.name} onChange={update("name")} />
              </label>
              <label>
                Agency *
                <input
                  required
                  maxLength={100}
                  value={form.agency}
                  onChange={update("agency")}
                  readOnly={Boolean(codeAgency)}
                />
              </label>
              <label>
                Branch
                <input
                  maxLength={100}
                  value={form.branch}
                  onChange={update("branch")}
                  readOnly={Boolean(codeBranch)}
                />
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
            {!(mode === "signup" && full) && (
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
            )}
            {mode === "signup" && (
              <label>
                Sign-up code *
                <input
                  required
                  maxLength={40}
                  autoCapitalize="characters"
                  placeholder="e.g. BROOKS-7F3A2"
                  value={form.code}
                  onChange={update("code")}
                />
                <span className="field-hint">
                  Your branch's code from PropertySearch. No code?{" "}
                  <a href="/agents#get-a-code">Ask for one</a>.
                </span>
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
            {busy
              ? "Please wait..."
              : mode === "signup"
                ? full
                  ? "Request a place"
                  : "Create account"
                : "Log in"}
          </button>
        </form>
        )}
      </section>

      <p className="muted agent-auth-foot">
        New to PropertySearch? <a href="/agents">See how it works for agents</a>.
      </p>
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

// Postcode with or without the space: "SW17 0AB", "sw170ab".
const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?\s*[0-9][A-Z]{2}$/i;

const EMPTY_LISTING = {
  url: "",
  address: "",
  postcode: "",
  price: "",
  bedrooms: "",
  property_type: "",
  has_garden: "",
  image_url: "",
  notes: "",
};

function listingToForm(listing) {
  return {
    url: listing.listing_url,
    address: listing.address,
    postcode: listing.postcode || "",
    price: listing.price ?? "",
    bedrooms: listing.bedrooms ?? "",
    property_type: listing.property_type || "",
    has_garden: listing.has_garden == null ? "" : listing.has_garden ? "yes" : "no",
    image_url: listing.image_url || "",
    notes: listing.notes || "",
  };
}

function formToRow(form) {
  const price = Number(String(form.price).replace(/[^0-9]/g, ""));
  return {
    listing_url: form.url.trim(),
    address: form.address.trim(),
    postcode: form.postcode.trim().toUpperCase().replace(/\s+/g, " ") || null,
    price: price > 0 ? price : null,
    bedrooms: form.bedrooms === "" ? null : Number(form.bedrooms),
    property_type: form.property_type || null,
    has_garden: form.has_garden === "" ? null : form.has_garden === "yes",
    image_url: form.image_url.trim() || null,
    notes: form.notes.trim() || null,
  };
}

async function locatePostcode(postcode) {
  try {
    await postAuthed("/api/lookup", { action: "postcode", postcode });
  } catch {
    // Matching falls back to the postcode district.
  }
}

// "12 buyers match" while the agent fills the form. Count only, never who.
function useMatchCount(row) {
  const [count, setCount] = useState(null);
  const ready = POSTCODE_RE.test(row.postcode || "");

  useEffect(() => {
    if (!ready) {
      setCount(null);
      return undefined;
    }
    const timer = setTimeout(async () => {
      // Cache where the postcode is, so distance and map searches count too.
      await locatePostcode(row.postcode);
      const { data, error } = await supabase.rpc("count_matching_buyers", {
        p_postcode: row.postcode,
        p_price: row.price,
        p_bedrooms: row.bedrooms,
        p_property_type: row.property_type,
        p_has_garden: row.has_garden,
      });
      setCount(error ? null : data);
    }, 400);
    return () => clearTimeout(timer);
  }, [ready, row.postcode, row.price, row.bedrooms, row.property_type, row.has_garden]);

  return count;
}

function ListingForm({ agentId, listing, onSaved, onCancel }) {
  const [form, setForm] = useState(listing ? listingToForm(listing) : EMPTY_LISTING);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const row = formToRow(form);
  const matchCount = useMatchCount(row);

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!listingKey(form.url)) {
      setError("Paste the full Rightmove, Zoopla or OnTheMarket link for the listing.");
      return;
    }
    if (!POSTCODE_RE.test(form.postcode.trim())) {
      setError("Add the full postcode, e.g. SW17 0AB. It's how we find matching buyers.");
      return;
    }
    if (row.image_url && !/^https:\/\//i.test(row.image_url)) {
      setError("The photo link should start with https://");
      return;
    }

    setBusy(true);
    const { error: saveError } = listing
      ? await supabase.from("agent_listings").update(row).eq("id", listing.id)
      : await supabase.from("agent_listings").insert({ ...row, agent_id: agentId });
    setBusy(false);

    if (saveError) {
      setError(saveError.code === "23505" ? "You've already added this listing." : saveError.message);
      return;
    }

    if (!listing) setForm(EMPTY_LISTING);
    onSaved();
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
          Postcode *
          <input
            required
            maxLength={10}
            autoCapitalize="characters"
            placeholder="SW17 0AB"
            value={form.postcode}
            onChange={update("postcode")}
          />
        </label>
        <label>
          Asking price
          <input inputMode="numeric" placeholder="£" value={form.price} onChange={update("price")} />
        </label>
        <label>
          Bedrooms
          <select value={form.bedrooms} onChange={update("bedrooms")}>
            <option value="">Not set</option>
            {[0, 1, 2, 3, 4, 5, 6].map((n) => (
              <option key={n} value={n}>
                {n === 0 ? "Studio" : n === 6 ? "6+" : n}
              </option>
            ))}
          </select>
        </label>
        <label>
          Type
          <select value={form.property_type} onChange={update("property_type")}>
            <option value="">Not set</option>
            <option value="house">House</option>
            <option value="flat">Flat</option>
            <option value="bungalow">Bungalow</option>
          </select>
        </label>
        <label>
          Garden
          <select value={form.has_garden} onChange={update("has_garden")}>
            <option value="">Not set</option>
            <option value="yes">Yes</option>
            <option value="no">No</option>
          </select>
        </label>
        <label className="agent-wide">
          Main photo link
          <input
            type="url"
            placeholder="https://... (right-click the main photo, Copy image address)"
            value={form.image_url}
            onChange={update("image_url")}
          />
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

      <p className="agent-match-preview" aria-live="polite">
        {matchCount === null
          ? "Add the postcode to see how many buyers this matches."
          : matchCount === 0
            ? "No buyers' searches match this yet. You can still share your booking link."
            : `${matchCount} buyer${matchCount === 1 ? "" : "s"} on PropertySearch match${matchCount === 1 ? "es" : ""} this.`}
      </p>

      {error && <p className="booking-error">{error}</p>}
      <div className="delete-account-actions">
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Saving..." : listing ? "Save details" : "Add listing"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

// Send to every matching buyer who hasn't had it yet.
function ListingReach({ listing, reach, onSent }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  if (!listing.is_active) return null;
  if (!listing.postcode) {
    return (
      <p className="agent-reach muted">
        Add the postcode (Edit details) to send this to matching buyers.
      </p>
    );
  }

  const matching = reach?.matching ?? 0;
  const sent = reach?.sent ?? 0;

  async function send() {
    setBusy(true);
    setMessage("");
    try {
      const response = await postAuthed("/api/send-listing", { listingId: listing.id });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not send");
      setMessage(
        body.sent
          ? `Sent to ${body.sent} buyer${body.sent === 1 ? "" : "s"}.`
          : "Everyone who matches has already had it."
      );
      onSent();
    } catch (err) {
      setMessage(err.message);
    }
    setBusy(false);
  }

  return (
    <div className="agent-reach">
      <p>
        <strong>
          {matching} matching buyer{matching === 1 ? "" : "s"}
        </strong>
        {sent ? ` · sent to ${sent}` : ""}
      </p>
      {matching > 0 && (
        <button type="button" className="primary-button" disabled={busy} onClick={send}>
          {busy
            ? "Sending..."
            : sent
              ? "Send to new matches"
              : `Send to ${matching} buyer${matching === 1 ? "" : "s"}`}
        </button>
      )}
      {message && <p className="muted">{message}</p>}
    </div>
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

// A buyer's own "ready to proceed" declaration (migration 015), if they
// share it with agents they book with.
const SELLING_TEXT = {
  first_time: "first-time buyer",
  nothing_to_sell: "nothing to sell",
  sold_stc: "own home sold STC",
  on_market: "own home on the market",
  not_listed: "needs to sell, not listed",
};
const MOVE_TEXT = { asap: "moving ASAP", "3_months": "within 3 months", "6_months": "within 6 months" };

function shortPounds(amount) {
  if (!amount) return "";
  if (amount >= 1000000) return `£${Number((amount / 1000000).toFixed(2))}m`;
  return `£${Math.round(amount / 1000)}k`;
}

function BuyerPosition({ position }) {
  if (!position) return <span className="buyer-position-tag muted">No buying position shared</span>;
  let funding = "";
  if (position.buying_with === "cash") funding = "cash buyer";
  else if (position.mortgage_status === "offer")
    funding = `mortgage offer${position.aip_amount ? ` ${shortPounds(position.aip_amount)}` : ""}`;
  else if (position.mortgage_status === "aip")
    funding = `AIP${position.aip_amount ? ` ${shortPounds(position.aip_amount)}` : ""}${
      position.aip_lender ? ` (${position.aip_lender})` : ""
    }`;
  else if (position.buying_with === "mortgage") funding = "mortgage not arranged";

  const facts = [
    position.max_budget ? `budget ${shortPounds(position.max_budget)}` : "",
    funding,
    SELLING_TEXT[position.selling_status] || "",
    position.solicitor_ready ? "solicitor ready" : "",
    MOVE_TEXT[position.move_timeframe] || "",
  ].filter(Boolean);
  const updated = new Date(position.updated_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
  });

  return (
    <span className={`buyer-position-tag ${position.proceedable ? "ready" : ""}`}>
      {position.proceedable ? "✓ Proceedable · " : ""}
      {facts.join(" · ")}
      <span className="muted"> (buyer's own declaration, {updated})</span>
      {position.proof_path && (
        <>
          {" "}
          <button
            type="button"
            className="link-button proof-link"
            onClick={() => openProof(position.proof_path)}
            title="Uploaded by the buyer; not checked by PropertySearch"
          >
            📄 View {proofLabel(position)}
          </button>
        </>
      )}
    </span>
  );
}

// Offers buyers say this agent accepted: confirm or correct them.
function OfferRequests({ offers, positions, onChanged }) {
  const [busy, setBusy] = useState(null);
  if (!offers.length) return null;

  async function respond(offer, confirm) {
    setBusy(offer.offer_id);
    const response = await postAuthed("/api/offers", {
      action: "respond",
      offerId: offer.offer_id,
      confirm,
    });
    const body = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok) window.alert(body.error || "Something went wrong");
    onChanged();
  }

  return (
    <section className="card agent-offers">
      <h3>Accepted offers</h3>
      <p className="muted">
        Buyers who say you've accepted their offer. Confirm it, or say if it's wrong.
      </p>
      <ul>
        {offers.map((offer) => (
          <li key={offer.offer_id} className={`agent-offer offer-${offer.status}`}>
            <div>
              <strong>{offer.address}</strong> · £{Number(offer.amount).toLocaleString("en-GB")}
              <br />
              {offer.buyer_name} · <a href={`mailto:${offer.buyer_email}`}>{offer.buyer_email}</a>
              <br />
              <BuyerPosition position={positions[offer.buyer_id]} />
            </div>
            <div className="agent-offer-actions">
              {offer.status === "awaiting_agent" ? (
                <>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={busy === offer.offer_id}
                    onClick={() => respond(offer, true)}
                  >
                    Confirm
                  </button>
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy === offer.offer_id}
                    onClick={() => respond(offer, false)}
                  >
                    Not right
                  </button>
                </>
              ) : (
                <>
                  <span className="muted">
                    {offer.status === "confirmed" ? "✓ Confirmed" : "Marked not right"}
                  </span>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy === offer.offer_id}
                    onClick={() => respond(offer, offer.status !== "confirmed")}
                  >
                    {offer.status === "confirmed" ? "Mark not right" : "Confirm instead"}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SlotRow({ slot, bookings, positions, onChanged }) {
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
            {booking.buyer_id && (
              <>
                <br />
                <BuyerPosition position={positions[booking.buyer_id]} />
              </>
            )}
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
  const url = `${siteUrl}/viewings/${listing.id}`;
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

function listingFacts(listing) {
  return [
    listing.postcode,
    listing.price ? `£${listing.price.toLocaleString("en-GB")}` : "",
    listing.bedrooms != null ? (listing.bedrooms === 0 ? "studio" : `${listing.bedrooms} bed`) : "",
    listing.property_type || "",
    listing.has_garden ? "garden" : listing.has_garden === false ? "no garden" : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

function ListingCard({ listing, slots, bookingsBySlot, positions, agentId, reach, onChanged }) {
  const [adding, setAdding] = useState(slots.length === 0);
  const [editing, setEditing] = useState(false);

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
        {listing.image_url && <img className="agent-listing-photo" src={listing.image_url} alt="" />}
        <div>
          <h3>{listing.address}</h3>
          <p className="muted">
            {listingFacts(listing) ? `${listingFacts(listing)} · ` : ""}
            <a href={listing.listing_url} target="_blank" rel="noreferrer">
              View listing
            </a>
            {listing.notes ? ` · ${listing.notes}` : ""}
          </p>
        </div>
        <div className="agent-listing-buttons">
          <button type="button" className="secondary-button" onClick={() => setEditing(!editing)}>
            {editing ? "Close" : "Edit details"}
          </button>
          <button type="button" className="secondary-button" onClick={toggleActive}>
            {listing.is_active ? "Hide from buyers" : "Show to buyers"}
          </button>
        </div>
      </div>

      {editing && (
        <ListingForm
          agentId={agentId}
          listing={listing}
          onSaved={() => {
            setEditing(false);
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      <ListingReach listing={listing} reach={reach} onSent={onChanged} />

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
                  positions={positions}
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

// First-run checklist for a new agent: list a home, publish times, send it
// to matching buyers. Ticks itself off from what's saved; hidden once done
// or when the agent hides it (remembered on this device).
function AgentGettingStarted({ agentId, listings, slots, reach }) {
  const key = `agentStartHidden:${agentId}`;
  const [hidden, setHidden] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });

  const steps = [
    {
      id: "listing",
      title: "Add your first listing",
      text: "Paste its Rightmove, Zoopla or OnTheMarket link and the postcode. We show you how many buyers it matches.",
      done: listings.length > 0,
      target: "agent-add-listing",
      action: "Add a listing",
    },
    {
      id: "times",
      title: "Publish viewing times",
      text: "Add the slots you can show it. Buyers who've saved the home book straight in, and you get a calendar invite.",
      done: slots.length > 0,
      target: "agent-listings",
      action: "Add times",
    },
    {
      id: "send",
      title: "Send it to matching buyers",
      text: "One tap sends the listing to buyers whose search it fits. You see how many, never who, until they book.",
      done: Object.values(reach).some((r) => (r?.sent || 0) > 0),
      target: "agent-listings",
      action: "Go to your listing",
    },
  ];
  const doneCount = steps.filter((step) => step.done).length;
  if (hidden || doneCount === steps.length) return null;

  function hide() {
    try {
      localStorage.setItem(key, "1");
    } catch {
      // Private browsing: shows again next time.
    }
    setHidden(true);
  }

  function go(target) {
    document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <section className="card getting-started" aria-labelledby="agent-start-title">
      <div className="section-header">
        <div>
          <h2 id="agent-start-title">Get your first viewing booked</h2>
          <p>
            {doneCount} of {steps.length} done. About five minutes.
          </p>
        </div>
        <button type="button" className="link-button" onClick={hide}>
          Hide
        </button>
      </div>
      <div className="getting-started-bar" aria-hidden="true">
        <span style={{ width: `${(doneCount / steps.length) * 100}%` }} />
      </div>
      <ol className="getting-started-steps">
        {steps.map((step) => (
          <li key={step.id} className={step.done ? "done" : ""}>
            <span className="step-tick" aria-hidden="true">
              {step.done ? "✓" : ""}
            </span>
            <div className="step-text">
              <strong>
                {step.title}
                {step.done && <span className="visually-hidden"> (done)</span>}
              </strong>
              {!step.done && <p>{step.text}</p>}
            </div>
            {!step.done && (
              <button
                type="button"
                className="secondary-button"
                disabled={step.id !== "listing" && listings.length === 0}
                onClick={() => go(step.target)}
              >
                {step.action}
              </button>
            )}
          </li>
        ))}
      </ol>
    </section>
  );
}

function AgentDashboard({ agent }) {
  const [listings, setListings] = useState([]);
  const [slots, setSlots] = useState([]);
  const [bookings, setBookings] = useState([]);
  const [reach, setReach] = useState({});
  const [offers, setOffers] = useState([]);
  const [positions, setPositions] = useState({});
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    const [listingsResult, slotsResult, bookingsResult, reachResult, offersResult, positionsResult] =
      await Promise.all([
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
      supabase.rpc("agent_listing_reach"),
      supabase.rpc("agent_offers"),
      supabase.rpc("agent_buyer_positions"),
    ]);
    setOffers(offersResult.data || []);
    setPositions(Object.fromEntries((positionsResult.data || []).map((p) => [p.buyer_id, p])));
    const reachMap = {};
    for (const r of reachResult.data || []) reachMap[r.listing_id] = r;
    setReach(reachMap);
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

      {!loading && (
        <AgentGettingStarted agentId={agent.user_id} listings={listings} slots={slots} reach={reach} />
      )}

      <OfferRequests offers={offers} positions={positions} onChanged={load} />

      <section className="card" id="agent-add-listing">
        <h3>Add a listing</h3>
        <ListingForm agentId={agent.user_id} onSaved={load} />
      </section>

      <div id="agent-listings" />
      {loading ? (
        <p className="muted">Loading...</p>
      ) : (
        listings.map((listing) => (
          <ListingCard
            key={listing.id}
            listing={listing}
            slots={slotsByListing[listing.id] || []}
            bookingsBySlot={bookingsBySlot}
            positions={positions}
            agentId={agent.user_id}
            reach={reach[listing.id]}
            onChanged={load}
          />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Account deletion (Apple requires it for apps with sign-up).

function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function remove() {
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/delete-account", { confirm: typed });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not delete your account");
      await supabase.auth.signOut({ scope: "local" });
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <section className="card delete-account">
      <h3>Delete account</h3>
      {!open ? (
        <>
          <p className="muted">
            Permanently deletes your profile, listings and viewing times. Buyers with upcoming
            viewings are emailed that they're cancelled.
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
              disabled={typed !== "DELETE" || busy}
              onClick={remove}
            >
              {busy ? "Deleting..." : "Delete permanently"}
            </button>
            <button type="button" onClick={() => setOpen(false)} disabled={busy}>
              Keep my account
            </button>
          </div>
        </>
      )}
    </section>
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
          <>
            <AgentProfileForm user={user} onCreated={loadAgent} />
            <DeleteAccount />
          </>
        ) : (
          <>
            <AgentDashboard agent={agent} />
            <DeleteAccount />
          </>
        )}
      </main>
      <footer className="app-footer muted">
        <a href="/privacy">Privacy policy</a>
      </footer>
    </div>
  );
}

export default AgentPortal;
