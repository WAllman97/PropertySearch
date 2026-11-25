import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import PositionProof from "./PositionProof";
import { DEFAULT_MORTGAGE_RATE, DEFAULT_MORTGAGE_TERM } from "./TotalCost";

// The household's "ready to proceed" position (migration 015). Agents you
// book viewings with see it, marked as your own declaration, so they know
// you can move quickly. Same rule as position_is_proceedable() in SQL.
// Local calendar date as YYYY-MM-DD. toISOString() is UTC, which is still
// yesterday between midnight and 1am in British Summer Time.
function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function isProceedable(p) {
  if (!p) return false;
  const today = localDateString();
  const funded =
    p.buying_with === "cash" ||
    (p.buying_with === "mortgage" &&
      ["aip", "offer"].includes(p.mortgage_status) &&
      (!p.aip_expires || p.aip_expires >= today));
  return funded && ["first_time", "nothing_to_sell", "sold_stc"].includes(p.selling_status);
}

const EMPTY = {
  max_budget: "",
  deposit: "",
  buying_with: "",
  mortgage_status: "none",
  aip_amount: "",
  aip_lender: "",
  aip_expires: "",
  selling_status: "",
  solicitor_ready: false,
  move_timeframe: "",
  share_with_agents: true,
  // For the cost of each home (migration 036). Blank rate or term means the
  // defaults (4.5%, 25 years), so the estimates work before anything is set.
  first_time_buyer: false,
  mortgage_rate: "",
  mortgage_term_years: "",
};

const toNumber = (v) => (v === "" || v === null ? null : Math.round(Number(String(v).replace(/[£,\s]/g, ""))));
const toDecimal = (v) => (v === "" || v === null ? null : Number(String(v).replace(/[%\s]/g, "")));

// Before migration 036 these columns don't exist: save everything else.
const COST_FIELDS = ["first_time_buyer", "mortgage_rate", "mortgage_term_years"];
function withoutCostFields(row) {
  const copy = { ...row };
  for (const field of COST_FIELDS) delete copy[field];
  return copy;
}
const isMissingCostColumn = (error) =>
  error && (error.code === "PGRST204" || COST_FIELDS.some((field) => String(error.message || "").includes(field)));

function BuyerPositionSettings() {
  const [form, setForm] = useState(EMPTY);
  const [exists, setExists] = useState(false);
  // The saved row as stored (household id, proof document), apart from the
  // form being edited.
  const [saved, setSaved] = useState(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async (resetForm = true) => {
    const { data, error } = await supabase.from("buyer_positions").select("*").maybeSingle();
    if (error) {
      console.error("Could not load buying position:", error);
      return;
    }
    setSaved(data);
    if (data) {
      setExists(true);
      if (resetForm) {
        setForm({
          ...EMPTY,
          ...Object.fromEntries(Object.entries(data).map(([k, v]) => [k, v ?? EMPTY[k] ?? ""])),
          // Not set yet: go by "first-time buyer" as their selling status.
          first_time_buyer: data.first_time_buyer ?? data.selling_status === "first_time",
        });
      }
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // What the form says, as a buyer_positions row.
  async function formRow() {
    const mortgage = form.buying_with === "mortgage";
    const hasAip = mortgage && ["aip", "offer"].includes(form.mortgage_status);
    const { data: auth } = await supabase.auth.getUser();
    return {
      max_budget: toNumber(form.max_budget),
      deposit: toNumber(form.deposit),
      buying_with: form.buying_with || null,
      mortgage_status: mortgage ? form.mortgage_status || "none" : null,
      aip_amount: hasAip ? toNumber(form.aip_amount) : null,
      aip_lender: hasAip ? form.aip_lender.trim() || null : null,
      aip_expires: hasAip ? form.aip_expires || null : null,
      selling_status: form.selling_status || null,
      solicitor_ready: form.solicitor_ready,
      move_timeframe: form.move_timeframe || null,
      share_with_agents: form.share_with_agents,
      first_time_buyer: Boolean(form.first_time_buyer),
      mortgage_rate: toDecimal(form.mortgage_rate),
      mortgage_term_years: toNumber(form.mortgage_term_years),
      updated_at: new Date().toISOString(),
      updated_by: auth?.user?.id,
    };
  }

  // Insert or update the household's row; before migration 036, again
  // without the cost fields. Returns { data, error, costSkipped }.
  async function writeRow(row, { insert, select } = {}) {
    const run = async (values) => {
      let query = insert
        ? supabase.from("buyer_positions").insert(values)
        : supabase.from("buyer_positions").update(values).not("household_id", "is", null);
      if (select) query = query.select(select).single();
      return query;
    };
    const first = await run(row);
    if (!isMissingCostColumn(first.error)) return first;
    const second = await run(withoutCostFields(row));
    return { ...second, costSkipped: !second.error };
  }

  // The proof hangs off the position row. If the buyer uploads before ever
  // saving, save what the form says now, so the document isn't attached to
  // a blank position. Returns the household id.
  async function ensurePosition() {
    if (saved?.household_id) return saved.household_id;
    const { data, error } = await writeRow(await formRow(), { insert: true, select: "household_id" });
    if (error) throw error;
    setExists(true);
    return data.household_id;
  }

  const set = (key) => (event) => {
    const value = event.target.type === "checkbox" ? event.target.checked : event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
    setMessage("");
  };

  async function save(event) {
    event.preventDefault();
    const row = await formRow();
    if (row.mortgage_rate != null && !(row.mortgage_rate >= 0 && row.mortgage_rate < 30)) {
      setMessage("Enter the mortgage rate as a percentage, e.g. 4.5");
      return;
    }
    if (row.mortgage_term_years != null && !(row.mortgage_term_years >= 1 && row.mortgage_term_years <= 40)) {
      setMessage("Enter a mortgage term between 1 and 40 years.");
      return;
    }

    setSaving(true);
    setMessage("");

    // One row per household; the household id fills itself in on insert.
    const { error, costSkipped } = await writeRow(row, { insert: !exists });

    setSaving(false);
    if (error) {
      console.error(error);
      setMessage("Could not save. Check the amounts are whole pounds.");
      return;
    }
    setExists(true);
    setMessage(costSkipped ? "Saved, apart from the cost settings (they need database update 036)." : "Saved.");
    load(false);
  }

  const proceedable = isProceedable({ ...form, aip_expires: form.aip_expires || null });
  const mortgage = form.buying_with === "mortgage";
  const hasAip = mortgage && ["aip", "offer"].includes(form.mortgage_status);

  return (
    <form className="buyer-position" onSubmit={save}>
      <p className={`position-badge ${proceedable ? "ready" : ""}`}>
        {proceedable
          ? "✓ Ready to proceed: agents see you as a proceedable buyer."
          : "Not shown as ready to proceed yet. Agents favour buyers with funding sorted and nothing to sell."}
      </p>

      <div className="position-grid">
        <label>
          Maximum budget (£)
          <input inputMode="numeric" value={form.max_budget} onChange={set("max_budget")} placeholder="650000" />
        </label>
        <label>
          Deposit (£)
          <input inputMode="numeric" value={form.deposit} onChange={set("deposit")} placeholder="130000" />
        </label>

        <label>
          Buying with
          <select value={form.buying_with} onChange={set("buying_with")}>
            <option value="">Choose...</option>
            <option value="mortgage">A mortgage</option>
            <option value="cash">Cash</option>
          </select>
        </label>

        {mortgage && (
          <label>
            Mortgage
            <select value={form.mortgage_status} onChange={set("mortgage_status")}>
              <option value="none">Not arranged yet</option>
              <option value="aip">Agreement in principle</option>
              <option value="offer">Full mortgage offer</option>
            </select>
          </label>
        )}

        {hasAip && (
          <>
            <label>
              Amount agreed (£)
              <input inputMode="numeric" value={form.aip_amount} onChange={set("aip_amount")} />
            </label>
            <label>
              Lender
              <input maxLength={100} value={form.aip_lender} onChange={set("aip_lender")} />
            </label>
            <label>
              Expires
              <input type="date" value={form.aip_expires} onChange={set("aip_expires")} />
            </label>
          </>
        )}

        <label>
          Home to sell?
          <select
            value={form.selling_status}
            onChange={(event) => {
              set("selling_status")(event);
              // Saying "first-time buyer" here is the same answer below.
              if (event.target.value === "first_time") {
                setForm((current) => ({ ...current, first_time_buyer: true }));
              }
            }}
          >
            <option value="">Choose...</option>
            <option value="first_time">First-time buyer</option>
            <option value="nothing_to_sell">Nothing to sell (e.g. renting)</option>
            <option value="sold_stc">Ours is sold, subject to contract</option>
            <option value="on_market">Ours is on the market</option>
            <option value="not_listed">Need to sell, not listed yet</option>
          </select>
        </label>

        <label>
          Moving
          <select value={form.move_timeframe} onChange={set("move_timeframe")}>
            <option value="">Choose...</option>
            <option value="asap">As soon as possible</option>
            <option value="3_months">Within 3 months</option>
            <option value="6_months">Within 6 months</option>
            <option value="flexible">Flexible</option>
          </select>
        </label>
      </div>

      <fieldset className="position-costs">
        <legend>For cost estimates</legend>
        <p className="muted">
          Used to estimate each home's stamp duty and monthly mortgage. Only your household sees these.
        </p>
        <label className="checkbox-row">
          <input type="checkbox" checked={Boolean(form.first_time_buyer)} onChange={set("first_time_buyer")} />
          First-time buyer (lower stamp duty up to £500,000)
        </label>
        {form.buying_with !== "cash" && (
          <div className="position-grid">
            <label>
              Mortgage rate (%)
              <input
                inputMode="decimal"
                value={form.mortgage_rate}
                onChange={set("mortgage_rate")}
                placeholder={String(DEFAULT_MORTGAGE_RATE)}
              />
            </label>
            <label>
              Term (years)
              <input
                inputMode="numeric"
                value={form.mortgage_term_years}
                onChange={set("mortgage_term_years")}
                placeholder={String(DEFAULT_MORTGAGE_TERM)}
              />
            </label>
          </div>
        )}
      </fieldset>

      {/* Shown for funding that has paperwork, and always while a document is
          attached, so it can be seen and removed whatever the form says. */}
      {(form.buying_with === "cash" || hasAip || saved?.proof_path) && (
        <PositionProof
          position={{
            ...(saved || {}),
            buying_with: form.buying_with,
            mortgage_status: form.mortgage_status,
          }}
          ensurePosition={ensurePosition}
          onChanged={() => load(false)}
        />
      )}

      <label className="checkbox-row">
        <input type="checkbox" checked={form.solicitor_ready} onChange={set("solicitor_ready")} />
        We have a solicitor or conveyancer ready
      </label>
      <label className="checkbox-row">
        <input type="checkbox" checked={form.share_with_agents} onChange={set("share_with_agents")} />
        Show this to agents I book viewings or make offers with
      </label>
      <p className="muted">
        Agents see it as your own declaration. Uploading proof above makes it more convincing,
        though they may still ask for originals before putting an offer forward.
      </p>

      <button type="submit" className="primary-button" disabled={saving}>
        {saving ? "Saving..." : "Save buying position"}
      </button>
      {message && <p className="muted">{message}</p>}
    </form>
  );
}

export default BuyerPositionSettings;
