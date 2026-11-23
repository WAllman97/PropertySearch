import { useCallback, useEffect, useMemo, useState } from "react";
import { arrivedFromPasswordReset, supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import SetNewPasswordForm from "../components/SetNewPasswordForm";
import { apiUrl, siteUrl } from "../lib/platform";
import { listingKey } from "../../api/_lib/listing.js";
import { londonToUtc } from "../../api/_lib/time.js";
import { openProof, proofLabel } from "../components/PositionProof";
import AgentHours from "./AgentHours";
import { CheckYourEmail } from "../components/ConfirmEmail";
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
  // Good news, e.g. "a reset link is on its way" (message is for errors).
  const [notice, setNotice] = useState("");
  // The agency and branch a valid code belongs to (shown, and fixed on the
  // form: the code decides them, since pricing is per branch).
  const [codeAgency, setCodeAgency] = useState("");
  const [codeBranch, setCodeBranch] = useState("");
  // Every seat on the code is taken: ask for a place instead of signing up.
  const [full, setFull] = useState(false);
  const [requested, setRequested] = useState(false);
  // "signup": just signed up; "login": tried to log in before confirming.
  const [confirming, setConfirming] = useState(null);

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
    if (error?.code === "email_not_confirmed") {
      setConfirming("login");
      return;
    }
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

  function switchMode(next) {
    setMode(next);
    setMessage("");
    setNotice("");
  }

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    setNotice("");

    try {
      if (mode === "forgot") {
        // The emailed link brings them back to /agent, where AgentPortal sees
        // the recovery session and asks for a new password. /agent must be
        // allowed under Supabase -> Authentication -> URL Configuration ->
        // Redirect URLs (e.g. https://<site>/**), otherwise the Site URL is used.
        const { error } = await supabase.auth.resetPasswordForEmail(form.email.trim(), {
          redirectTo: `${siteUrl}/agent`,
        });
        if (error) {
          throw new Error(
            error.status === 429 ? "Too many attempts. Please wait a minute and try again." : error.message
          );
        }
        // Same message whether or not the account exists.
        setNotice("If that email has an account, a reset link is on its way. Check your inbox.");
      } else if (mode === "signup" && full) {
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
          // The account opens once they tap the link we've emailed.
          if (body.confirmEmail) {
            setConfirming("signup");
            setBusy(false);
            return;
          }
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
            onClick={() => switchMode("signup")}
          >
            Create agent account
          </button>
          <button
            type="button"
            className={mode === "signup" ? "" : "primary"}
            onClick={() => switchMode("login")}
          >
            Log in
          </button>
        </div>

        {confirming ? (
          <CheckYourEmail
            email={form.email.trim()}
            password={form.password}
            next="/agent"
            afterLogin={confirming === "login"}
            onBack={() => {
              setConfirming(null);
              setMode(confirming === "signup" ? "signup" : "login");
            }}
          />
        ) : mode === "signup" && requested ? (
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
            {!(mode === "signup" && full) && mode !== "forgot" && (
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

          {mode === "forgot" && (
            <p className="muted">Enter your work email and we'll send you a link to set a new password.</p>
          )}
          {message && <p className="booking-error">{message}</p>}
          {notice && (
            <p className="agent-joining" role="status">
              {notice}
            </p>
          )}

          <button type="submit" className="primary-button" disabled={busy}>
            {busy
              ? "Please wait..."
              : mode === "signup"
                ? full
                  ? "Request a place"
                  : "Create account"
                : mode === "forgot"
                  ? "Send reset link"
                  : "Log in"}
          </button>
          {mode !== "signup" && (
            <button
              type="button"
              className="link-button agent-forgot"
              onClick={() => switchMode(mode === "forgot" ? "login" : "forgot")}
            >
              {mode === "forgot" ? "Back to log in" : "Forgot password?"}
            </button>
          )}
        </form>
        )}
      </section>

      <p className="muted agent-auth-foot">
        New to PropertySearch? <a href="/agents">See how it works for agents</a>.
        <br />
        Buying a home? <a href="/">Log in to the buyer app</a>.
      </p>
    </div>
  );
}

// Signed in with an existing (e.g. household) account but no agent profile.
// Needs a branch sign-up code, the same as a new agent account: the server
// checks it, takes a seat and sets the agency and branch from it.
function AgentProfileForm({ user, onCreated }) {
  const [form, setForm] = useState({
    name: user.user_metadata?.name || "",
    agency: "",
    branch: "",
    phone: "",
    code: codeFromLink(),
  });
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });

  async function submit(event) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/agent-signup", { action: "add_profile", ...form });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not set up your agent profile");
      onCreated();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
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
              Phone (shown to buyers who book)
              <input type="tel" autoComplete="tel" maxLength={40} value={form.phone} onChange={update("phone")} />
            </label>
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
                Your branch's code sets your agency and branch. No code?{" "}
                <a href="/agents#get-a-code">Ask for one</a>.
              </span>
            </label>
          </div>
          {error && <p className="booking-error">{error}</p>}
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Setting up..." : "Set up agent profile"}
          </button>
        </form>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dashboard

// Postcode with or without the space ("SW17 0AB", "sw170ab"), or just the
// district ("SW17"): portals' link previews often only give the district,
// and matching works on the district (the full postcode only sharpens
// distance and map searches).
const POSTCODE_RE = /^[A-Z]{1,2}[0-9][0-9A-Z]?(\s*[0-9][A-Z]{2})?$/i;

// The portal's wording -> the agent form's House / Flat / Bungalow.
function agentPropertyType(details) {
  const text = `${details.description || ""} ${details.property_type || ""}`;
  if (/bungalow/i.test(text)) return "bungalow";
  if (details.property_type === "flat") return "flat";
  return details.property_type ? "house" : "";
}

// Fill in what the link preview found, without overwriting anything the
// agent has already typed.
function fillFromPreview(form, details) {
  const found = {
    address: details.address || "",
    postcode: details.postcode || "",
    price: details.price ?? "",
    bedrooms: details.bedrooms ?? "",
    property_type: agentPropertyType(details),
    has_garden: details.has_garden == null ? "" : details.has_garden ? "yes" : "no",
    image_url: details.image_url || "",
  };
  const next = { ...form };
  for (const [key, value] of Object.entries(found)) {
    if (next[key] === "" && value !== "") next[key] = String(value);
  }
  return next;
}

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
  // "" | "looking" | "filled" | "partial" | "blocked" | "failed"
  const [lookup, setLookup] = useState("");
  const [pasteHint, setPasteHint] = useState("");
  // Just added a listing: { listing, matches, sent?, sendError? }
  const [justAdded, setJustAdded] = useState(null);
  const [sending, setSending] = useState(false);

  // Paste the link and the rest fills itself in from the listing's link
  // preview, so the agent only checks it and taps Add.
  async function lookUp(link) {
    if (listing || !listingKey(link)) return;
    setLookup("looking");
    setError("");
    try {
      const response = await postAuthed("/api/lookup", { action: "listing", url: link, for: "agent" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.status !== "ok") {
        setLookup(body.status === "blocked" ? "blocked" : "failed");
        return;
      }
      const details = body.details || {};
      setForm((current) => fillFromPreview({ ...current, url: link }, details));
      setLookup(details.address && details.postcode && details.price ? "filled" : "partial");
    } catch {
      setLookup("failed");
    }
  }

  async function pasteLink() {
    setPasteHint("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const link = text.match(/https?:\/\/\S+/)?.[0];
      if (!link) {
        setPasteHint("No link copied. Copy the listing's address from Rightmove, Zoopla or OnTheMarket first.");
        return;
      }
      setForm((current) => ({ ...current, url: link }));
      lookUp(link);
    } catch {
      setPasteHint("Couldn't read the clipboard here. Click the box and paste instead.");
    }
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!listingKey(form.url)) {
      setError("Paste the full Rightmove, Zoopla or OnTheMarket link for the listing.");
      return;
    }
    if (!POSTCODE_RE.test(form.postcode.trim())) {
      setError("Add the postcode, e.g. SW17 0AB (or at least SW17). It's how we find matching buyers.");
      return;
    }
    if (row.image_url && !/^https:\/\//i.test(row.image_url)) {
      setError("The photo link should start with https://");
      return;
    }

    setBusy(true);
    // A lower price typed here counts as a reduction, same as "Reduce price".
    const cut =
      listing && row.price && listing.price && row.price < listing.price
        ? { previous_price: listing.price, price_reduced_at: new Date().toISOString() }
        : {};
    const { data: saved, error: saveError } = listing
      ? await supabase.from("agent_listings").update({ ...row, ...cut }).eq("id", listing.id).select().maybeSingle()
      : await supabase.from("agent_listings").insert({ ...row, agent_id: agentId }).select().single();
    setBusy(false);

    if (saveError) {
      setError(saveError.code === "23505" ? "You've already added this listing." : saveError.message);
      return;
    }

    // A new price goes straight to buyers who saved the home.
    if (listing && row.price && row.price !== listing.price) {
      const response = await postAuthed("/api/send-listing", { action: "price_update", listingId: listing.id });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.notified) {
        window.alert(
          `New price saved. ${result.notified} household${result.notified === 1 ? " that saved this home has" : "s that saved this home have"} been told.`
        );
      }
    }

    if (!listing) {
      setForm(EMPTY_LISTING);
      setLookup("");
      // Don't just reset: offer the obvious next step while the match
      // count is fresh.
      if (saved) setJustAdded({ listing: saved, matches: matchCount || 0 });
    }
    onSaved();
  }

  async function sendNow() {
    setSending(true);
    try {
      const response = await postAuthed("/api/send-listing", { listingId: justAdded.listing.id });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not send");
      setJustAdded({ ...justAdded, sent: body.sent || 0 });
      onSaved();
    } catch (err) {
      setJustAdded({ ...justAdded, sendError: err.message });
    }
    setSending(false);
  }

  // After adding: "Added. Send it to the 12 buyers it matches?"
  if (justAdded) {
    const { listing: added, matches, sent, sendError } = justAdded;
    return (
      <div className="agent-added" role="status">
        <p className="agent-added-title">
          ✅ Added <strong>{added.address}</strong>
        </p>
        {sent !== undefined ? (
          <p>
            {sent
              ? `Sent to ${sent} buyer${sent === 1 ? "" : "s"}. They can book a viewing in one tap.`
              : "Everyone who matches has already had it."}
          </p>
        ) : matches > 0 ? (
          <p>
            {matches} buyer{matches === 1 ? "" : "s"} on PropertySearch{" "}
            {matches === 1 ? "is" : "are"} looking for a home like this.
          </p>
        ) : (
          <p className="muted">
            No buyers' searches match it yet. Share its booking link from the card below.
          </p>
        )}
        {sendError && <p className="booking-error">{sendError}</p>}
        <div className="delete-account-actions">
          {matches > 0 && sent === undefined && (
            <button type="button" className="primary-button" disabled={sending} onClick={sendNow}>
              {sending ? "Sending..." : `Send to ${matches} buyer${matches === 1 ? "" : "s"}`}
            </button>
          )}
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setJustAdded(null);
              document.getElementById(`listing-${added.id}`)?.scrollIntoView({ behavior: "smooth" });
            }}
          >
            See it and its viewing times
          </button>
          <button type="button" className="link-button" onClick={() => setJustAdded(null)}>
            Add another
          </button>
        </div>
      </div>
    );
  }

  const lookupNote = {
    looking: "Getting the details from the listing...",
    filled: "Filled in from the listing. Check it and tap Add listing.",
    partial: "Filled in what the listing shows. Add anything missing below.",
    blocked: "That portal doesn't let us read the page, so add the details below.",
    failed: "We couldn't read that listing. Add the details below.",
  }[lookup];

  return (
    <form className="booking-form agent-add-listing" onSubmit={submit}>
      <div className="booking-form-grid">
        <label className="agent-wide">
          Listing link *
          <span className="save-link-input">
            <input
              required
              type="url"
              placeholder="Paste the Rightmove, Zoopla or OnTheMarket link"
              value={form.url}
              onChange={(event) => {
                setForm({ ...form, url: event.target.value });
                // A different link: look it up again when they leave the box.
                if (lookup !== "looking") setLookup("");
              }}
              // Pasting is the whole point: fill the rest in straight away.
              onPaste={(event) => {
                const pasted = event.clipboardData.getData("text").trim();
                if (pasted) setTimeout(() => lookUp(pasted), 0);
              }}
              onBlur={(event) => {
                if (!lookup) lookUp(event.target.value.trim());
              }}
            />
            {!listing && (
              <button
                type="button"
                className="secondary-button"
                disabled={lookup === "looking"}
                onClick={pasteLink}
              >
                Paste
              </button>
            )}
          </span>
        </label>
        {(lookupNote || pasteHint) && (
          <p
            className={`save-link-note agent-wide${lookup === "blocked" || lookup === "failed" ? " warn" : ""}`}
            aria-live="polite"
          >
            {pasteHint || lookupNote}
          </p>
        )}
        {form.image_url && /^https:\/\//i.test(form.image_url) && (
          <img className="save-link-photo agent-wide" src={form.image_url} alt="" />
        )}
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
        {/* Only needed when the listing didn't give us a photo. */}
        {(listing || !form.image_url) && (
          <label className="agent-wide">
            Main photo link
            <input
              type="url"
              placeholder="https://... (right-click the main photo, Copy image address)"
              value={form.image_url}
              onChange={update("image_url")}
            />
          </label>
        )}
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
  if (listing.market_status === "sold_stc" || listing.market_status === "off_market") return null;
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
    const { error } = await supabase.rpc("agent_remove_slots", { p_slots: [slot.id] });
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

// Free private times shown as small chips (there can be many with weekly
// hours). Tap × to remove one; blocked ones are times you're at another
// viewing (plus travel) or inside your shortest notice.
function FreeTimes({ slots, blocked, onChanged }) {
  const [busy, setBusy] = useState(false);

  async function remove(ids) {
    setBusy(true);
    const { error } = await supabase.rpc("agent_remove_slots", { p_slots: ids });
    setBusy(false);
    if (error) window.alert(error.message);
    onChanged();
  }

  return (
    <div className="agent-free">
      <ul className="agent-chips">
        {slots.map((slot) => {
          const isBlocked = blocked.has(slot.id);
          const time = timeFormatter.format(new Date(slot.starts_at));
          return (
            <li
              key={slot.id}
              className={`agent-chip ${isBlocked ? "blocked" : ""}`}
              title={isBlocked ? "Not offered: you're at another viewing then, or it's too short notice" : timeRange(slot)}
            >
              {time}
              <button
                type="button"
                aria-label={`Remove ${time}`}
                disabled={busy}
                onClick={() => remove([slot.id])}
              >
                ×
              </button>
            </li>
          );
        })}
      </ul>
      {slots.length > 1 && (
        <button
          type="button"
          className="link-button"
          disabled={busy}
          onClick={() => {
            if (window.confirm(`Remove all ${slots.length} free times on this day?`)) remove(slots.map((s) => s.id));
          }}
        >
          Clear free times
        </button>
      )}
    </div>
  );
}

const DAYS_SHOWN = 7;

const MARKET_STATUSES = [
  { value: "available", label: "For sale" },
  { value: "under_offer", label: "Under offer" },
  { value: "sold_stc", label: "Sold STC" },
  { value: "off_market", label: "Off market" },
];

const pounds = (n) => `£${Number(n).toLocaleString("en-GB")}`;

// Was the price cut in the last 30 days? Then show "Reduced" and the old price.
function recentlyReduced(listing) {
  return (
    listing.previous_price > listing.price &&
    listing.price_reduced_at &&
    Date.now() - new Date(listing.price_reduced_at).getTime() < 30 * 24 * 3600 * 1000
  );
}

// "Updated 2 buyers' lists" after a status or price change.
function reachedText(result, what) {
  if (!result?.updated) return `${what} saved.`;
  const n = result.notified || result.updated;
  return `${what} saved. ${n} buyer household${n === 1 ? " that saved this home has" : "s that saved this home have"} been told.`;
}

// For sale / Under offer / Sold STC / Off market, plus "Reduce price".
// Both are passed straight on to buyers who saved the home.
function ListingStatus({ listing, agentId, upcomingBookings = [], onChanged }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [reducing, setReducing] = useState(false);
  const [newPrice, setNewPrice] = useState("");
  const status = listing.market_status || "available";

  async function setStatus(value) {
    if (value === status || busy) return;
    setBusy(true);
    setMessage("");
    const { error } = await supabase.from("agent_listings").update({ market_status: value }).eq("id", listing.id);
    if (error) {
      setMessage(
        /market_status/.test(error.message)
          ? "Statuses aren't switched on yet (database migration 024 needs running)."
          : error.message
      );
      setBusy(false);
      return;
    }
    // Weekly-hours times follow the status: gone while sold or off the
    // market, back when it's on the market again (migration 026).
    await supabase.rpc("sync_pattern_slots", { p_agent: agentId });

    let note = "";
    try {
      const response = await postAuthed("/api/send-listing", { action: "status_update", listingId: listing.id });
      const result = await response.json().catch(() => ({}));
      const label = MARKET_STATUSES.find((s) => s.value === value).label;
      note = response.ok ? reachedText(result, label) : result.error || `${label} saved.`;
    } catch {
      note = "Saved, but buyers' lists couldn't be updated just now.";
    }

    // Sold or withdrawn with viewings still booked: offer to cancel them
    // (each buyer is emailed).
    const closing = value === "sold_stc" || value === "off_market";
    if (closing && upcomingBookings.length) {
      const n = upcomingBookings.length;
      if (window.confirm(`${n} viewing${n === 1 ? " is" : "s are"} still booked on this home. Cancel ${n === 1 ? "it" : "them"} and let the buyer${n === 1 ? "" : "s"} know?`)) {
        const results = await Promise.all(
          upcomingBookings.map((b) =>
            postAuthed("/api/viewings", { action: "cancel", bookingId: b.id })
              .then((r) => r.ok)
              .catch(() => false)
          )
        );
        const done = results.filter(Boolean).length;
        note += ` ${done} viewing${done === 1 ? "" : "s"} cancelled and the buyer${done === 1 ? " has" : "s have"} been told.`;
      }
    }
    setMessage(note);
    setBusy(false);
    onChanged();
  }

  async function reducePrice(event) {
    event.preventDefault();
    const price = Number(String(newPrice).replace(/[^0-9]/g, ""));
    if (!price || !listing.price || price >= listing.price) {
      setMessage(`Enter a price below ${listing.price ? pounds(listing.price) : "the current one"}.`);
      return;
    }
    setBusy(true);
    setMessage("");
    const { error } = await supabase
      .from("agent_listings")
      .update({ price, previous_price: listing.price, price_reduced_at: new Date().toISOString() })
      .eq("id", listing.id);
    if (error) {
      setMessage(error.message);
      setBusy(false);
      return;
    }
    try {
      const response = await postAuthed("/api/send-listing", { action: "price_update", listingId: listing.id });
      const result = await response.json().catch(() => ({}));
      setMessage(response.ok ? reachedText(result, `New price ${pounds(price)}`) : result.error);
    } catch {
      setMessage("Price saved, but buyers couldn't be told just now.");
    }
    setReducing(false);
    setNewPrice("");
    setBusy(false);
    onChanged();
  }

  return (
    <div className="agent-status">
      <div className="agent-status-row">
        <div className="agent-status-switch" role="radiogroup" aria-label="Listing status">
          {MARKET_STATUSES.map((s) => (
            <button
              key={s.value}
              type="button"
              role="radio"
              aria-checked={status === s.value}
              className={`status-${s.value}${status === s.value ? " selected" : ""}`}
              disabled={busy}
              onClick={() => setStatus(s.value)}
            >
              {s.label}
            </button>
          ))}
        </div>
        {listing.price > 0 && (
          <button
            type="button"
            className="secondary-button agent-reduce-button"
            disabled={busy}
            onClick={() => {
              setReducing(!reducing);
              setMessage("");
            }}
          >
            {reducing ? "Cancel" : "↓ Reduce price"}
          </button>
        )}
      </div>
      {reducing && (
        <form className="agent-reduce" onSubmit={reducePrice}>
          <label>
            New asking price
            <input
              autoFocus
              inputMode="numeric"
              placeholder={`Now ${pounds(listing.price)}`}
              value={newPrice}
              onChange={(event) => setNewPrice(event.target.value)}
            />
          </label>
          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving..." : "Save and tell buyers"}
          </button>
        </form>
      )}
      {message && (
        <p className="agent-status-message" aria-live="polite">
          {message}
        </p>
      )}
    </div>
  );
}

function ListingCard({ listing, slots, bookingsBySlot, positions, agentId, reach, hoursOn, blocked, onChanged }) {
  const [adding, setAdding] = useState(slots.length === 0 && !hoursOn);
  const [editing, setEditing] = useState(false);
  const [allDays, setAllDays] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);

  const days = useMemo(() => {
    const groups = new Map();
    for (const slot of slots) {
      const day = dayFormatter.format(new Date(slot.starts_at));
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day).push(slot);
    }
    return [...groups.entries()];
  }, [slots]);
  const shownDays = allDays ? days : days.slice(0, DAYS_SHOWN);

  async function toggleAuto() {
    setSavingAuto(true);
    await supabase.from("agent_listings").update({ auto_times: !listing.auto_times }).eq("id", listing.id);
    await supabase.rpc("sync_pattern_slots", { p_agent: agentId });
    setSavingAuto(false);
    onChanged();
  }

  async function toggleActive() {
    await supabase
      .from("agent_listings")
      .update({ is_active: !listing.is_active })
      .eq("id", listing.id);
    onChanged();
  }

  const status = MARKET_STATUSES.find((s) => s.value === (listing.market_status || "available"));
  const reduced = recentlyReduced(listing);
  const facts = [
    listing.bedrooms != null ? (listing.bedrooms === 0 ? "Studio" : `${listing.bedrooms} bed`) : "",
    listing.property_type ? listing.property_type[0].toUpperCase() + listing.property_type.slice(1) : "",
    listing.has_garden ? "Garden" : listing.has_garden === false ? "No garden" : "",
    listing.postcode || "",
  ].filter(Boolean);

  return (
    <section
      id={`listing-${listing.id}`}
      className={`card agent-listing status-${status.value} ${listing.is_active ? "" : "paused"}`}
    >
      <div className="agent-listing-head">
        <div className="agent-listing-photo-wrap">
          {listing.image_url ? (
            <img className="agent-listing-photo" src={listing.image_url} alt="" />
          ) : (
            <div className="agent-listing-photo empty" aria-hidden="true">
              🏠
            </div>
          )}
          {status.value !== "available" && (
            <span className={`agent-listing-ribbon status-${status.value}`}>{status.label}</span>
          )}
        </div>
        <div className="agent-listing-info">
          <p className="agent-listing-price">
            {listing.price ? pounds(listing.price) : "Price not set"}
            {reduced && (
              <>
                <s className="agent-listing-was">{pounds(listing.previous_price)}</s>
                <span className="agent-listing-badge reduced">Reduced</span>
              </>
            )}
          </p>
          <h3>{listing.address}</h3>
          {facts.length > 0 && (
            <ul className="agent-listing-facts">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}
          <p className="muted agent-listing-links">
            <a href={listing.listing_url} target="_blank" rel="noreferrer">
              View on portal ↗
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

      <ListingStatus
        listing={listing}
        agentId={agentId}
        upcomingBookings={slots
          .filter((slot) => new Date(slot.starts_at) > new Date())
          .flatMap((slot) => bookingsBySlot[slot.id] || [])}
        onChanged={onChanged}
      />

      <ListingReach listing={listing} reach={reach} onSent={onChanged} />

      {listing.is_active ? (
        <ShareLink listing={listing} />
      ) : (
        <p className="muted">Hidden: buyers can't see or book these times, and the link is off.</p>
      )}

      {hoursOn && (
        <label className="agent-auto">
          <input type="checkbox" checked={listing.auto_times} disabled={savingAuto} onChange={toggleAuto} />
          Offer my weekly viewing hours on this home
        </label>
      )}

      {days.length === 0 ? (
        <p className="muted">
          {hoursOn && listing.auto_times && listing.is_active
            ? "No free times in your weekly hours coming up. Check your hours and time off above."
            : hoursOn
              ? "No upcoming viewing times. Add some by hand below."
              : "No upcoming viewing times yet. Set your viewing hours above and times appear here automatically, or add some by hand."}
        </p>
      ) : (
        shownDays.map(([day, daySlots]) => {
          const free = daySlots.filter((slot) => slot.capacity === 1 && !bookingsBySlot[slot.id]?.length);
          const rows = daySlots.filter((slot) => !free.includes(slot));
          return (
            <div key={day} className="agent-day">
              <h4>{day}</h4>
              {rows.length > 0 && (
                <ul className="agent-slots">
                  {rows.map((slot) => (
                    <SlotRow
                      key={slot.id}
                      slot={slot}
                      bookings={bookingsBySlot[slot.id] || []}
                      positions={positions}
                      onChanged={onChanged}
                    />
                  ))}
                </ul>
              )}
              {free.length > 0 && <FreeTimes slots={free} blocked={blocked} onChanged={onChanged} />}
            </div>
          );
        })
      )}
      {days.length > DAYS_SHOWN && (
        <button type="button" className="link-button" onClick={() => setAllDays(!allDays)}>
          {allDays ? "Show fewer days" : `Show all ${days.length} days`}
        </button>
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
          {hoursOn ? "Add one-off times or an open house" : "Add viewing times"}
        </button>
      )}
    </section>
  );
}

// First-run checklist for a new agent: list a home, publish times, send it
// to matching buyers. Ticks itself off from what's saved; hidden once done
// or when the agent hides it (remembered on this device).
function AgentGettingStarted({ agentId, listings, slots, reach, hoursSet }) {
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
      title: "Set your viewing hours",
      text: "Once, for all your listings. Buyers who've saved the home book straight in, and you get a calendar invite.",
      done: hoursSet || slots.length > 0,
      target: "agent-hours",
      action: "Set hours",
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
                disabled={step.id === "send" && listings.length === 0}
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
  const [availability, setAvailability] = useState(null);
  const [hours, setHours] = useState([]);
  const [timeOff, setTimeOff] = useState([]);
  const [blocked, setBlocked] = useState(new Set());
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const since = new Date(Date.now() - 2 * 3600000).toISOString();
    // Weekly hours: add any times now due (new listing, a new day in range).
    await supabase.rpc("sync_pattern_slots", { p_agent: agent.user_id });
    const [
      listingsResult,
      slotsResult,
      bookingsResult,
      reachResult,
      offersResult,
      positionsResult,
      availabilityResult,
      hoursResult,
      timeOffResult,
      blockedResult,
    ] = await Promise.all([
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
      supabase.from("agent_availability").select("*").maybeSingle(),
      supabase.from("agent_hours").select("*"),
      supabase.from("agent_time_off").select("*").order("starts_on"),
      supabase.rpc("agent_blocked_slots"),
    ]);
    setAvailability(availabilityResult.data || null);
    setHours(hoursResult.data || []);
    setTimeOff(timeOffResult.data || []);
    setBlocked(new Set((blockedResult.data || []).map((row) => (typeof row === "string" ? row : Object.values(row)[0]))));
    setOffers(offersResult.data || []);
    setPositions(Object.fromEntries((positionsResult.data || []).map((p) => [p.buyer_id, p])));
    const reachMap = {};
    for (const r of reachResult.data || []) reachMap[r.listing_id] = r;
    setReach(reachMap);
    setListings(listingsResult.data || []);
    setSlots(slotsResult.data || []);
    setBookings(bookingsResult.data || []);
    setLoading(false);
  }, [agent.user_id]);

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
        <AgentGettingStarted
          agentId={agent.user_id}
          listings={listings}
          slots={slots}
          reach={reach}
          hoursSet={!!availability}
        />
      )}

      {!loading && (
        <AgentHours
          agentId={agent.user_id}
          availability={availability}
          hours={hours}
          timeOff={timeOff}
          bookedSlots={slots.filter((slot) => bookingsBySlot[slot.id]?.length)}
          onChanged={load}
        />
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
            hoursOn={!!availability?.enabled}
            blocked={blocked}
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
  const [isBuyer, setIsBuyer] = useState(false);
  // Arrived from a password-reset email: ask for the new password first.
  const [settingPassword, setSettingPassword] = useState(arrivedFromPasswordReset);
  const [passwordChanged, setPasswordChanged] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setUser(session?.user ?? null));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setSettingPassword(true);
      setUser(session?.user ?? null);
    });
    return () => subscription.unsubscribe();
  }, []);

  const loadAgent = useCallback(async () => {
    if (!user) {
      setAgent(null);
      return;
    }
    const [{ data }, { data: member }] = await Promise.all([
      supabase.from("agents").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.rpc("is_household_member"),
    ]);
    setAgent(data || null);
    // Also a buyer (same login): offer a way back to the buyer app.
    setIsBuyer(member === true);
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
        <div className="agent-header-actions">
          {user && isBuyer && (
            <a className="secondary-button" href="/">
              ← Buyer app
            </a>
          )}
          {user && (
            <button
              type="button"
              className="secondary-button"
              onClick={() => supabase.auth.signOut({ scope: "local" })}
            >
              Log Out
            </button>
          )}
        </div>
      </header>

      <main className="app-main">
        {passwordChanged && (
          <p className="agent-joining" role="status">
            Your password has been changed.
          </p>
        )}
        {settingPassword && user ? (
          <SetNewPasswordForm
            onDone={() => {
              setSettingPassword(false);
              setPasswordChanged(true);
            }}
          />
        ) : user === undefined || (user && agent === undefined) ? (
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
