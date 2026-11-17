import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { formatShortGBP } from "../utils/market";

// What the buyer is looking for (buyer_searches, migration 009). Agents'
// new listings are matched against these instead of scraping portal
// searches.

const PROPERTY_TYPES = [
  { key: "house", label: "House" },
  { key: "flat", label: "Flat" },
  { key: "bungalow", label: "Bungalow" },
];

// Postcode district (SW17, EC1A) or whole area (SW). Mirrors the DB check.
const AREA_RE = /^[A-Z]{1,2}([0-9][0-9A-Z]?)?$/;

// First search is pre-filled from the old Rightmove/Zoopla searches
// (backend/config.yaml) so nothing is lost when scraping is switched off.
const STARTER = {
  name: "Family house with a garden",
  areasText: "SE24, SW11, SW17",
  min_price: "",
  max_price: "800000",
  min_bedrooms: "2",
  property_types: ["house"],
  must_have_garden: true,
  is_active: true,
};

const BLANK = {
  name: "",
  areasText: "",
  min_price: "",
  max_price: "",
  min_bedrooms: "",
  property_types: [],
  must_have_garden: false,
  is_active: true,
};

export function parseAreas(text) {
  const tokens = text
    .toUpperCase()
    .split(/[\s,;]+/)
    .map((t) => t.trim())
    .filter(Boolean);
  const unique = [...new Set(tokens)];
  return {
    valid: unique.filter((t) => AREA_RE.test(t)),
    invalid: unique.filter((t) => !AREA_RE.test(t)),
  };
}

function toNumber(value) {
  const n = Number(String(value).replace(/[^0-9]/g, ""));
  return n > 0 ? n : null;
}

export function describeSearch(search) {
  const parts = [search.areas.join(", ")];
  if (search.min_price && search.max_price) {
    parts.push(`${formatShortGBP(search.min_price)}–${formatShortGBP(search.max_price)}`);
  } else if (search.max_price) {
    parts.push(`up to ${formatShortGBP(search.max_price)}`);
  } else if (search.min_price) {
    parts.push(`from ${formatShortGBP(search.min_price)}`);
  }
  if (search.min_bedrooms) parts.push(`${search.min_bedrooms}+ beds`);
  if (search.property_types?.length) {
    parts.push(search.property_types.map((t) => `${t}s`).join(" or "));
  }
  if (search.must_have_garden) parts.push("garden");
  return parts.join(" · ");
}

function SearchForm({ initial, onSave, onCancel, isFirst }) {
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const { valid, invalid } = parseAreas(form.areasText);

  const update = (key) => (event) =>
    setForm({
      ...form,
      [key]: event.target.type === "checkbox" ? event.target.checked : event.target.value,
    });

  function toggleType(key) {
    const has = form.property_types.includes(key);
    setForm({
      ...form,
      property_types: has
        ? form.property_types.filter((t) => t !== key)
        : [...form.property_types, key],
    });
  }

  async function submit(event) {
    event.preventDefault();
    setError("");

    if (!valid.length) {
      setError("Add at least one postcode area, e.g. SW17 or SE24.");
      return;
    }
    if (invalid.length) {
      setError(`These aren't postcode areas: ${invalid.join(", ")}. Use the first half, e.g. SW17.`);
      return;
    }

    const minPrice = toNumber(form.min_price);
    const maxPrice = toNumber(form.max_price);
    if (minPrice && maxPrice && minPrice > maxPrice) {
      setError("The minimum price is above the maximum.");
      return;
    }

    setSaving(true);
    const message = await onSave({
      name: form.name.trim() || "My search",
      areas: valid,
      min_price: minPrice,
      max_price: maxPrice,
      min_bedrooms: form.min_bedrooms === "" ? null : Number(form.min_bedrooms),
      // Every type ticked is the same as "any".
      property_types:
        form.property_types.length && form.property_types.length < PROPERTY_TYPES.length
          ? form.property_types
          : null,
      must_have_garden: form.must_have_garden,
      is_active: form.is_active,
    });
    setSaving(false);
    if (message) setError(message);
  }

  return (
    <form className="settings-form buyer-search-form" onSubmit={submit}>
      {isFirst && (
        <p className="muted">
          Pre-filled from your current Rightmove and Zoopla searches. Check it and save.
        </p>
      )}

      <label>
        Name
        <input
          maxLength={80}
          value={form.name}
          onChange={update("name")}
          placeholder="e.g. Family house with a garden"
        />
      </label>

      <label>
        Areas (postcode districts)
        <input
          value={form.areasText}
          onChange={update("areasText")}
          placeholder="SW17, SE24, SW11"
          autoCapitalize="characters"
        />
        <span className="field-hint">
          The first half of the postcode, separated by commas. Use just the letters (e.g. SW)
          for a whole area.
        </span>
      </label>
      {(valid.length > 0 || invalid.length > 0) && (
        <div className="area-chips" aria-live="polite">
          {valid.map((a) => (
            <span key={a} className="area-chip">
              {a}
            </span>
          ))}
          {invalid.map((a) => (
            <span key={a} className="area-chip invalid" title="Not a postcode area">
              {a}
            </span>
          ))}
        </div>
      )}

      <div className="buyer-search-grid">
        <label>
          Min price (£)
          <input
            inputMode="numeric"
            value={form.min_price}
            onChange={update("min_price")}
            placeholder="No minimum"
          />
        </label>
        <label>
          Max price (£)
          <input
            inputMode="numeric"
            value={form.max_price}
            onChange={update("max_price")}
            placeholder="No maximum"
          />
        </label>
        <label>
          Bedrooms
          <select value={form.min_bedrooms} onChange={update("min_bedrooms")}>
            <option value="">Any</option>
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </select>
        </label>
      </div>

      <fieldset className="type-options">
        <legend>Property type (none ticked = any)</legend>
        {PROPERTY_TYPES.map((t) => (
          <label key={t.key} className="checkbox-row">
            <input
              type="checkbox"
              checked={form.property_types.includes(t.key)}
              onChange={() => toggleType(t.key)}
            />
            {t.label}
          </label>
        ))}
      </fieldset>

      <label className="checkbox-row">
        <input type="checkbox" checked={form.must_have_garden} onChange={update("must_have_garden")} />
        Must have a garden
      </label>

      {error && <p className="booking-error">{error}</p>}

      <div className="buyer-search-actions">
        <button type="submit" className="primary-button" disabled={saving}>
          {saving ? "Saving..." : "Save search"}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel} disabled={saving}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function toFormValues(search) {
  return {
    name: search.name,
    areasText: search.areas.join(", "),
    min_price: search.min_price ?? "",
    max_price: search.max_price ?? "",
    min_bedrooms: search.min_bedrooms ?? "",
    property_types: search.property_types || [],
    must_have_garden: search.must_have_garden,
    is_active: search.is_active,
  };
}

function BuyerSearches({ user }) {
  const [searches, setSearches] = useState(null);
  const [editing, setEditing] = useState(null); // search id, "new", or null
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("buyer_searches")
      .select("*")
      .eq("user_id", user.id)
      .order("created_at");
    if (error) {
      setMessage(
        error.code === "42P01" || /buyer_searches/.test(error.message)
          ? "Searches aren't set up yet (database migration 009 needs running)."
          : error.message
      );
      setSearches([]);
      return;
    }
    setSearches(data);
  }, [user.id]);

  useEffect(() => {
    load();
  }, [load]);

  async function save(id, values) {
    const now = new Date().toISOString();
    const { error } = id
      ? await supabase.from("buyer_searches").update({ ...values, updated_at: now }).eq("id", id)
      : await supabase.from("buyer_searches").insert({ ...values, user_id: user.id });
    if (error) return error.message;
    setEditing(null);
    setMessage("Search saved.");
    await load();
    return "";
  }

  async function toggleActive(search) {
    await supabase
      .from("buyer_searches")
      .update({ is_active: !search.is_active, updated_at: new Date().toISOString() })
      .eq("id", search.id);
    load();
  }

  async function remove(search) {
    if (!window.confirm(`Delete "${search.name}"?`)) return;
    await supabase.from("buyer_searches").delete().eq("id", search.id);
    setMessage("");
    load();
  }

  if (searches === null) return <p>Loading your searches...</p>;

  // No searches yet: go straight to the pre-filled form.
  if (searches.length === 0 && !message.includes("migration")) {
    return <SearchForm initial={STARTER} isFirst onSave={(v) => save(null, v)} />;
  }

  return (
    <div className="buyer-searches">
      {searches.map((search) =>
        editing === search.id ? (
          <SearchForm
            key={search.id}
            initial={toFormValues(search)}
            onSave={(v) => save(search.id, v)}
            onCancel={() => setEditing(null)}
          />
        ) : (
          <div key={search.id} className={`buyer-search-row${search.is_active ? "" : " paused"}`}>
            <div>
              <strong>{search.name}</strong>
              {!search.is_active && <span className="muted"> · paused</span>}
              <p className="muted">{describeSearch(search)}</p>
            </div>
            <div className="buyer-search-row-actions">
              <button type="button" onClick={() => setEditing(search.id)}>
                Edit
              </button>
              <button type="button" onClick={() => toggleActive(search)}>
                {search.is_active ? "Pause" : "Resume"}
              </button>
              <button type="button" className="danger-button" onClick={() => remove(search)}>
                Delete
              </button>
            </div>
          </div>
        )
      )}

      {editing === "new" ? (
        <SearchForm initial={BLANK} onSave={(v) => save(null, v)} onCancel={() => setEditing(null)} />
      ) : (
        searches.length < 10 &&
        !message.includes("migration") && (
          <button type="button" onClick={() => setEditing("new")}>
            + Add another search
          </button>
        )
      )}

      {message && <p className="form-message">{message}</p>}
    </div>
  );
}

export default BuyerSearches;
