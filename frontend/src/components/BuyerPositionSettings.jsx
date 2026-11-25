import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import PositionProof from "./PositionProof";

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
};

const toNumber = (v) => (v === "" || v === null ? null : Math.round(Number(String(v).replace(/[£,\s]/g, ""))));

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
      updated_at: new Date().toISOString(),
      updated_by: auth?.user?.id,
    };
  }

  // The proof hangs off the position row. If the buyer uploads before ever
  // saving, save what the form says now, so the document isn't attached to
  // a blank position. Returns the household id.
  async function ensurePosition() {
    if (saved?.household_id) return saved.household_id;
    const { data, error } = await supabase
      .from("buyer_positions")
      .insert(await formRow())
      .select("household_id")
      .single();
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
    setSaving(true);
    setMessage("");

    const row = await formRow();

    // One row per household; the household id fills itself in on insert.
    const { error } = exists
      ? await supabase.from("buyer_positions").update(row).not("household_id", "is", null)
      : await supabase.from("buyer_positions").insert(row);

    setSaving(false);
    if (error) {
      console.error(error);
      setMessage("Could not save. Check the amounts are whole pounds.");
      return;
    }
    setExists(true);
    setMessage("Saved.");
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
          <select value={form.selling_status} onChange={set("selling_status")}>
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
