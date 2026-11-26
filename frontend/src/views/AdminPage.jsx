import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import AuthForm from "../components/AuthForm";
import SetupCalls from "../components/AdminSetupCalls";
import "./AdminPage.css";

// Founder's dashboard: /admin. Live numbers and targets from admin_metrics()
// (migration 018), which only answers accounts in app_admins. Everyone else,
// signed in or not, sees an ordinary "page not found": nothing on this page
// says what it is until the database has confirmed an admin.
//
// Targets are deliberately not in this file: the repository and the site's
// code are public. They live in the admin_targets table.

// 'trial': an agent a buyer invited, on a 14-day free trial (migration 034).
const PLANS = ["pilot", "paying", "cancelled", "trial"];

// The period we're in (or the last one, once they've all passed).
function currentTarget(targets, now = new Date()) {
  if (!targets?.length) return null;
  return targets.find((t) => now <= new Date(`${t.ends}T23:59:59`)) || targets[targets.length - 1];
}

// The three months ending with the target's end date, as "YYYY-MM".
function quarterMonths(target) {
  const end = new Date(`${target.ends}T00:00:00`);
  return [2, 1, 0].map((back) => {
    const d = new Date(end.getFullYear(), end.getMonth() - back, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
  });
}

const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : null);
const pounds = (n) => `£${Number(n || 0).toLocaleString("en-GB")}`;
const shortDate = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "–";

function TargetTile({ label, actual, target, format = (n) => n.toLocaleString("en-GB"), note }) {
  if (target === null || target === undefined) {
    return (
      <div className="admin-tile">
        <span className="admin-tile-label">{label}</span>
        <span className="admin-tile-value">{format(actual)}</span>
        <span className="admin-tile-target">no target set</span>
        {note && <span className="admin-tile-note">{note}</span>}
      </div>
    );
  }
  const share = target ? Math.min(actual / target, 1) : actual > 0 ? 1 : 0;
  return (
    <div className="admin-tile">
      <span className="admin-tile-label">{label}</span>
      <span className="admin-tile-value">{format(actual)}</span>
      <span className="admin-tile-target">
        target {format(target)}
        {target ? ` · ${Math.round((actual / target) * 100)}%` : ""}
      </span>
      <div
        className="admin-progress"
        role="progressbar"
        aria-label={`${label}: ${format(actual)} of ${format(target)}`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(share * 100)}
      >
        <span style={{ width: `${share * 100}%` }} />
      </div>
      {note && <span className="admin-tile-note">{note}</span>}
    </div>
  );
}

function RateTile({ label, value, detail, target }) {
  return (
    <div className="admin-tile small">
      <span className="admin-tile-label">{label}</span>
      <span className="admin-tile-value">{value === null ? "–" : `${value}%`}</span>
      <span className="admin-tile-target">
        {detail}
        {target ? ` · target ${target}` : ""}
      </span>
    </div>
  );
}

// One series, one axis: bars with their value on hover, plus a table for
// screen readers.
function BarChart({ title, points, labelFor, unit }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  return (
    <figure className="admin-chart">
      <figcaption>
        <strong>{title}</strong>
        <span className="muted"> · peak {max === 1 && !points.some((p) => p.value) ? 0 : max}</span>
      </figcaption>
      <div className="admin-bars" aria-hidden="true">
        {!points.some((p) => p.value) && <span className="admin-empty">None yet</span>}
        {points.map((p) => (
          <div className="admin-bar-slot" key={p.period}>
            <div className="admin-bar" style={{ height: `${(p.value / max) * 100}%` }} />
            <span className="admin-bar-tip">
              {labelFor(p.period)}: {p.value} {unit}
            </span>
          </div>
        ))}
      </div>
      <div className="admin-axis" aria-hidden="true">
        <span>{labelFor(points[0]?.period)}</span>
        <span>{labelFor(points[points.length - 1]?.period)}</span>
      </div>
      <table className="visually-hidden">
        <caption>{title}</caption>
        <tbody>
          {points.map((p) => (
            <tr key={p.period}>
              <th scope="row">{labelFor(p.period)}</th>
              <td>{p.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

const weekLabel = (iso) =>
  iso ? `w/c ${new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : "";
const monthLabel = (iso) =>
  iso ? new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "2-digit" }) : "";

// One branch (pricing is per branch): its people, activity added up across
// them, and one plan and fee (migration 021).
function BranchRow({ branch, onSaved }) {
  const [plan, setPlan] = useState(branch.plan);
  const [fee, setFee] = useState(branch.monthly_fee ?? "");
  const [busy, setBusy] = useState(false);
  const changed = plan !== branch.plan || String(fee) !== String(branch.monthly_fee ?? "");

  async function save() {
    setBusy(true);
    const { error } = await supabase.rpc("admin_set_branch_billing", {
      p_branch: branch.branch_key,
      p_plan: plan,
      p_fee: fee === "" ? null : Math.round(Number(String(fee).replace(/[£,\s]/g, ""))),
    });
    setBusy(false);
    if (error) {
      window.alert(error.message);
      return;
    }
    onSaved();
  }

  const people = branch.people_list || [];
  const unused = branch.people === 0;
  // Quiet: no activity for 30 days, once it's been signed up that long.
  const monthAgo = Date.now() - 30 * 864e5;
  const quiet =
    !unused &&
    new Date(branch.created_at) < monthAgo &&
    (!branch.last_activity || new Date(branch.last_activity) < monthAgo);
  return (
    <tr className={unused ? "admin-row-off" : quiet ? "quiet" : ""}>
      <td>
        <strong>{branch.agency}</strong>
        {branch.branch ? ` · ${branch.branch}` : ""}
        {branch.code && <div className="muted"><code>{branch.code}</code></div>}
        {people.length > 0 && (
          <div className="muted admin-people">
            {people.map((person, i) => (
              <span key={person.email}>
                {i > 0 && ", "}
                <a href={`mailto:${person.email}`}>{person.name}</a>
              </span>
            ))}
          </div>
        )}
      </td>
      <td className="num">
        {branch.people}
        {branch.seats ? ` / ${branch.seats}` : ""}
      </td>
      <td>{shortDate(branch.created_at)}</td>
      <td className="num">{branch.listings}</td>
      <td className="num">{branch.slots_30d}</td>
      <td className="num">{branch.viewings_30d}</td>
      <td className="num">{branch.sends_30d}</td>
      <td>
        {unused ? (
          <span className="muted">nobody yet</span>
        ) : quiet ? (
          <span className="admin-flag">quiet 30d+</span>
        ) : (
          shortDate(branch.last_activity)
        )}
      </td>
      <td>
        <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Plan">
          {PLANS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          className="admin-fee"
          inputMode="numeric"
          value={fee}
          onChange={(e) => setFee(e.target.value)}
          placeholder="£/mo"
          aria-label="Monthly fee"
        />
      </td>
      <td>
        {changed && (
          <button type="button" className="secondary-button" disabled={busy} onClick={save}>
            Save
          </button>
        )}
      </td>
    </tr>
  );
}

function Dashboard({ data, onReload }) {
  const load = onReload;
  const target = currentTarget(data.targets) || { quarter: "No targets set", ends: new Date().toISOString().slice(0, 10) };
  const months = quarterMonths(target);
  const offersThisQuarter = (data.offers.by_month || [])
    .filter((m) => months.includes(m.period.slice(0, 7)))
    .reduce((sum, m) => sum + m.value, 0);
  const { buyers, viewings, offers, agents } = data;
  const activation = pct(buyers.cohort_activated, buyers.cohort_size);
  const targetOr = (key) => (target[key] ?? null);
  const perBranch = agents.active_30d ? (viewings.last_30d / agents.active_30d).toFixed(1) : "–";

  return (
    <>
      <section className="card">
        <div className="section-header">
          <div>
            <h2>{target.period ? `${target.period} targets` : "No targets set yet"}</h2>
            <p>
              Year-one plan, as of {new Date(data.generated_at).toLocaleString("en-GB")}. Buyer
              figures leave out your own household.
            </p>
          </div>
          <button type="button" className="secondary-button" onClick={load}>
            Refresh
          </button>
        </div>
        <div className="admin-tiles">
          <TargetTile label="Viewings booked (last 30 days)" actual={viewings.last_30d} target={targetOr("viewings")} note="Main measure" />
          <TargetTile label="Agent branches signed up" actual={agents.total} target={targetOr("branches")} />
          <TargetTile label="Paying branches" actual={agents.paying} target={targetOr("paying")} />
          <TargetTile label="Buyer households" actual={buyers.households} target={targetOr("households")} />
          <TargetTile label={`Offers reported (${target.period || "this quarter"})`} actual={offersThisQuarter} target={targetOr("offers")} />
          <TargetTile label="Monthly recurring revenue" actual={agents.mrr} target={targetOr("mrr")} format={pounds} />
        </div>
        <p className="muted admin-footnote">
          Referral income isn't tracked yet: it starts once partner referrals are built.
        </p>
      </section>

      <section className="card">
        <h2>Health</h2>
        <div className="admin-tiles">
          <RateTile
            label="Activation"
            value={activation}
            detail={`${buyers.cohort_activated} of ${buyers.cohort_size} new households saved 3+ homes and set a search in week 1`}
            target={target.activation_pct != null ? `${target.activation_pct}%` : null}
          />
          <RateTile
            label="Active households (7 days)"
            value={pct(buyers.active_7d, buyers.households)}
            detail={`${buyers.active_7d} of ${buyers.households}`}
          />
          <RateTile
            label="With a buying position"
            value={pct(buyers.with_position, buyers.households)}
            detail={`${buyers.with_position} households, ${buyers.proceedable} proceedable`}
          />
          <RateTile
            label="Position with proof"
            value={pct(buyers.with_proof, buyers.with_position)}
            detail={`${buyers.with_proof} of ${buyers.with_position}`}
          />
          <RateTile
            label="Offers confirmed by the agent"
            value={pct(offers.confirmed, offers.reported)}
            detail={`${offers.confirmed} of ${offers.reported} · ${offers.awaiting} waiting · ${offers.disputed} disputed`}
          />
          <RateTile
            label="Active branches (30 days)"
            value={pct(agents.active_30d, agents.total)}
            detail={`${agents.active_30d} of ${agents.total} · ${perBranch} viewings each`}
          />
          <RateTile
            label="Pilot to paid"
            value={pct(agents.ever_paid, agents.total)}
            detail={`${agents.ever_paid} ever paid · ${agents.cancelled} cancelled`}
            target={target.conversion_pct != null ? `${target.conversion_pct}%` : null}
          />
        </div>
      </section>

      <section className="card admin-charts">
        <BarChart title="New buyer households per week" points={buyers.new_by_week} labelFor={weekLabel} unit="households" />
        <BarChart title="Viewings booked per month" points={viewings.by_month} labelFor={monthLabel} unit="viewings" />
        <BarChart title="Offers reported per month" points={offers.by_month} labelFor={monthLabel} unit="offers" />
      </section>

      <SetupCalls />
      <AgentTrials onChanged={load} />

      <AgentCodes />

      <section className="card">
        <div className="section-header">
          <div>
            <h2>Agent branches</h2>
            <p>
              One row per branch, however many people it has. Billing is set by hand until
              payments are built: mark a branch paying with its monthly fee to count it in
              revenue. {agents.people ?? 0} agent{agents.people === 1 ? "" : "s"} across{" "}
              {agents.total} branch{agents.total === 1 ? "" : "es"}.
            </p>
          </div>
        </div>
        {agents.list.length === 0 ? (
          <p className="muted">No branches yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th className="num">People</th>
                  <th>Joined</th>
                  <th className="num">Listings</th>
                  <th className="num">Slots 30d</th>
                  <th className="num">Viewings 30d</th>
                  <th className="num">Sent 30d</th>
                  <th>Last active</th>
                  <th>Plan</th>
                  <th>Fee</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {agents.list.map((branch) => (
                  <BranchRow key={branch.branch_key} branch={branch} onSaved={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// Agents on a free trial from a buyer's invite (migration 034). Extend a
// trial, or make their branch a code: that puts them on it (the same as
// them typing it in) and emails them the code.
function trialLeft(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return { text: `ended ${shortDate(iso)}`, ended: true };
  const days = Math.ceil(ms / 864e5);
  return { text: `${days} day${days === 1 ? "" : "s"} left`, soon: days <= 4 };
}

function TrialRow({ agent, onChanged, onMessage }) {
  const [making, setMaking] = useState(false);
  const [form, setForm] = useState({ agency: agent.agency || "", branch: agent.branch || "", seats: "1" });
  const [busy, setBusy] = useState(false);
  const left = trialLeft(agent.trial_ends_at);

  async function extend() {
    setBusy(true);
    const { error } = await supabase.rpc("admin_extend_trial", { p_agent: agent.user_id });
    setBusy(false);
    if (error) {
      onMessage(error.message);
      return;
    }
    onMessage(`Extended ${agent.name}'s trial by 14 days.`);
    onChanged();
  }

  async function makeCode(event) {
    event.preventDefault();
    setBusy(true);
    const { data: code, error } = await supabase.rpc("admin_make_trial_code", {
      p_agent: agent.user_id,
      p_agency: form.agency.trim(),
      p_branch: form.branch.trim(),
      p_seats: Number(form.seats),
    });
    if (error) {
      setBusy(false);
      onMessage(error.message);
      return;
    }
    let emailed = false;
    try {
      const response = await postAuthed("/api/agent-signup", { action: "admin_code_email", agentId: agent.user_id });
      const result = await response.json().catch(() => ({}));
      emailed = response.ok && result.emailed;
    } catch {
      emailed = false;
    }
    setBusy(false);
    setMaking(false);
    onMessage(
      emailed
        ? `Made ${code} and put ${agent.name} on it. We've emailed them the code.`
        : `Made ${code} and put ${agent.name} on it, but the email didn't go. Send it to ${agent.email} yourself.`
    );
    onChanged();
  }

  return (
    <li>
      <div>
        <strong>{agent.name}</strong> · {agent.agency}
        {agent.branch ? `, ${agent.branch}` : ""}
        <div className="muted">
          <a href={`mailto:${agent.email}`}>{agent.email}</a>
          {agent.phone ? ` · ${agent.phone}` : ""} · joined {shortDate(agent.created_at)} ·{" "}
          <span className={left.ended || left.soon ? "admin-flag" : ""}>{left.text}</span>
        </div>
        <div className="muted">
          {agent.bookings} booking{agent.bookings === 1 ? "" : "s"} · {agent.listings} listing
          {agent.listings === 1 ? "" : "s"}
          {agent.referred_by_household && (
            <>
              {" "}
              · invited by household <code>{agent.referred_by_household.slice(0, 8)}</code>
            </>
          )}
          {agent.code_requested_at && <> · asked for a code {shortDate(agent.code_requested_at)}</>}
        </div>
        {making && (
          <form className="admin-code-form" onSubmit={makeCode}>
            <label>
              Agency
              <input required maxLength={100} value={form.agency} onChange={(e) => setForm({ ...form, agency: e.target.value })} />
            </label>
            <label>
              Branch
              <input required maxLength={100} value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
            </label>
            <label>
              Seats (people)
              <input
                required
                type="number"
                min={1}
                max={500}
                value={form.seats}
                onChange={(e) => setForm({ ...form, seats: e.target.value })}
              />
            </label>
            <button type="submit" className="primary-button" disabled={busy}>
              {busy ? "Making..." : "Make code and email it"}
            </button>
          </form>
        )}
      </div>
      <div className="admin-code-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={extend}>
          Extend 14 days
        </button>
        <button type="button" className="link-button" onClick={() => setMaking(!making)}>
          {making ? "Cancel" : "Make a branch code"}
        </button>
      </div>
    </li>
  );
}

function AgentTrials({ onChanged }) {
  const [trials, setTrials] = useState(null);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("admin_trial_agents");
    if (error) {
      setMessage(/admin_trial_agents/.test(error.message) ? "Free trials need database migration 034." : error.message);
      setTrials([]);
      return;
    }
    setTrials(data || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="card">
      <div className="section-header">
        <div>
          <h2>Trials</h2>
          <p>
            Agents who joined from a buyer's invite, without a code. After 14 days buyers can't book them until they
            have a branch code.
          </p>
        </div>
      </div>
      {message && <p className="muted">{message}</p>}
      {trials === null ? (
        <p className="muted">Loading...</p>
      ) : trials.length === 0 ? (
        <p className="muted">No agents on a trial.</p>
      ) : (
        <div className="admin-requests">
          <ul>
            {trials.map((agent) => (
              <TrialRow
                key={agent.user_id}
                agent={agent}
                onMessage={setMessage}
                onChanged={() => {
                  load();
                  onChanged();
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// Per-agency sign-up codes (migration 019): make one per agency, send the
// link, switch it off if it gets passed around.
function AgentCodes() {
  const [codes, setCodes] = useState(null);
  const [requests, setRequests] = useState([]);
  const [form, setForm] = useState({ agency: "", branch: "", maxUses: "", note: "" });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState("");

  const load = useCallback(async () => {
    const { data: pending } = await supabase.rpc("admin_seat_requests");
    setRequests(pending || []);
    const { data, error } = await supabase.rpc("admin_agent_codes");
    if (error) {
      setMessage(
        /admin_agent_codes/.test(error.message)
          ? "Sign-up codes need database migration 019."
          : error.message
      );
      setCodes([]);
      return;
    }
    setCodes(data || []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const linkFor = (code) => `${window.location.origin}/agent?code=${encodeURIComponent(code)}`;

  async function create(event) {
    event.preventDefault();
    setBusy(true);
    setMessage("");
    const maxUses = Number(form.maxUses);
    const { data, error } = await supabase.rpc("admin_create_agent_code", {
      p_agency: form.agency.trim(),
      p_branch: form.branch.trim(),
      p_max_uses: maxUses,
      p_note: form.note.trim(),
    });
    setBusy(false);
    if (error) {
      setMessage(error.message);
      return;
    }
    setForm({ agency: "", branch: "", maxUses: "", note: "" });
    setMessage(`Created ${data}. Copy its link below and send it to the agency.`);
    load();
  }

  async function setActive(code, active) {
    const { error } = await supabase.rpc("admin_set_agent_code_active", {
      p_code: code,
      p_active: active,
    });
    if (error) setMessage(error.message);
    load();
  }

  async function editSeats(code) {
    const typed = window.prompt(
      `How many people at ${[code.agency, code.branch].filter(Boolean).join(", ")} can sign up? (${code.uses} have so far)`,
      code.max_uses ?? ""
    );
    if (typed === null) return;
    const seats = Number(typed);
    if (!Number.isInteger(seats) || seats < 1 || seats > 500) {
      window.alert("Enter a whole number from 1 to 500.");
      return;
    }
    const { error } = await supabase.rpc("admin_set_agent_code_seats", {
      p_code: code.code,
      p_seats: seats,
    });
    if (error) setMessage(error.message);
    load();
  }

  async function decide(request, approve) {
    const { error } = await supabase.rpc("admin_decide_seat_request", {
      p_id: request.id,
      p_approve: approve,
    });
    if (error) {
      setMessage(error.message);
      return;
    }
    if (approve) {
      setMessage(`Added a place for ${request.name}. Use "Email them" to send their sign-up link.`);
    }
    load();
  }

  function approvalEmail(request) {
    const subject = "Your ViewPal place is ready";
    const body =
      `Hi ${request.name.split(" ")[0]},\n\n` +
      `There's now a place for you at ${[request.agency, request.branch].filter(Boolean).join(", ")} on ViewPal. ` +
      `Sign up here with your work email (${request.email}):\n\n${linkFor(request.code)}\n\nThanks`;
    return `mailto:${request.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  async function copy(code) {
    try {
      await navigator.clipboard.writeText(linkFor(code));
      setCopied(code);
      setTimeout(() => setCopied(""), 2000);
    } catch {
      window.prompt("Copy this link:", linkFor(code));
    }
  }

  return (
    <section className="card">
      <div className="section-header">
        <div>
          <h2>Agent sign-up codes</h2>
          <p>
            One code per branch, with the number of people they told you. Send the link: it fills
            in the code and agency. Anyone past the limit can request a place, which you approve
            here. Public page for agents: <a href="/agents">/agents</a>.
          </p>
        </div>
      </div>

      <form className="admin-code-form" onSubmit={create}>
        <label>
          Agency
          <input
            required
            maxLength={100}
            value={form.agency}
            onChange={(e) => setForm({ ...form, agency: e.target.value })}
            placeholder="Brooks Estate Agents"
          />
        </label>
        <label>
          Branch
          <input
            required
            maxLength={100}
            value={form.branch}
            onChange={(e) => setForm({ ...form, branch: e.target.value })}
            placeholder="Wandsworth"
          />
        </label>
        <label>
          Seats (people)
          <input
            required
            type="number"
            min={1}
            max={500}
            value={form.maxUses}
            onChange={(e) => setForm({ ...form, maxUses: e.target.value })}
            placeholder="e.g. 6"
          />
        </label>
        <label>
          Note (just for you)
          <input
            maxLength={200}
            value={form.note}
            onChange={(e) => setForm({ ...form, note: e.target.value })}
            placeholder="e.g. via Ben"
          />
        </label>
        <button type="submit" className="primary-button" disabled={busy}>
          {busy ? "Creating..." : "Create code"}
        </button>
      </form>
      {message && <p className="muted">{message}</p>}

      {requests.length > 0 && (
        <div className="admin-requests">
          <h3>Requests for a place ({requests.length})</h3>
          <p className="muted">
            These branches have used all their seats. Approve adds one seat; then email them the
            link.
          </p>
          <ul>
            {requests.map((r) => (
              <li key={r.id}>
                <div>
                  <strong>{r.name}</strong> · {r.agency}
                  {r.branch ? `, ${r.branch}` : ""}
                  <div className="muted">
                    {r.email}
                    {r.phone ? ` · ${r.phone}` : ""} · asked {shortDate(r.created_at)} · seats{" "}
                    {r.used}/{r.seats ?? "∞"}
                  </div>
                </div>
                <div className="admin-code-actions">
                  <button type="button" className="primary-button" onClick={() => decide(r, true)}>
                    Approve
                  </button>
                  <a className="link-button" href={approvalEmail(r)}>
                    Email them
                  </a>
                  <button type="button" className="link-button" onClick={() => decide(r, false)}>
                    Decline
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {codes === null ? (
        <p className="muted">Loading...</p>
      ) : codes.length === 0 ? (
        <p className="muted">No codes yet.</p>
      ) : (
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Code</th>
                <th>Branch</th>
                <th className="num">Agents joined</th>
                <th className="num">Seats used</th>
                <th>Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {codes.map((c) => (
                <tr key={c.code} className={c.is_active ? "" : "admin-row-off"}>
                  <td>
                    <code>{c.code}</code>
                    {!c.is_active && <span className="muted"> · off</span>}
                  </td>
                  <td>
                    {c.agency}
                    {c.branch && <> · {c.branch}</>}
                    {c.note && <div className="muted">{c.note}</div>}
                  </td>
                  <td className="num">{c.agents_joined}</td>
                  <td className="num">
                    {c.uses} / {c.max_uses ?? "∞"}
                    {c.pending_requests > 0 && (
                      <div className="admin-pending">{c.pending_requests} waiting</div>
                    )}
                  </td>
                  <td>{shortDate(c.created_at)}</td>
                  <td className="admin-code-actions">
                    {c.is_active && (
                      <button type="button" className="link-button" onClick={() => copy(c.code)}>
                        {copied === c.code ? "Copied" : "Copy link"}
                      </button>
                    )}
                    <button type="button" className="link-button" onClick={() => editSeats(c)}>
                      Edit seats
                    </button>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => setActive(c.code, !c.is_active)}
                    >
                      {c.is_active ? "Switch off" : "Switch on"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// What anyone who isn't an admin sees.
function NotFound() {
  return (
    <div className="booking-shell">
      <section className="card">
        <h1>Page not found</h1>
        <p>
          <a href="/">Go to ViewPal</a>
        </p>
      </section>
    </div>
  );
}

function AdminPage() {
  const [user, setUser] = useState(undefined);
  // undefined: checking; null: not an admin (or anything went wrong)
  const [data, setData] = useState(undefined);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: s }) => setUser(s.session?.user ?? null));
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => setUser(session?.user ?? null));
    return () => subscription.unsubscribe();
  }, []);

  const load = useCallback(async () => {
    const { data: metrics, error } = await supabase.rpc("admin_metrics");
    // Any refusal looks the same as a page that doesn't exist.
    setData(error ? null : metrics);
  }, []);

  const userId = user?.id;
  useEffect(() => {
    if (userId) load();
  }, [userId, load]);

  // Signed out: the app's ordinary sign-in, nothing admin-specific.
  if (user === null) {
    return (
      <div className="app-shell">
        <header className="app-header">
          <div>
            <p className="eyebrow">ViewPal</p>
            <h1>Home-buying command centre</h1>
          </div>
        </header>
        <main className="app-main">
          <AuthForm />
        </main>
      </div>
    );
  }
  if (user === undefined || data === undefined) return null;
  if (data === null) return <NotFound />;

  return (
    <div className="app-shell admin-page">
      <header className="app-header">
        <div>
          <p className="eyebrow">ViewPal</p>
          <h1>Admin</h1>
        </div>
        <a className="secondary-button" href="/">
          Back to the app
        </a>
      </header>
      <main className="app-main">
        <Dashboard data={data} onReload={load} />
      </main>
    </div>
  );
}

export default AdminPage;
