import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { isProceedable } from "../components/BuyerPositionSettings";
import { proofLabel } from "../components/PositionProof";
import LoadError from "../components/LoadError";
import { setSearchStatus, statusSummary } from "../components/SearchStatus";
import "./DashboardView.css";

// The buyer's "what needs my attention" page: things to act on, what's coming
// up this week, what changed on their homes, where the search stands, and
// whether they're ready to buy. Sections with nothing in them are hidden.

const RULED_OUT = ["ignored", "archived", "lost"];
const STAGES = [
  { key: "new", label: "New", statuses: ["new", null], view: "properties" },
  { key: "favourite", label: "Shortlisted", statuses: ["favourite"], view: "history" },
  { key: "viewing", label: "Viewing booked", statuses: ["viewing_booked"], view: "history" },
  { key: "viewed", label: "Viewed", statuses: ["viewed"], view: "history" },
  { key: "offer", label: "Offer", statuses: ["offer_considered", "offer_made"], view: "history" },
  { key: "accepted", label: "Accepted", statuses: ["offer_accepted"], view: "history" },
];
// Sold or withdrawn: "Tidy up" archives these. Under offer is shown for
// information only, since those sales often fall through.
const GONE = { sold_stc: "sold STC", removed: "taken off the market" };
const DAY = 864e5;

const pounds = (n) => `£${Number(n).toLocaleString("en-GB")}`;
const when = (iso) =>
  new Date(iso).toLocaleString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
const place = (p) => p?.address || p?.title || "A saved home";

async function loadEverything() {
  const now = new Date();
  const weekAgo = new Date(now - 7 * DAY).toISOString();
  const weekAhead = new Date(now.getTime() + 7 * DAY).toISOString();

  const [homes, viewings, requests, offers, position, recent, household] = await Promise.all([
    supabase
      .from("properties")
      .select("id, address, title, price, initial_price, status, listing_status, last_price_change_at"),
    supabase
      .from("property_notes")
      .select("id, viewing_datetime, estate_agent, properties ( id, address, title )")
      .gte("viewing_datetime", now.toISOString())
      .lte("viewing_datetime", weekAhead)
      .order("viewing_datetime"),
    supabase
      .from("booking_requests")
      .select("id, kind, status, starts_at, ends_at, agent_name, agency, property_address")
      .in("status", ["pending", "accepted"])
      .gte("ends_at", now.toISOString())
      .order("starts_at"),
    supabase.from("offers").select("id, property_id, amount, status, reported_at").neq("status", "withdrawn"),
    supabase.from("buyer_positions").select("*").maybeSingle(),
    // Viewings in the last fortnight, for "How did it go?".
    supabase
      .from("property_notes")
      .select("*, properties ( id, address, title, status )")
      .gte("viewing_datetime", new Date(now - 14 * DAY).toISOString())
      .lt("viewing_datetime", now.toISOString())
      .order("viewing_datetime", { ascending: false }),
    // Paused or found somewhere (migration 029).
    supabase.rpc("my_household"),
  ]);
  // A failed load should say so, not look like an empty dashboard.
  const failed = [homes, viewings, requests, offers].find((r) => r.error);
  if (failed) throw failed.error;

  const allHomes = homes.data || [];
  const changed = allHomes.filter(
    (p) => p.last_price_change_at && p.last_price_change_at >= weekAgo && !RULED_OUT.includes(p.status)
  );
  let history = [];
  if (changed.length) {
    const { data } = await supabase
      .from("price_history")
      .select("property_id, price, observed_at")
      .in("property_id", changed.map((p) => p.id))
      .order("observed_at", { ascending: false });
    history = data || [];
  }
  // Previous asking price = the one before the latest change.
  const drops = changed
    .map((p) => {
      const prices = history.filter((h) => h.property_id === p.id).map((h) => h.price);
      const previous = prices.length > 1 ? prices[1] : p.initial_price;
      return { ...p, previous };
    })
    .filter((p) => p.previous && p.price && p.price < p.previous)
    .sort((a, b) => b.last_price_change_at.localeCompare(a.last_price_change_at));

  return {
    homes: allHomes,
    drops,
    viewings: viewings.data || [],
    requests: requests.data || [],
    offers: offers.data || [],
    position: position.data || null,
    searchStatus: household.data?.search_status || "searching",
    pausedUntil: household.data?.paused_until || null,
    // Been to see it, nothing written down yet.
    toReview: (recent.data || []).filter(
      (v) =>
        v.properties &&
        ["viewing_booked", "viewed"].includes(v.properties.status) &&
        !v.positives &&
        !v.negatives &&
        !v.general_notes &&
        !v.viewing_notes &&
        !Object.keys(v.checklist || {}).length
    ),
  };
}

function Section({ title, children, action }) {
  return (
    <section className="card dash-section">
      <div className="dash-section-head">
        <h3>{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}

function DashboardView({ onNavigate }) {
  const [data, setData] = useState(null);
  // Last tidy-up, so it can be undone: [{ id, status }] as they were before.
  const [undo, setUndo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);

  const load = useCallback(() => {
    setLoadError(null);
    loadEverything()
      .then(setData)
      .catch((error) => {
        console.error("Error loading dashboard:", error);
        setLoadError(error);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Back from a pause or a sale that fell through: tell agents, catch up.
  const [resumed, setResumed] = useState("");
  async function lookAgain() {
    setBusy(true);
    try {
      const { caughtUp } = await setSearchStatus("searching");
      setResumed(
        caughtUp
          ? `Welcome back. ${caughtUp} matching home${caughtUp === 1 ? "" : "s"} added to your list.`
          : "Welcome back. Agents will send you matching homes again."
      );
      load();
    } catch (error) {
      console.error("Could not resume search:", error);
      setResumed("Couldn't save that. Try again in Settings.");
    } finally {
      setBusy(false);
    }
  }

  if (loadError && !data) return <LoadError error={loadError} onRetry={load} />;

  if (!data) {
    return (
      <section className="card">
        <p>Loading...</p>
      </section>
    );
  }

  const go = (view, section) => () => onNavigate?.(view, section);
  const homesById = Object.fromEntries(data.homes.map((p) => [p.id, p]));
  const active = data.homes.filter((p) => !RULED_OUT.includes(p.status));
  const ruledOut = data.homes.length - active.length;
  const pos = data.position;

  // ---- Needs you ----
  const needs = [];
  for (const r of data.requests.filter((r) => r.status === "pending")) {
    needs.push({
      key: `req-${r.id}`,
      tone: "act",
      text: `${r.agent_name}${r.agency ? ` (${r.agency})` : ""} asked for a ${r.kind} on ${when(r.starts_at)}${
        r.property_address ? ` about ${r.property_address}` : ""
      }`,
      action: "Answer",
      onClick: go("calendar"),
    });
  }
  // Been to a viewing and written nothing down: ask while it's fresh.
  for (const v of data.toReview || []) {
    const home = v.properties;
    needs.push({
      key: `review-${v.id}`,
      tone: "act",
      text: `How did ${place(home)} go? Jot down what you liked while it's fresh`,
      action: "Add notes",
      onClick: async () => {
        if (home.status === "viewing_booked") {
          await supabase.from("properties").update({ status: "viewed" }).eq("id", home.id);
        }
        onNavigate?.("history", null, home.id);
      },
    });
  }
  for (const o of data.offers) {
    const home = homesById[o.property_id];
    if (o.status === "disputed") {
      needs.push({
        key: `off-${o.id}`,
        tone: "act",
        text: `The agent says your accepted offer of ${pounds(o.amount)} on ${place(home)} isn't right`,
        action: "Check",
        onClick: go("history"),
      });
    } else if (o.status === "awaiting_agent" && Date.now() - new Date(o.reported_at) > 3 * DAY) {
      needs.push({
        key: `off-${o.id}`,
        tone: "info",
        text: `Still waiting for the agent to confirm your offer on ${place(home)}. Worth a nudge?`,
        action: "View",
        onClick: go("history"),
      });
    }
  }
  if (pos?.aip_expires && ["aip", "offer"].includes(pos.mortgage_status)) {
    const days = Math.ceil((new Date(`${pos.aip_expires}T23:59:59`) - Date.now()) / DAY);
    if (days < 0) {
      needs.push({
        key: "aip",
        tone: "act",
        text: "Your mortgage agreement has expired, so agents no longer see you as proceedable",
        action: "Update",
        onClick: go("settings", "position"),
      });
    } else if (days <= 30) {
      needs.push({
        key: "aip",
        tone: "info",
        text: `Your mortgage agreement expires in ${days} day${days === 1 ? "" : "s"}`,
        action: "Update",
        onClick: go("settings", "position"),
      });
    }
  }
  // Never tidy away a home you have an accepted offer on.
  const gone = active.filter((p) => GONE[p.listing_status] && p.status !== "offer_accepted");
  if (gone.length) {
    const names = gone.slice(0, 2).map(place).join(", ");
    needs.push({
      key: "gone",
      tone: "info",
      text:
        gone.length === 1
          ? `${names} is ${GONE[gone[0].listing_status]}`
          : `${gone.length} of your homes are no longer available: ${names}${gone.length > 2 ? ` and ${gone.length - 2} more` : ""}`,
      action: gone.length === 1 ? "Archive it" : "Archive them",
      onClick: () => archiveGone(gone),
    });
  }
  const underOffer = active.filter((p) => p.listing_status === "under_offer" && p.status !== "offer_accepted");
  if (underOffer.length) {
    const names = underOffer.slice(0, 2).map(place).join(", ");
    needs.push({
      key: "under-offer",
      tone: "info",
      text: `${names}${underOffer.length > 2 ? ` and ${underOffer.length - 2} more` : ""} ${
        underOffer.length === 1 ? "is" : "are"
      } under offer. Sales often fall through, so it's worth keeping an eye on`,
      action: "View",
      onClick: go(underOffer.some((p) => p.status && p.status !== "new") ? "history" : "properties"),
    });
  }

  async function archiveGone(homes) {
    const list = homes.map((p) => `• ${place(p)} (${GONE[p.listing_status]})`).join("\n");
    if (!window.confirm(`Archive ${homes.length === 1 ? "this home" : `these ${homes.length} homes`}?\n\n${list}\n\nYou can undo this straight after.`)) {
      return;
    }
    setBusy(true);
    const { error } = await supabase
      .from("properties")
      .update({ status: "archived" })
      .in("id", homes.map((p) => p.id));
    setBusy(false);
    if (error) {
      console.error("Archive failed:", error);
      window.alert("Couldn't archive them. Please try again.");
      return;
    }
    setUndo(homes.map((p) => ({ id: p.id, status: p.status ?? null })));
    load();
  }

  async function undoArchive() {
    setBusy(true);
    // Put each home back to the status it had (grouped, one update per status).
    const byStatus = {};
    for (const h of undo) (byStatus[h.status ?? "__null"] ||= []).push(h.id);
    let failed = false;
    for (const [status, ids] of Object.entries(byStatus)) {
      const { error } = await supabase
        .from("properties")
        .update({ status: status === "__null" ? null : status })
        .in("id", ids);
      if (error) failed = true;
    }
    setBusy(false);
    if (failed) {
      window.alert("Couldn't undo all of them. You can restore them from the Watchlist.");
    }
    setUndo(null);
    load();
  }

  // Things to act on first, then things to know.
  needs.sort((a, b) => (a.tone === b.tone ? 0 : a.tone === "act" ? -1 : 1));

  // ---- Coming up ----
  const upcoming = [
    ...data.viewings.map((v) => ({
      key: `v-${v.id}`,
      at: v.viewing_datetime,
      what: "Viewing",
      where: place(v.properties),
      who: v.estate_agent,
    })),
    ...data.requests
      .filter((r) => r.status === "accepted" && new Date(r.starts_at) - Date.now() < 7 * DAY)
      .map((r) => ({
        key: `r-${r.id}`,
        at: r.starts_at,
        what: r.kind === "call" ? "Call" : "Viewing",
        where: r.property_address || "",
        who: [r.agent_name, r.agency].filter(Boolean).join(", "),
      })),
  ].sort((a, b) => a.at.localeCompare(b.at));

  // ---- Pipeline ----
  const counts = STAGES.map((s) => ({
    ...s,
    count: data.homes.filter((p) => s.statuses.includes(p.status ?? null)).length,
  }));

  if (!data.homes.length) {
    return (
      <section className="card empty-state">
        <h3>Your dashboard fills up as you go</h3>
        <p>
          Save a few homes and it will show what needs doing, your viewings this week and any price
          drops.
        </p>
        <button type="button" className="primary-button" onClick={go("properties")}>
          Add your first home
        </button>
      </section>
    );
  }

  return (
    <div className="dashboard-page">
      {data.searchStatus !== "searching" && (
        <section className="card search-status-banner" role="status">
          <p>{statusSummary(data.searchStatus, data.pausedUntil)}</p>
          {resumed ? (
            <p className="muted">{resumed}</p>
          ) : (
            <button type="button" className="primary-button" disabled={busy} onClick={lookAgain}>
              I'm looking again
            </button>
          )}
        </section>
      )}
      <Section title="Needs you">
        {undo && (
          <p className="dash-undo" role="status">
            Archived {undo.length} home{undo.length === 1 ? "" : "s"}.
            <button type="button" className="link-button" disabled={busy} onClick={undoArchive}>
              Undo
            </button>
          </p>
        )}
        {needs.length ? (
          <ul className="dash-list">
            {needs.map((n) => (
              <li key={n.key} className={`dash-need ${n.tone}`}>
                <span className="dash-dot" aria-hidden="true" />
                <span className="dash-text">{n.text}</span>
                <button type="button" className="secondary-button" disabled={busy} onClick={n.onClick}>
                  {n.action}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted dash-calm">Nothing needs you right now.</p>
        )}
      </Section>

      <Section
        title="Coming up this week"
        action={
          <button type="button" className="link-button" onClick={go("calendar")}>
            Calendar
          </button>
        }
      >
        {upcoming.length ? (
          <ul className="dash-list">
            {upcoming.map((u) => (
              <li key={u.key} className="dash-event">
                <span className="dash-when">{when(u.at)}</span>
                <span className="dash-text">
                  <strong>{u.what}</strong>
                  {u.where ? ` · ${u.where}` : ""}
                  {u.who && <span className="muted"> · {u.who}</span>}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted dash-calm">No viewings in the next 7 days.</p>
        )}
      </Section>

      {data.drops.length > 0 && (
        <Section title="Price drops this week">
          <ul className="dash-list">
            {data.drops.slice(0, 5).map((p) => {
              const cut = p.previous - p.price;
              return (
                <li key={p.id} className="dash-drop">
                  <span className="dash-text">{place(p)}</span>
                  <span className="dash-price">
                    <s>{pounds(p.previous)}</s> {pounds(p.price)}
                    <span className="dash-cut">
                      −{pounds(cut)} ({Math.round((cut * 100) / p.previous)}%)
                    </span>
                  </span>
                </li>
              );
            })}
          </ul>
          {data.drops.length > 5 && <p className="muted">and {data.drops.length - 5} more</p>}
        </Section>
      )}

      <Section title="Your search">
        <ol className="dash-pipeline">
          {counts.map((s) => (
            <li key={s.key}>
              <button type="button" onClick={go(s.view)} className={s.count ? "" : "empty"}>
                <strong>{s.count}</strong>
                <span>{s.label}</span>
              </button>
            </li>
          ))}
        </ol>
        <p className="muted dash-footnote">
          {active.length} home{active.length === 1 ? "" : "s"} in play
          {ruledOut ? ` · ${ruledOut} ruled out` : ""}
        </p>
      </Section>

      <Section title="Ready to buy?">
        {pos ? (
          <div className="dash-ready">
            <p className={`position-badge ${isProceedable(pos) ? "ready" : ""}`}>
              {isProceedable(pos)
                ? "✓ Agents see you as a proceedable buyer"
                : "Not shown as proceedable yet: agents favour buyers with funding sorted and nothing to sell"}
            </p>
            <ul className="dash-facts">
              {pos.max_budget && <li>Budget up to {pounds(pos.max_budget)}</li>}
              {pos.buying_with === "cash" && <li>Cash buyer</li>}
              {pos.buying_with === "mortgage" && (
                <li>
                  {pos.mortgage_status === "offer"
                    ? "Mortgage offer"
                    : pos.mortgage_status === "aip"
                      ? "Agreement in principle"
                      : "Mortgage not arranged yet"}
                  {pos.aip_expires &&
                    ` · expires ${new Date(pos.aip_expires).toLocaleDateString("en-GB", {
                      day: "numeric",
                      month: "short",
                    })}`}
                </li>
              )}
              {(pos.buying_with === "cash" || ["aip", "offer"].includes(pos.mortgage_status)) && (
                <li>{pos.proof_path ? `Proof uploaded (${proofLabel(pos)})` : "No proof uploaded yet"}</li>
              )}
              {!pos.share_with_agents && <li>Hidden from agents</li>}
            </ul>
            <button type="button" className="link-button" onClick={go("settings", "position")}>
              Update your buying position
            </button>
          </div>
        ) : (
          <div className="dash-ready">
            <p className="muted">
              Tell agents whether you can move quickly: funding, chain and solicitor. Proceedable
              buyers get taken more seriously.
            </p>
            <button type="button" className="secondary-button" onClick={go("settings", "position")}>
              Add your buying position
            </button>
          </div>
        )}
      </Section>
    </div>
  );
}

export default DashboardView;
