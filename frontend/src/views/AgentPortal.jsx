import { useCallback, useEffect, useMemo, useState } from "react";
import { arrivedFromPasswordReset, supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { friendlyError } from "../lib/errors";
import SetNewPasswordForm from "../components/SetNewPasswordForm";
import { dismissPushOffer, enablePush, forgetThisPhone, refreshPushRegistration, shouldOfferPush } from "../lib/push";
import { apiUrl, siteUrl } from "../lib/platform";
import { listingKey } from "../../api/_lib/listing.js";
import { londonToUtc } from "../../api/_lib/time.js";
import { openProof, proofLabel } from "../components/PositionProof";
import AgentHours from "./AgentHours";
import NavigationTabs from "../components/NavigationTabs";
import { CheckYourEmail } from "../components/ConfirmEmail";
import { AgentTrialBanner } from "../components/AgentTrial";
import AgentInviteSignup, { inviteFromLink } from "../components/AgentInviteSignup";
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

// "Are you sure? [Confirm] [Keep]" shown in place of the button that asked,
// instead of a browser pop-up (which the iPhone app shows as a bare system
// alert with the site's address on it).
function InlineConfirm({ text, confirmLabel = "Confirm", keepLabel = "Keep", busy, danger = true, onConfirm, onKeep, children }) {
  return (
    <div className="inline-confirm" role="alertdialog" aria-label={text}>
      <span className="inline-confirm-text">{text}</span>
      {children}
      <span className="inline-confirm-buttons">
        <button
          type="button"
          className={danger ? "danger-button" : "primary-button"}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? "Please wait..." : confirmLabel}
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onKeep}>
          {keepLabel}
        </button>
      </span>
    </div>
  );
}

// Buyers' one-tap answer after a viewing (migration 035).
const FEEDBACK_TEXT = {
  not_for_us: "Not for us",
  maybe: "Maybe",
  second_look: "Want a second look",
};

// "Maybe · 'small garden'"
function feedbackText(f) {
  if (!f) return "";
  return `${FEEDBACK_TEXT[f.answer] || f.answer}${f.note ? ` · "${f.note}"` : ""}`;
}

function FeedbackTag({ feedback, earlier }) {
  if (!feedback) return null;
  return (
    <span className={`feedback-tag feedback-${feedback.answer}`}>
      {earlier ? "Last time: " : ""}
      {feedbackText(feedback)}
    </span>
  );
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

// A buyer's invite link (/agent?invite=...): free-trial sign-up, no code.
function AgentAuth() {
  return inviteFromLink() ? <AgentInviteSignup /> : <AgentCodeAuth />;
}

function AgentCodeAuth() {
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
          redirectTo: `${siteUrl}/reset/agent`,
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
          ViewPal see those times and book straight in: no phone tag, and you get their
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
            ViewPal. Add your details and request a place: once it's added, use the same
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
                  Your branch's code from ViewPal. No code?{" "}
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
        New to ViewPal? <a href="/agents">See how it works for agents</a>.
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

    // A new price goes straight to buyers who saved the home. The card
    // shows how many were told (the form closes on save).
    let note = "";
    if (listing && row.price && row.price !== listing.price) {
      const response = await postAuthed("/api/send-listing", { action: "price_update", listingId: listing.id });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.notified) {
        note = `New price saved. ${result.notified} household${result.notified === 1 ? " that saved this home has" : "s that saved this home have"} been told.`;
      }
    }

    if (!listing) {
      setForm(EMPTY_LISTING);
      setLookup("");
      // Don't just reset: show the obvious next step while the match
      // count is fresh. With auto-send on (the default), it's already done.
      if (saved) {
        const matches = matchCount || 0;
        setJustAdded({ listing: saved, matches });
        if (matches > 0 && saved.auto_send !== false) await sendNow({ listing: saved, matches });
      }
    }
    onSaved(note);
  }

  async function sendNow(added = justAdded) {
    setSending(true);
    try {
      const response = await postAuthed("/api/send-listing", { listingId: added.listing.id });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not send");
      setJustAdded({ ...added, sent: body.sent || 0 });
      onSaved();
    } catch (err) {
      setJustAdded({ ...added, sendError: err.message });
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
            {matches} buyer{matches === 1 ? "" : "s"} on ViewPal{" "}
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
            <button type="button" className="primary-button" disabled={sending} onClick={() => sendNow()}>
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
            : `${matchCount} buyer${matchCount === 1 ? "" : "s"} on ViewPal match${matchCount === 1 ? "es" : ""} this.`}
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

// The buyer told everyone at once they've paused or found somewhere
// (migration 029), so the agent knows not to chase them.
function BuyerSearchStatus({ search }) {
  if (!search || search.search_status === "searching") return null;
  const text =
    search.search_status === "found"
      ? "Found somewhere"
      : search.paused_until
        ? `Search paused until ${new Date(`${search.paused_until}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}`
        : "Search paused";
  return (
    <span className={`buyer-search-status ${search.search_status}`} title="Set by the buyer in ViewPal">
      {text}
    </span>
  );
}

function BuyerPosition({ position }) {
  if (position?.search && position.search.search_status !== "searching") {
    return (
      <>
        <BuyerSearchStatus search={position.search} />{" "}
        <BuyerPositionFacts position={position.status_only ? null : position} />
      </>
    );
  }
  return <BuyerPositionFacts position={position?.status_only ? null : position} />;
}

function BuyerPositionFacts({ position }) {
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
            title="Uploaded by the buyer; not checked by ViewPal"
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
  // { offerId, text }: shown under the offer it's about.
  const [error, setError] = useState(null);
  if (!offers.length) return null;

  async function respond(offer, confirm) {
    setBusy(offer.offer_id);
    setError(null);
    const response = await postAuthed("/api/offers", {
      action: "respond",
      offerId: offer.offer_id,
      confirm,
    });
    const body = await response.json().catch(() => ({}));
    setBusy(null);
    if (!response.ok) setError({ offerId: offer.offer_id, text: body.error || "Something went wrong. Please try again." });
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
              {error?.offerId === offer.offer_id && <p className="booking-error">{error.text}</p>}
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

function SlotRow({ slot, bookings, positions, feedbackFor, onOpenBooking, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // null | "slot" | a booking id: which "Are you sure?" is showing.
  const [confirming, setConfirming] = useState(null);
  const isOpenHouse = slot.capacity > 1;

  async function call(body) {
    setBusy(true);
    setError("");
    // A network error mustn't leave the buttons stuck on busy.
    try {
      const response = await postAuthed("/api/viewings", body);
      const result = await response.json().catch(() => ({}));
      setConfirming(null);
      if (!response.ok) setError(result.error || "Something went wrong. Please try again.");
      onChanged();
    } catch (err) {
      setError(friendlyError(err));
    } finally {
      setBusy(false);
    }
  }

  async function removeSlot() {
    if (bookings.length) {
      setConfirming("slot");
      return;
    }
    setBusy(true);
    setError("");
    const { error: removeError } = await supabase.rpc("agent_remove_slots", { p_slots: [slot.id] });
    setBusy(false);
    if (removeError) setError(removeError.message);
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
        {confirming !== "slot" && (
          <button type="button" className="link-button" disabled={busy} onClick={removeSlot}>
            {bookings.length ? "Cancel time" : "Remove"}
          </button>
        )}
      </div>
      {confirming === "slot" && (
        <InlineConfirm
          text={`Cancel this time? ${bookings.length} buyer${bookings.length === 1 ? "" : "s"} will be emailed that it's cancelled.`}
          confirmLabel="Cancel time"
          busy={busy}
          onConfirm={() => call({ action: "cancel_slot", slotId: slot.id })}
          onKeep={() => setConfirming(null)}
        />
      )}
      {bookings.map((booking) => {
        const fb = feedbackFor?.(booking);
        return (
          <div key={booking.id} className="agent-booking">
            <span>
              {onOpenBooking ? (
                <button type="button" className="link-button agent-booking-name" onClick={() => onOpenBooking(booking)}>
                  {booking.buyer_name}
                </button>
              ) : (
                <strong>{booking.buyer_name}</strong>
              )}
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
              {fb && (
                <>
                  <br />
                  <FeedbackTag feedback={fb.feedback} earlier={fb.earlier} />
                </>
              )}
            </span>
            {confirming === booking.id ? (
              <InlineConfirm
                text={`Cancel ${booking.buyer_name}'s viewing? They'll get an email.`}
                confirmLabel="Cancel viewing"
                busy={busy}
                onConfirm={() => call({ action: "cancel", bookingId: booking.id })}
                onKeep={() => setConfirming(null)}
              />
            ) : (
              <button
                type="button"
                className="link-button"
                disabled={busy}
                onClick={() => setConfirming(booking.id)}
              >
                Cancel booking
              </button>
            )}
          </div>
        );
      })}
      {error && <p className="booking-error">{error}</p>}
    </li>
  );
}

// The public booking link for one listing, with quick ways to send it.
// Copy to the clipboard; where that's blocked, select the link in a box so
// it can be copied by hand (no pop-up). -> [copied, copy, fallbackBox]
function useCopy(url) {
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setManual(true);
    }
  }

  const box = manual ? (
    <input
      className="agent-copy-box"
      readOnly
      autoFocus
      value={url}
      aria-label="Link to copy"
      onFocus={(event) => event.target.select()}
    />
  ) : null;
  return [copied, copy, box];
}

function ShareLink({ listing }) {
  const url = `${siteUrl}/viewings/${listing.id}`;
  const text = `Book a viewing of ${listing.address} here: ${url}`;
  const [copied, copy, copyBox] = useCopy(url);

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
        See the booking page ↗
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
      {copyBox}
    </div>
  );
}

// The vendor's private report link (/report/<token>, migration 035):
// viewings, anonymised feedback, offers and prices, kept up to date.
function SellerReportLink({ listing, onChanged }) {
  const url = `${siteUrl}/report/${listing.report_token}`;
  const [copied, copy, copyBox] = useCopy(url);
  const canShare = typeof navigator !== "undefined" && navigator.share;
  const [renewing, setRenewing] = useState(false);
  const [renewBusy, setRenewBusy] = useState(false);
  const [renewError, setRenewError] = useState("");

  // Replace the link, e.g. after the sale or if it was forwarded on.
  async function renew() {
    setRenewBusy(true);
    setRenewError("");
    try {
      const response = await postAuthed("/api/send-listing", { action: "new_report_link", listingId: listing.id });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not make a new link");
      setRenewing(false);
      onChanged?.();
    } catch (err) {
      setRenewError(err.message);
    }
    setRenewBusy(false);
  }

  async function share() {
    try {
      await navigator.share({
        title: `How ${listing.address} is doing`,
        text: `Here's how ${listing.address} is doing: viewings, feedback and offers, kept up to date.`,
        url,
      });
    } catch {
      // Cancelled: nothing to do.
    }
  }

  if (!listing.report_token) return null;
  return (
    <div className="agent-share agent-seller-report">
      <span className="agent-share-label">Seller report:</span>
      <a href={url} target="_blank" rel="noreferrer" className="agent-share-url">
        Open the vendor's view ↗
      </a>
      <div className="agent-share-buttons">
        <button type="button" className="secondary-button" onClick={copy}>
          {copied ? "Copied" : "Copy link"}
        </button>
        {canShare && (
          <button type="button" className="secondary-button" onClick={share}>
            Share
          </button>
        )}
        {!renewing && (
          <button type="button" className="link-button" onClick={() => setRenewing(true)}>
            New link
          </button>
        )}
      </div>
      {renewing && (
        <div className="inline-confirm" role="group" aria-label="Replace the seller report link">
          <span className="inline-confirm-text">The old link stops working. Send the vendor the new one.</span>
          <div className="inline-confirm-buttons">
            <button type="button" className="secondary-button" disabled={renewBusy} onClick={renew}>
              {renewBusy ? "Making..." : "Make a new link"}
            </button>
            <button type="button" className="link-button" disabled={renewBusy} onClick={() => setRenewing(false)}>
              Keep this one
            </button>
          </div>
        </div>
      )}
      {renewError && <p className="booking-error">{renewError}</p>}
      {copyBox}
    </div>
  );
}

// Free private times shown as small chips (there can be many with weekly
// hours). Tap × to remove one; blocked ones are times you're at another
// viewing (plus travel) or inside your shortest notice.
// Folded into one line by default ("6 free times, 17:00–18:40 · Edit"), so
// a week of weekly hours doesn't turn the listing into a wall of chips.
function FreeTimes({ slots, blocked, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [open, setOpen] = useState(false);

  if (!open) {
    const offered = slots.filter((slot) => !blocked.has(slot.id));
    const notOffered = slots.length - offered.length;
    const times = offered.map((slot) => timeFormatter.format(new Date(slot.starts_at)));
    const range = times.length > 1 ? `${times[0]}–${times[times.length - 1]}` : times[0];
    return (
      <div className="agent-free agent-free-summary">
        <span>
          {offered.length
            ? `${offered.length} free time${offered.length === 1 ? "" : "s"}, ${range}`
            : "No free times offered"}
          {notOffered > 0 && <span className="muted"> · {notOffered} not offered</span>}
        </span>
        <button type="button" className="link-button" onClick={() => setOpen(true)}>
          Edit
        </button>
      </div>
    );
  }

  async function remove(ids) {
    setBusy(true);
    setError("");
    const { error: removeError } = await supabase.rpc("agent_remove_slots", { p_slots: ids });
    setBusy(false);
    setClearing(false);
    if (removeError) setError(removeError.message);
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
      {slots.length > 1 &&
        (clearing ? (
          <InlineConfirm
            text={`Remove all ${slots.length} free times on this day?`}
            confirmLabel="Remove them"
            busy={busy}
            onConfirm={() => remove(slots.map((s) => s.id))}
            onKeep={() => setClearing(false)}
          />
        ) : (
          <button type="button" className="link-button" disabled={busy} onClick={() => setClearing(true)}>
            Clear free times
          </button>
        ))}
      <button type="button" className="link-button" onClick={() => setOpen(false)}>
        Done
      </button>
      {error && <p className="booking-error">{error}</p>}
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
  // Sold STC / Off market waiting for "Are you sure?", with the booked
  // viewings the agent has chosen to cancel (all, by default).
  const [closing, setClosing] = useState(null);
  const [cancelIds, setCancelIds] = useState(new Set());
  const status = listing.market_status || "available";

  function pick(value) {
    if (busy) return;
    const closes = value === "sold_stc" || value === "off_market";
    // Picking another status shuts a Sold STC / Off market "Are you sure?".
    if (!closes) setClosing(null);
    if (value === status) return;
    setMessage("");
    // Closing takes the home's times away and tells buyers: ask first.
    if (closes) {
      setClosing(value);
      setCancelIds(new Set(upcomingBookings.map((b) => b.id)));
      return;
    }
    setStatus(value, []);
  }

  function toggleCancel(id) {
    setCancelIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function setStatus(value, toCancel) {
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

    // The viewings the agent chose to cancel (each buyer is emailed).
    if (toCancel.length) {
      const results = await Promise.all(
        toCancel.map((id) =>
          postAuthed("/api/viewings", { action: "cancel", bookingId: id })
            .then((r) => r.ok)
            .catch(() => false)
        )
      );
      const done = results.filter(Boolean).length;
      note += ` ${done} viewing${done === 1 ? "" : "s"} cancelled and the buyer${done === 1 ? " has" : "s have"} been told.`;
      if (done < toCancel.length) note += ` ${toCancel.length - done} couldn't be cancelled: try again from the times below.`;
    }
    const kept = upcomingBookings.length - toCancel.length;
    // Only closing leaves "still booked" viewings worth a mention (and this
    // run's closing may be stale, so go by the status picked).
    if ((value === "sold_stc" || value === "off_market") && kept > 0) note += ` ${kept} viewing${kept === 1 ? " is" : "s are"} still booked.`;
    setClosing(null);
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
              onClick={() => pick(s.value)}
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
      {closing && (
        <InlineConfirm
          text={`Mark it ${MARKET_STATUSES.find((s) => s.value === closing).label}? Buyers who saved it are told, and its free times come off.`}
          confirmLabel={
            cancelIds.size
              ? `Confirm and cancel ${cancelIds.size} viewing${cancelIds.size === 1 ? "" : "s"}`
              : "Confirm"
          }
          keepLabel="Keep it for sale"
          busy={busy}
          onConfirm={() => setStatus(closing, [...cancelIds])}
          onKeep={() => setClosing(null)}
        >
          {upcomingBookings.length > 0 && (
            <div className="agent-closing-bookings">
              <p>
                {upcomingBookings.length} viewing{upcomingBookings.length === 1 ? " is" : "s are"} still booked.
                Tick the ones to cancel (the buyer is emailed):
              </p>
              <ul>
                {upcomingBookings.map((b) => (
                  <li key={b.id}>
                    <label className="agent-auto">
                      <input type="checkbox" checked={cancelIds.has(b.id)} onChange={() => toggleCancel(b.id)} />
                      {b.starts_at ? `${dayFormatter.format(new Date(b.starts_at))}, ${timeFormatter.format(new Date(b.starts_at))} · ` : ""}
                      {b.buyer_name}
                    </label>
                  </li>
                ))}
              </ul>
              <div className="agent-closing-all">
                <button
                  type="button"
                  className="link-button"
                  onClick={() => setCancelIds(new Set(upcomingBookings.map((b) => b.id)))}
                >
                  Cancel all
                </button>
                <button type="button" className="link-button" onClick={() => setCancelIds(new Set())}>
                  Keep all
                </button>
              </div>
            </div>
          )}
        </InlineConfirm>
      )}
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

// What buyers said after their viewings: a tally, then the latest few.
function ListingFeedback({ feedback }) {
  const [all, setAll] = useState(false);
  if (!feedback.length) return null;
  const tally = Object.keys(FEEDBACK_TEXT)
    .map((key) => ({ key, n: feedback.filter((f) => f.answer === key).length }))
    .filter((t) => t.n)
    .map((t) => `${t.n} ${FEEDBACK_TEXT[t.key]}`)
    .join(" · ");
  const shown = all ? feedback : feedback.slice(0, 3);
  return (
    <div className="agent-feedback">
      <p>
        <strong>Feedback</strong> <span className="muted">{tally}</span>
      </p>
      <ul>
        {shown.map((f) => (
          <li key={f.booking_id}>
            <FeedbackTag feedback={f} />
            <span className="muted">
              {" "}
              {f.buyer_name}, {dayFormatter.format(new Date(f.viewing_at))}
            </span>
          </li>
        ))}
      </ul>
      {feedback.length > 3 && (
        <button type="button" className="link-button" onClick={() => setAll(!all)}>
          {all ? "Show less" : `Show all ${feedback.length}`}
        </button>
      )}
    </div>
  );
}

function ListingCard({
  listing,
  slots,
  bookingsBySlot,
  positions,
  agentId,
  reach,
  hoursOn,
  blocked,
  startOpen = true,
  feedback = [],
  feedbackFor,
  onOpenBooking,
  focus,
  onChanged,
}) {
  // Compact (head + one-line summary) until opened, when there are lots.
  const [open, setOpen] = useState(startOpen);
  const [adding, setAdding] = useState(slots.length === 0 && !hoursOn);
  const [editing, setEditing] = useState(false);
  const [allDays, setAllDays] = useState(false);
  const [savingAuto, setSavingAuto] = useState(false);
  // "New price saved, 3 households told" after Edit details closes.
  const [savedNote, setSavedNote] = useState("");

  // "Open listing" from a booking in the Calendar or Today: open this card.
  useEffect(() => {
    if (focus?.id === listing.id) setOpen(true);
  }, [focus, listing.id]);

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

  // Off: the agent sends by hand. On: buyers whose saved search fits get it
  // as soon as they save it (api/send-listing.js for_search).
  async function toggleAutoSend() {
    setSavingAuto(true);
    await supabase.from("agent_listings").update({ auto_send: !listing.auto_send }).eq("id", listing.id);
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
        {open ? (
          <div className="agent-listing-buttons">
            <button type="button" className="secondary-button" onClick={() => setEditing(!editing)}>
              {editing ? "Close" : "Edit details"}
            </button>
            <button type="button" className="secondary-button" onClick={toggleActive}>
              {listing.is_active ? "Hide from buyers" : "Show to buyers"}
            </button>
          </div>
        ) : null}
      </div>

      {!open && (
        <button type="button" className="agent-listing-summary" onClick={() => setOpen(true)}>
          <span>{listingSummary(listing, slots, bookingsBySlot, reach)}</span>
          <strong>Open ›</strong>
        </button>
      )}
      {open && (
      <>

      {editing && (
        <ListingForm
          agentId={agentId}
          listing={listing}
          onSaved={(note) => {
            setEditing(false);
            setSavedNote(note || "");
            onChanged();
          }}
          onCancel={() => setEditing(false)}
        />
      )}
      {savedNote && !editing && (
        <p className="agent-status-message" aria-live="polite">
          {savedNote}
        </p>
      )}

      <ListingStatus
        listing={listing}
        agentId={agentId}
        upcomingBookings={slots
          .filter((slot) => new Date(slot.starts_at) > new Date())
          .flatMap((slot) => (bookingsBySlot[slot.id] || []).map((b) => ({ ...b, starts_at: slot.starts_at })))}
        onChanged={onChanged}
      />

      <ListingReach listing={listing} reach={reach} onSent={onChanged} />

      <ListingFeedback feedback={feedback} />

      <SellerReportLink listing={listing} onChanged={onChanged} />

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
      {"auto_send" in listing && (
        <label className="agent-auto">
          <input type="checkbox" checked={listing.auto_send} disabled={savingAuto} onChange={toggleAutoSend} />
          Send to new matching buyers automatically
        </label>
      )}

      {days.length === 0 ? (
        <p className="muted">
          {hoursOn && listing.auto_times && listing.is_active
            ? "No free times in your weekly hours coming up. Check your hours and time off in Settings."
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
                      feedbackFor={feedbackFor}
                      onOpenBooking={onOpenBooking && ((booking) => onOpenBooking({ booking, slot, listing }))}
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
      {!startOpen && (
        <button type="button" className="link-button agent-listing-collapse" onClick={() => setOpen(false)}>
          Show less
        </button>
      )}
      </>
      )}
    </section>
  );
}

// "3 booked · 14 free times · 5 matching buyers" for a compact card.
function listingSummary(listing, slots, bookingsBySlot, reach) {
  const future = slots.filter((s) => new Date(s.starts_at) > new Date());
  const booked = future.reduce((n, s) => n + (bookingsBySlot[s.id]?.length || 0), 0);
  const free = future.filter((s) => !(bookingsBySlot[s.id]?.length)).length;
  return [
    booked ? `${booked} booked` : "No viewings booked",
    `${free} free time${free === 1 ? "" : "s"}`,
    reach?.matching ? `${reach.matching} matching buyer${reach.matching === 1 ? "" : "s"}` : "",
    listing.is_active ? "" : "hidden from buyers",
  ]
    .filter(Boolean)
    .join(" · ");
}

// First-run checklist for a new agent: list a home, publish times, send it
// to matching buyers. Ticks itself off from what's saved; hidden once done
// or when the agent hides it (remembered on this device).
function AgentGettingStarted({ agentId, listings, slots, reach, hoursSet, onGo }) {
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

  // The steps live on other tabs (Listings, Settings): the dashboard
  // switches tab, then scrolls.
  const go = onGo;

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

// "Who am I seeing?": every booked viewing in the next week, across all
// listings, first thing on the page. Tap to call; position at a glance.
const agendaDay = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "long",
  day: "numeric",
  month: "short",
});
const agendaTime = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

function londonDayKey(date) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(date);
}

// The London date n days after today, as noon UTC on that date. Stepping
// whole calendar days (not 24-hour blocks) stays right when the clocks
// change: no doubled or skipped Sunday.
function londonDaysFromToday(n) {
  const [y, m, d] = londonDayKey(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n, 12));
}

function AgentAgenda({ listings, slots, bookingsBySlot, positions, feedbackFor, onOpen }) {
  const now = Date.now();
  const weekAhead = now + 7 * 864e5;
  const listingById = Object.fromEntries(listings.map((l) => [l.id, l]));
  const items = slots
    .filter((s) => new Date(s.ends_at).getTime() > now && new Date(s.starts_at).getTime() < weekAhead)
    .flatMap((slot) => (bookingsBySlot[slot.id] || []).map((booking) => ({ slot, booking })))
    .sort((a, b) => new Date(a.slot.starts_at) - new Date(b.slot.starts_at));

  const todayKey = londonDayKey(new Date());
  const tomorrowKey = londonDayKey(londonDaysFromToday(1));
  const days = [];
  for (const item of items) {
    const key = londonDayKey(new Date(item.slot.starts_at));
    const last = days[days.length - 1];
    if (last?.key === key) last.items.push(item);
    else days.push({ key, items: [item] });
  }
  const label = (day) =>
    day.key === todayKey
      ? "Today"
      : day.key === tomorrowKey
        ? "Tomorrow"
        : agendaDay.format(new Date(day.items[0].slot.starts_at));

  return (
    <section className="card agent-agenda">
      <div className="section-header">
        <div>
          <h3>Coming up</h3>
          <p className="muted">
            {items.length
              ? `${items.length} viewing${items.length === 1 ? "" : "s"} booked in the next 7 days`
              : "No viewings booked in the next 7 days. They'll appear here as buyers book."}
          </p>
        </div>
      </div>
      {days.map((day) => (
        <div key={day.key} className="agent-agenda-day">
          <h4>{label(day)}</h4>
          <ul>
            {day.items.map(({ slot, booking }) => {
              const listing = listingById[slot.listing_id];
              const fb = feedbackFor?.(booking);
              return (
                <li key={booking.id} className="agent-agenda-row">
                  <strong className="agent-agenda-time">{agendaTime.format(new Date(slot.starts_at))}</strong>
                  {/* Tap for call, email, position, feedback and cancel. */}
                  <button
                    type="button"
                    className="agent-agenda-main agent-open-booking"
                    onClick={() => onOpen?.({ booking, slot, listing })}
                  >
                    <strong>{booking.buyer_name}</strong>
                    <span>
                      {listing?.address || "Viewing"}
                      {slot.capacity > 1 ? " · open house" : ""}
                    </span>
                    {booking.buyer_id && <BuyerPosition position={positions[booking.buyer_id]} />}
                    {fb && <FeedbackTag feedback={fb.feedback} earlier={fb.earlier} />}
                  </button>
                  {booking.buyer_phone && (
                    <a className="secondary-button agent-agenda-call" href={`tel:${booking.buyer_phone.replace(/\s+/g, "")}`}>
                      Call
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </section>
  );
}

// Calendar tab: the agent's diary across every listing, laid out like the
// buyer's phone calendar (App.css .agenda-*): a two-week strip, "Next up",
// then each day. Booked viewings by default; free times on request, since
// weekly hours can add a lot of them.
const stripWeekday = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", weekday: "narrow" });
const stripDate = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "numeric" });

function mapsUrl(listing) {
  const where = [listing?.address, listing?.postcode].filter(Boolean).join(", ");
  return where ? `https://maps.apple.com/?q=${encodeURIComponent(where)}` : "";
}

function AgentCalendar({ listings, slots, bookingsBySlot, positions, timeOff, feedbackFor, onOpen }) {
  const [showFree, setShowFree] = useState(false);
  const now = Date.now();
  const listingById = Object.fromEntries(listings.map((l) => [l.id, l]));
  const upcoming = slots.filter((s) => new Date(s.ends_at).getTime() > now);
  const booked = (slot) => bookingsBySlot[slot.id] || [];
  const shown = showFree ? upcoming : upcoming.filter((s) => booked(s).length);
  const freeCount = upcoming.filter((s) => !booked(s).length).length;

  const days = [];
  for (const slot of shown) {
    const key = londonDayKey(new Date(slot.starts_at));
    const last = days[days.length - 1];
    if (last?.key === key) last.slots.push(slot);
    else days.push({ key, slots: [slot] });
  }
  const bookedDays = new Set(upcoming.filter((s) => booked(s).length).map((s) => londonDayKey(new Date(s.starts_at))));
  const todayKey = londonDayKey(new Date(now));
  const tomorrowKey = londonDayKey(londonDaysFromToday(1));
  const dayLabel = (key, at) => (key === todayKey ? "Today" : key === tomorrowKey ? "Tomorrow" : agendaDay.format(at));
  const offOn = (key) => timeOff.some((t) => key >= t.starts_on && key <= t.ends_on);
  const strip = Array.from({ length: 14 }, (_, n) => londonDaysFromToday(n));

  const next = upcoming.find((s) => booked(s).length);
  const nextListing = next && listingById[next.listing_id];
  const nextBuyer = next && booked(next)[0];

  function jumpTo(key) {
    const day = days.find((d) => d.key >= key);
    if (day) document.getElementById(`agent-day-${day.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  return (
    <div className="agenda agent-calendar">
      <div className="agenda-strip" role="list" aria-label="Next two weeks">
        {strip.map((date) => {
          const key = londonDayKey(date);
          return (
            <button
              type="button"
              role="listitem"
              key={key}
              className={`agenda-strip-day${key === todayKey ? " today" : ""}${bookedDays.has(key) ? " busy" : ""}${offOn(key) ? " off" : ""}`}
              onClick={() => jumpTo(key)}
              title={offOn(key) ? "Time off" : undefined}
            >
              <span>{stripWeekday.format(date)}</span>
              <strong>{stripDate.format(date)}</strong>
              <i aria-hidden="true" />
            </button>
          );
        })}
      </div>

      {next && (
        <div className="agenda-next">
          {nextListing?.image_url && <img className="agenda-next-photo" src={nextListing.image_url} alt="" />}
          <div className="agenda-next-body">
            <p className="eyebrow">Next up</p>
            <h3>{nextListing?.address || "Viewing"}</h3>
            <p className="agenda-next-when">
              {dayLabel(londonDayKey(new Date(next.starts_at)), new Date(next.starts_at))}, {timeRange(next)}
            </p>
            <p className="muted">
              With {booked(next).map((b) => b.buyer_name).join(", ")}
            </p>
            <div className="agenda-next-actions">
              {mapsUrl(nextListing) && (
                <a className="primary-button" href={mapsUrl(nextListing)} target="_blank" rel="noreferrer">
                  Directions
                </a>
              )}
              {nextBuyer?.buyer_phone && (
                <a className="secondary-button" href={`tel:${nextBuyer.buyer_phone.replace(/\s+/g, "")}`}>
                  Call {nextBuyer.buyer_name?.split(" ")[0] || "buyer"}
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {freeCount > 0 && (
        <button type="button" className="link-button agent-calendar-toggle" onClick={() => setShowFree(!showFree)}>
          {showFree ? "Booked viewings only" : `Show free times too (${freeCount})`}
        </button>
      )}

      {days.length === 0 ? (
        <div className="agenda-empty">
          <p className="agenda-empty-icon" aria-hidden="true">
            📅
          </p>
          <p>
            <strong>No viewings booked</strong>
          </p>
          <p className="muted">
            {freeCount
              ? "Buyers book your free times from the listing or a match email. Bookings show up here."
              : "Set your viewing hours in Settings, or add times to a listing, and buyers can book straight in."}
          </p>
        </div>
      ) : (
        days.map((day) => {
          const first = new Date(day.slots[0].starts_at);
          const count = day.slots.reduce((n, s) => n + booked(s).length, 0);
          return (
            <section className="agenda-day" key={day.key} id={`agent-day-${day.key}`}>
              <h4 className="agenda-day-head">
                {dayLabel(day.key, first)}
                <span>{count ? `${count} viewing${count === 1 ? "" : "s"}` : "Free times only"}</span>
              </h4>
              <ul className="agenda-list">
                {day.slots.map((slot) => {
                  const listing = listingById[slot.listing_id];
                  const buyers = booked(slot);
                  const phone = buyers.find((b) => b.buyer_phone)?.buyer_phone;
                  return (
                    <li key={slot.id} className="agenda-row">
                      <div className={`agenda-row-button agent-calendar-row${buyers.length ? "" : " free"}`}>
                        <div className="agenda-time">
                          <strong>{agendaTime.format(new Date(slot.starts_at))}</strong>
                          <span>{slot.capacity > 1 ? "Open house" : buyers.length ? "Viewing" : "Free"}</span>
                        </div>
                        {listing?.image_url ? (
                          <img className="agenda-thumb" src={listing.image_url} alt="" />
                        ) : (
                          <div className="agenda-thumb agenda-thumb-icon" aria-hidden="true">
                            🏠
                          </div>
                        )}
                        <div className="agenda-main">
                          {buyers.length ? (
                            // Each buyer opens their booking: call, email, cancel.
                            <strong className="agent-calendar-buyers">
                              {buyers.map((b, i) => (
                                <span key={b.id}>
                                  {i > 0 && ", "}
                                  <button
                                    type="button"
                                    className="link-button agent-booking-name"
                                    onClick={() => onOpen?.({ booking: b, slot, listing })}
                                  >
                                    {b.buyer_name}
                                  </button>
                                </span>
                              ))}
                            </strong>
                          ) : (
                            <strong>{listing?.address || "Viewing time"}</strong>
                          )}
                          {buyers.length > 0 && <span>{listing?.address || "Viewing"}</span>}
                          {slot.capacity > 1 && (
                            <span>
                              Open house · {buyers.length} of {slot.capacity} booked
                            </span>
                          )}
                          {buyers.map((b) => {
                            const fb = feedbackFor?.(b);
                            return b.buyer_id || fb ? (
                              <span key={b.id} className="agent-calendar-position">
                                {buyers.length > 1 && <>{b.buyer_name.split(" ")[0]}: </>}
                                {b.buyer_id && <BuyerPosition position={positions[b.buyer_id]} />}
                                {fb && (
                                  <>
                                    {" "}
                                    <FeedbackTag feedback={fb.feedback} earlier={fb.earlier} />
                                  </>
                                )}
                              </span>
                            ) : null;
                          })}
                        </div>
                        {phone ? (
                          <a className="secondary-button agent-agenda-call" href={`tel:${phone.replace(/\s+/g, "")}`}>
                            Call
                          </a>
                        ) : (
                          <span />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
    </div>
  );
}

// Settings tab: who you are, your viewing hours, and the account things
// that used to sit in the header on every page.
function AgentSettings({ agent, email, hoursCard, isBuyer, onLogOut }) {
  return (
    <div className="agent-settings">
      <section className="card agent-profile-card">
        <h3>Your profile</h3>
        <dl className="agent-profile-facts">
          <dt>Name</dt>
          <dd>{agent.name}</dd>
          {(agent.agency || agent.branch) && (
            <>
              <dt>Agency</dt>
              <dd>{[agent.agency, agent.branch].filter(Boolean).join(" · ")}</dd>
            </>
          )}
          {agent.phone && (
            <>
              <dt>Phone</dt>
              <dd>{agent.phone}</dd>
            </>
          )}
          {email && (
            <>
              <dt>Email</dt>
              <dd>{email}</dd>
            </>
          )}
        </dl>
      </section>

      {hoursCard}

      <section className="card agent-account-card">
        <h3>Account</h3>
        <div className="agent-account-actions">
          {isBuyer && (
            <a className="secondary-button" href="/">
              Switch to the buyer app
            </a>
          )}
          <button type="button" className="secondary-button" onClick={onLogOut}>
            Log out
          </button>
        </div>
      </section>

      <DeleteAccount />
    </div>
  );
}

// Roughly how much time ViewPal saved this agent (migration 030):
// the evidence for "is it worth it". Hidden until there's something to show.
const SAVED_ROWS = [
  { kind: "bookings", label: (n) => `${n} viewing${n === 1 ? "" : "s"} booked without a phone call`, each: 10, unit: "booking" },
  { kind: "homes_sent", label: (n) => `${n} home${n === 1 ? "" : "s"} sent to buyers who fit`, each: 2, unit: "home sent" },
  { kind: "buyers_skipped", label: (n) => `${n} buyer${n === 1 ? "" : "s"} not chased: paused, found somewhere or opted out`, each: 3, unit: "buyer not chased" },
  { kind: "offers_answered", label: (n) => `${n} offer${n === 1 ? "" : "s"} confirmed in one tap`, each: 5, unit: "offer answered" },
  { kind: "cancellations", label: (n) => `${n} cancellation${n === 1 ? "" : "s"} handled, slot freed and everyone told`, each: 5, unit: "cancellation" },
];

function hoursAndMinutes(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (!h) return `${m} min`;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function TimeSaved({ refreshKey }) {
  const [month, setMonth] = useState(null);
  const [total, setTotal] = useState(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const toMap = (rows) => Object.fromEntries((rows || []).map((r) => [r.kind, r]));
    Promise.all([
      supabase.rpc("agent_time_saved", { p_since: start.toISOString() }),
      supabase.rpc("agent_time_saved", { p_since: "2000-01-01T00:00:00Z" }),
    ]).then(([thisMonth, ever]) => {
      // Before migration 030 these fail: show nothing.
      if (thisMonth.error || ever.error) return;
      setMonth(toMap(thisMonth.data));
      setTotal(toMap(ever.data));
    });
  }, [refreshKey]);

  if (!month || !total) return null;
  const sum = (map) => Object.values(map).reduce((s, r) => s + (r.minutes || 0), 0);
  const monthMinutes = sum(month);
  const totalMinutes = sum(total);
  if (!totalMinutes) return null;
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });

  return (
    <section className="card agent-time-saved">
      <button type="button" className="agent-time-saved-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span>
          <strong>{monthMinutes ? `About ${hoursAndMinutes(monthMinutes)} saved in ${monthName}` : `Nothing yet in ${monthName}`}</strong>
          <span className="muted"> · {hoursAndMinutes(totalMinutes)} since you joined</span>
        </span>
        <span className="muted">{open ? "Hide" : "How?"}</span>
      </button>
      {open && (
        <>
          <ul className="agent-time-saved-list">
            {SAVED_ROWS.filter((r) => month[r.kind]?.count).map((r) => (
              <li key={r.kind}>
                <span>{r.label(month[r.kind].count)}</span>
                <span className="muted">{hoursAndMinutes(month[r.kind].minutes)}</span>
              </li>
            ))}
            {!monthMinutes && <li className="muted">Nothing yet this month.</li>}
          </ul>
          <p className="muted small">
            Estimates: {SAVED_ROWS.map((r) => `${r.each} min per ${r.unit}`).join(", ")}.
          </p>
        </>
      )}
    </section>
  );
}

// Tapping a booked viewing (Calendar, Today, a listing's times): everything
// to act on in one small sheet. Call, email, their position, what they said,
// the listing, or cancel (the same /api/viewings cancel as the listing card).
function BookingSheet({ item, positions, feedbackFor, onClose, onOpenListing, onChanged }) {
  const { booking, slot, listing } = item;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [cancelled, setCancelled] = useState(false);
  const fb = feedbackFor?.(booking);
  const past = new Date(slot.ends_at).getTime() < Date.now();
  const first = booking.buyer_name?.split(" ")[0] || "buyer";

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const response = await postAuthed("/api/viewings", { action: "cancel", bookingId: booking.id });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || "Couldn't cancel it. Please try again.");
      setCancelled(true);
      setConfirming(false);
      onChanged();
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-card agent-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="agent-sheet-title"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="section-header">
          <div>
            <p className="eyebrow">
              {dayFormatter.format(new Date(slot.starts_at))}, {timeRange(slot)}
              {slot.capacity > 1 ? " · open house" : ""}
            </p>
            <h3 id="agent-sheet-title">{booking.buyer_name}</h3>
            <p className="muted">{listing?.address || "Viewing"}</p>
          </div>
          <button type="button" className="link-button" onClick={onClose} aria-label="Close">
            Close
          </button>
        </div>

        {cancelled ? (
          <p className="agent-status-message" role="status">
            Cancelled. {first} has been emailed and the time is free again.
          </p>
        ) : (
          <>
            <div className="agent-sheet-actions">
              {booking.buyer_phone && (
                <a className="primary-button" href={`tel:${booking.buyer_phone.replace(/\s+/g, "")}`}>
                  Call {first}
                </a>
              )}
              <a
                className="secondary-button"
                href={`mailto:${booking.buyer_email}?subject=${encodeURIComponent(`Viewing: ${listing?.address || ""}`)}`}
              >
                Email {first}
              </a>
            </div>

            {booking.buyer_id ? (
              <p className="agent-sheet-row">
                <BuyerPosition position={positions[booking.buyer_id]} />
              </p>
            ) : (
              <p className="agent-sheet-row muted">Booked through your link, so no buying position.</p>
            )}

            {fb ? (
              <p className="agent-sheet-row">
                <FeedbackTag feedback={fb.feedback} earlier={fb.earlier} />
              </p>
            ) : past && booking.buyer_id ? (
              <p className="agent-sheet-row muted">No feedback yet. We ask them a couple of hours after.</p>
            ) : null}

            <div className="agent-sheet-actions">
              {listing && (
                <button type="button" className="secondary-button" onClick={() => onOpenListing(listing.id)}>
                  Open listing
                </button>
              )}
              {!past && !confirming && (
                <button type="button" className="link-button agent-sheet-cancel" onClick={() => setConfirming(true)}>
                  Cancel viewing
                </button>
              )}
            </div>
            {confirming && (
              <InlineConfirm
                text={`Cancel ${first}'s viewing? They'll get an email.`}
                confirmLabel="Cancel viewing"
                busy={busy}
                onConfirm={cancel}
                onKeep={() => setConfirming(false)}
              />
            )}
            {error && <p className="booking-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}

// The latest answers buyers gave after viewings, across every listing, so
// the agent sees them without opening each card.
function RecentFeedback({ feedback, listings }) {
  const fortnight = Date.now() - 14 * 864e5;
  const recent = feedback.filter((f) => new Date(f.answered_at).getTime() > fortnight).slice(0, 5);
  if (!recent.length) return null;
  const address = Object.fromEntries(listings.map((l) => [l.id, l.address]));
  return (
    <section className="card agent-feedback agent-recent-feedback">
      <h3>How viewings went</h3>
      <ul>
        {recent.map((f) => (
          <li key={f.booking_id}>
            <FeedbackTag feedback={f} />
            <span className="muted">
              {" "}
              {f.buyer_name} · {address[f.listing_id] || "a listing"}, {dayFormatter.format(new Date(f.viewing_at))}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// "Your branch" this month (migration 035): only for agents who share a
// branch sign-up code with someone else. Totals only, never per agent.
function BranchStats({ agent, refreshKey }) {
  const [stats, setStats] = useState(null);

  useEffect(() => {
    if (!agent.signup_code) return;
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    supabase.rpc("branch_stats", { p_since: start.toISOString() }).then(({ data, error }) => {
      // Before migration 035 this fails: show nothing.
      if (error) return;
      setStats(Array.isArray(data) ? data[0] : data);
    });
  }, [agent.signup_code, refreshKey]);

  if (!agent.signup_code || !stats || stats.agents < 2) return null;
  const monthName = new Date().toLocaleDateString("en-GB", { month: "long" });
  const feedbackPct = stats.viewings_done ? Math.round((stats.feedback_received * 100) / stats.viewings_done) : null;
  const rows = [
    [stats.bookings, `viewing${stats.bookings === 1 ? "" : "s"} booked without a call`],
    [stats.homes_sent, `home${stats.homes_sent === 1 ? "" : "s"} sent to matching buyers`],
    [feedbackPct === null ? "–" : `${feedbackPct}%`, "of viewings got feedback"],
    [stats.offers, `offer${stats.offers === 1 ? "" : "s"}`],
    [stats.minutes_saved ? hoursAndMinutes(stats.minutes_saved) : "–", "saved, roughly"],
  ];
  return (
    <section className="card agent-branch">
      <h3>
        Your branch <span className="muted">· {monthName}, {stats.agents} agents</span>
      </h3>
      <ul className="agent-branch-stats">
        {rows.map(([value, label]) => (
          <li key={label}>
            <strong>{value}</strong>
            <span>{label}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Which tab each getting-started step's target lives on.
const TARGET_VIEW = { "agent-add-listing": "listings", "agent-listings": "listings", "agent-hours": "settings" };

function AgentDashboard({ agent, email, view, setView, isBuyer, onLogOut, onAgentChanged }) {
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
  const [addingListing, setAddingListing] = useState(false);
  // Buyers' answers after viewings (migration 035), newest first.
  const [feedback, setFeedback] = useState([]);
  // The booking sheet: { booking, slot, listing } or null.
  const [sheet, setSheet] = useState(null);
  // "Open listing" from the sheet: which card to open ({ id }, new each time).
  const [focus, setFocus] = useState(null);

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
      statusesResult,
      feedbackResult,
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
      // Paused or found somewhere (migration 029); fails quietly before it.
      supabase.rpc("agent_buyer_statuses"),
      // Feedback after viewings (migration 035); fails quietly before it.
      supabase.rpc("agent_viewing_feedback"),
    ]);
    setAvailability(availabilityResult.data || null);
    setHours(hoursResult.data || []);
    setTimeOff(timeOffResult.data || []);
    setBlocked(new Set((blockedResult.data || []).map((row) => (typeof row === "string" ? row : Object.values(row)[0]))));
    setOffers(offersResult.data || []);
    setFeedback(feedbackResult.error ? [] : feedbackResult.data || []);
    // Each buyer's position (if shared) and search status, under one key.
    const byBuyer = {};
    for (const p of positionsResult.data || []) byBuyer[p.buyer_id] = { ...p };
    for (const s of statusesResult.data || []) {
      byBuyer[s.buyer_id] = { ...(byBuyer[s.buyer_id] || { status_only: true }), search: s };
    }
    setPositions(byBuyer);
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

  // A booking's own feedback, or failing that what the same buyer said last
  // time they saw this home ("Last time: Want a second look").
  const feedbackFor = useMemo(() => {
    const byBooking = {};
    const latest = {};
    for (const f of feedback) {
      byBooking[f.booking_id] = f;
      const key = `${f.listing_id}|${(f.buyer_email || "").toLowerCase()}`;
      if (!latest[key]) latest[key] = f;
    }
    const listingOfSlot = Object.fromEntries(slots.map((s) => [s.id, s.listing_id]));
    return (booking) => {
      if (byBooking[booking.id]) return { feedback: byBooking[booking.id], earlier: false };
      const earlier = latest[`${listingOfSlot[booking.slot_id]}|${(booking.buyer_email || "").toLowerCase()}`];
      return earlier ? { feedback: earlier, earlier: true } : null;
    };
  }, [feedback, slots]);

  const feedbackByListing = useMemo(() => {
    const map = {};
    for (const f of feedback) (map[f.listing_id] ||= []).push(f);
    return map;
  }, [feedback]);

  const closeSheet = useCallback(() => setSheet(null), []);

  function openListing(listingId) {
    setSheet(null);
    setFocus({ id: listingId });
    if (view !== "listings") setView("listings");
    setTimeout(
      () => document.getElementById(`listing-${listingId}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
      60
    );
  }

  const upcomingBooked = slots.filter((slot) => bookingsBySlot[slot.id]?.length).length;
  const bookedCount = slots.reduce((sum, slot) => sum + (bookingsBySlot[slot.id]?.length || 0), 0);

  const hoursCard = (
    <AgentHours
      agentId={agent.user_id}
      availability={availability}
      hours={hours}
      timeOff={timeOff}
      bookedSlots={slots.filter((slot) => bookingsBySlot[slot.id]?.length)}
      onChanged={load}
    />
  );

  // Getting started: open the tab the step lives on, then scroll to it.
  function goTo(target) {
    if (target === "agent-add-listing") setAddingListing(true);
    const tab = TARGET_VIEW[target];
    if (tab && tab !== view) setView(tab);
    setTimeout(() => document.getElementById(target)?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);
  }

  const heading = (title, text) => (
    <header className="agent-dashboard-head">
      <div>
        <p className="eyebrow">{[agent.agency, agent.branch].filter(Boolean).join(" · ")}</p>
        <h2>{title}</h2>
        {text && <p className="muted">{text}</p>}
      </div>
    </header>
  );

  if (loading) {
    return (
      <div className="agent-dashboard">
        <p className="muted">Loading...</p>
      </div>
    );
  }

  // Every tab stays in the page, hidden when not chosen, so switching tab
  // keeps a half-typed listing, open cards and scroll-to targets.
  const tab = (id, content) => (
    <div key={id} hidden={view !== id}>
      {content}
    </div>
  );

  return (
    <>
      {tab(
        "today",
        <div className="agent-dashboard">
          {heading(
            "Today",
            bookedCount
              ? `${bookedCount} buyer${bookedCount === 1 ? "" : "s"} booked across ${upcomingBooked} upcoming time${upcomingBooked === 1 ? "" : "s"}.`
              : "No bookings yet. Buyers who've saved one of your listings will see the times you add."
          )}

          <AgentTrialBanner agent={agent} onChanged={onAgentChanged} openCallFromLink />

          <TimeSaved refreshKey={listings.length + bookedCount + offers.length} />

          <BranchStats agent={agent} refreshKey={listings.length + bookedCount + offers.length} />

          <AgentGettingStarted
            agentId={agent.user_id}
            listings={listings}
            slots={slots}
            reach={reach}
            hoursSet={!!availability}
            onGo={goTo}
          />

          {/* What needs doing: offers to answer, then who you're seeing. */}
          <OfferRequests offers={offers} positions={positions} onChanged={load} />

          {listings.length > 0 && (
            <AgentAgenda
              listings={listings}
              slots={slots}
              bookingsBySlot={bookingsBySlot}
              positions={positions}
              feedbackFor={feedbackFor}
              onOpen={setSheet}
            />
          )}

          <RecentFeedback feedback={feedback} listings={listings} />

          {listings.length > 0 && (
            <button type="button" className="secondary-button agent-today-more" onClick={() => setView("calendar")}>
              See the full calendar
            </button>
          )}
        </div>
      )}
      {tab(
        "listings",
        <div className="agent-dashboard">
          {heading(
            "Listings",
            listings.length
              ? `${listings.length} listing${listings.length === 1 ? "" : "s"}. Tap one to change its status, times or price.`
              : "Paste a Rightmove, Zoopla or OnTheMarket link and we fill in the rest."
          )}

          <section className="card agent-add-section" id="agent-add-listing">
            {addingListing || listings.length === 0 ? (
              <>
                <div className="section-header">
                  <h3>Add a listing</h3>
                  {listings.length > 0 && (
                    <button type="button" className="link-button" onClick={() => setAddingListing(false)}>
                      Close
                    </button>
                  )}
                </div>
                <ListingForm
                  agentId={agent.user_id}
                  onSaved={() => {
                    // The first listing would otherwise close the form and hide
                    // its "Added, sent to N buyers" confirmation.
                    setAddingListing(true);
                    load();
                  }}
                />
              </>
            ) : (
              <button type="button" className="primary-button agent-add-button" onClick={() => setAddingListing(true)}>
                + Add a listing
              </button>
            )}
          </section>

          <div id="agent-listings" />
          {listings.length > 0 && (
            <h3 className="agent-listings-head">
              Your listings <span className="muted">({listings.length})</span>
            </h3>
          )}
          {listings.map((listing) => (
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
              // A few listings: show them in full. Lots: compact, tap to open.
              startOpen={listings.length <= 2}
              feedback={feedbackByListing[listing.id] || []}
              feedbackFor={feedbackFor}
              onOpenBooking={setSheet}
              focus={focus}
              onChanged={load}
            />
          ))}
        </div>
      )}
      {tab(
        "calendar",
        <div className="agent-dashboard">
          {heading("Calendar", "Every viewing across your listings.")}
          <AgentCalendar
            listings={listings}
            slots={slots}
            bookingsBySlot={bookingsBySlot}
            positions={positions}
            timeOff={timeOff}
            feedbackFor={feedbackFor}
            onOpen={setSheet}
          />
        </div>
      )}
      {tab(
        "settings",
        <div className="agent-dashboard">
          {heading("Settings")}
          <AgentTrialBanner agent={agent} onChanged={onAgentChanged} />
          <AgentSettings agent={agent} email={email} hoursCard={hoursCard} isBuyer={isBuyer} onLogOut={onLogOut} />
        </div>
      )}
      {sheet && (
        <BookingSheet
          // A fresh sheet for each booking (no leftover "Are you sure?").
          key={sheet.booking.id}
          item={sheet}
          positions={positions}
          feedbackFor={feedbackFor}
          onClose={closeSheet}
          onOpenListing={openListing}
          onChanged={load}
        />
      )}
    </>
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

// The agent's tabs, in the same bottom bar as the buyer app.
const AGENT_TABS = [
  { id: "today", label: "Today", icon: "dashboard" },
  { id: "listings", label: "Listings", icon: "properties" },
  { id: "calendar", label: "Calendar" },
  { id: "settings", label: "Settings" },
];

// Links can open a tab directly, e.g. /agent?view=calendar
function initialAgentView() {
  const view = new URLSearchParams(window.location.search).get("view");
  return AGENT_TABS.some((tab) => tab.id === view) ? view : "today";
}

async function logOut() {
  await forgetThisPhone();
  supabase.auth.signOut({ scope: "local" });
}

function AgentPortal() {
  const [view, setView] = useState(initialAgentView);
  const [user, setUser] = useState(undefined);
  const [agent, setAgent] = useState(undefined);
  // Whose profile `agent` is: until it's this login's, show "Loading..."
  // rather than flashing the set-up form at an agent who has a profile.
  const [agentFor, setAgentFor] = useState(undefined);
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
      setAgentFor(user);
      return;
    }
    const [{ data }, { data: member }] = await Promise.all([
      supabase.from("agents").select("*").eq("user_id", user.id).maybeSingle(),
      supabase.rpc("is_household_member"),
    ]);
    setAgent(data || null);
    setAgentFor(user.id);
    // Also a buyer (same login): offer a way back to the buyer app.
    setIsBuyer(member === true);
  }, [user]);

  useEffect(() => {
    loadAgent();
  }, [loadAgent]);

  // iPhone app: notifications for new bookings, cancellations and offers.
  // Keep this phone's token current, and offer it once.
  const [offerPush, setOfferPush] = useState(false);
  useEffect(() => {
    if (!agent) return;
    refreshPushRegistration();
    shouldOfferPush().then(setOfferPush).catch(() => {});
  }, [agent]);

  return (
    // signed-in: on a phone, room for the bottom tab bar and a compact header.
    <div className={`app-shell${user && agent ? " signed-in" : ""}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">ViewPal for agents</p>
          <h1>{agent ? agent.name : "Viewing bookings"}</h1>
        </div>
        {/* With a profile, these live in the Settings tab instead. */}
        {user && agentFor === user.id && !agent && (
          <div className="agent-header-actions">
            {isBuyer && (
              <a className="secondary-button" href="/">
                ← Buyer app
              </a>
            )}
            <button type="button" className="secondary-button" onClick={logOut}>
              Log Out
            </button>
          </div>
        )}
      </header>

      {user && agent && !settingPassword && (
        <NavigationTabs activeView={view} setActiveView={setView} tabs={AGENT_TABS} />
      )}

      <main className="app-main">
        {agent && offerPush && (
          <div className="push-offer" role="status">
            <p>Get a notification the moment a buyer books, cancels or reports an offer.</p>
            <div className="push-offer-actions">
              <button
                type="button"
                className="primary-button"
                onClick={async () => {
                  setOfferPush(false);
                  try {
                    await enablePush();
                  } catch (error) {
                    console.error("Could not turn on notifications:", error);
                  }
                }}
              >
                Turn on
              </button>
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  dismissPushOffer();
                  setOfferPush(false);
                }}
              >
                Not now
              </button>
            </div>
          </div>
        )}
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
        ) : user === undefined || (user && agentFor !== user.id) ? (
          <p className="muted">Loading...</p>
        ) : !user ? (
          <AgentAuth />
        ) : !agent && inviteFromLink() ? (
          // An invite makes a new login, so it can't be used from this one
          // (the profile form below would ask for a branch code).
          <section className="card agent-auth">
            <p>This invite is for a new agent account. Log out, then open the link again.</p>
            <button type="button" className="primary-button" onClick={logOut}>
              Log out
            </button>
          </section>
        ) : !agent ? (
          <>
            <AgentProfileForm user={user} onCreated={loadAgent} />
            <DeleteAccount />
          </>
        ) : (
          <AgentDashboard
            agent={agent}
            email={user.email}
            view={view}
            setView={setView}
            isBuyer={isBuyer}
            onLogOut={logOut}
            onAgentChanged={loadAgent}
          />
        )}
      </main>
      <footer className="app-footer muted">
        <a href="/privacy">Privacy policy</a>
      </footer>
    </div>
  );
}

export default AgentPortal;
