import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import AuthForm from "../components/AuthForm";
import "./AdminPage.css";

// Founder's dashboard: /admin. Live numbers and targets from admin_metrics()
// (migration 018), which only answers accounts in app_admins. Everyone else,
// signed in or not, sees an ordinary "page not found": nothing on this page
// says what it is until the database has confirmed an admin.
//
// Targets are deliberately not in this file: the repository and the site's
// code are public. They live in the admin_targets table.

const PLANS = ["pilot", "paying", "cancelled"];

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

function AgentRow({ agent, onSaved }) {
  const [plan, setPlan] = useState(agent.plan);
  const [fee, setFee] = useState(agent.monthly_fee ?? "");
  const [busy, setBusy] = useState(false);
  const changed = plan !== agent.plan || String(fee) !== String(agent.monthly_fee ?? "");

  async function save() {
    setBusy(true);
    const { error } = await supabase.rpc("admin_set_agent_billing", {
      p_agent: agent.user_id,
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

  const quiet = !agent.last_activity || new Date(agent.last_activity) < Date.now() - 30 * 864e5;
  return (
    <tr className={quiet ? "quiet" : ""}>
      <td>
        <strong>{agent.agency}</strong>
        {agent.branch ? ` · ${agent.branch}` : ""}
        <br />
        <span className="muted">
          {agent.name} · <a href={`mailto:${agent.email}`}>{agent.email}</a>
        </span>
      </td>
      <td>{shortDate(agent.created_at)}</td>
      <td className="num">{agent.listings}</td>
      <td className="num">{agent.slots_30d}</td>
      <td className="num">{agent.viewings_30d}</td>
      <td className="num">{agent.sends_30d}</td>
      <td>{quiet ? <span className="admin-flag">quiet 30d+</span> : shortDate(agent.last_activity)}</td>
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

      <section className="card">
        <div className="section-header">
          <div>
            <h2>Agent branches</h2>
            <p>
              Billing is set by hand until payments are built: mark a branch paying with its
              monthly fee to count it in revenue.
            </p>
          </div>
        </div>
        {agents.list.length === 0 ? (
          <p className="muted">No agents yet.</p>
        ) : (
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Branch</th>
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
                {agents.list.map((agent) => (
                  <AgentRow key={agent.user_id} agent={agent} onSaved={load} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

// What anyone who isn't an admin sees.
function NotFound() {
  return (
    <div className="booking-shell">
      <section className="card">
        <h1>Page not found</h1>
        <p>
          <a href="/">Go to PropertySearch</a>
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
            <p className="eyebrow">PropertySearch</p>
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
          <p className="eyebrow">PropertySearch</p>
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
