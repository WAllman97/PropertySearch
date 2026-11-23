import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { formatShortGBP } from "../utils/market";

const SearchAreaMap = lazy(() => import("./SearchAreaMap"));

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

// Where to look (migration 016): postcodes, a place + distance, or an area
// drawn on the map.
const WHERE_OPTIONS = [
  { key: "postcodes", label: "Postcodes" },
  { key: "circle", label: "Place & distance" },
  { key: "polygon", label: "Draw on map" },
];

const MILE = 1609.34;
const RADII = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 5].map((miles) => ({
  miles,
  metres: Math.round(miles * MILE),
}));

export function milesText(metres) {
  const miles = Math.round((metres / MILE) * 100) / 100;
  const words = { 0.25: "¼", 0.5: "½", 0.75: "¾", 1.5: "1½" };
  const n = words[miles] || String(miles);
  return `${n} mile${miles > 1 ? "s" : ""}`;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6;

// A new buyer's first search, guessed from the homes they've already saved
// (their postcode districts, price and bedrooms), so they only check it and
// tap Save. With nothing saved yet it starts on "near a place", which is
// how most people think, rather than postcode districts.
// -> { initial, guessed }
async function starterSearch(blank) {
  const { data } = await supabase
    .from("properties")
    .select("postcode, price, bedrooms")
    .not("status", "in", "(ignored,archived,lost)")
    .limit(200);
  const homes = data || [];

  const counts = new Map();
  for (const home of homes) {
    const district = String(home.postcode || "").toUpperCase().replace(/\s+/g, "").replace(/[0-9][A-Z]{2}$/, "");
    if (AREA_RE.test(district)) counts.set(district, (counts.get(district) || 0) + 1);
  }
  const districts = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([d]) => d);
  if (!districts.length) return { initial: { ...blank, where: "circle" }, guessed: false };

  const prices = homes.map((h) => h.price).filter((p) => p > 0);
  const beds = homes.map((h) => h.bedrooms).filter((b) => b > 0);
  // A little above the dearest saved home, rounded to £25k.
  const maxPrice = prices.length ? Math.ceil((Math.max(...prices) * 1.05) / 25000) * 25000 : "";
  return {
    initial: {
      ...blank,
      where: "postcodes",
      areasText: districts.join(", "),
      max_price: maxPrice ? String(maxPrice) : "",
      min_bedrooms: beds.length ? String(Math.min(...beds)) : "",
    },
    guessed: true,
  };
}

const BLANK = {
  name: "",
  where: "postcodes",
  center: null,
  radius_m: RADII[3].metres,
  polygon: [],
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
  const where = [];
  if (search.areas?.length) where.push(search.areas.join(", "));
  if (search.radius_m) {
    where.push(`within ${milesText(search.radius_m)} of ${search.center_label || "a point on the map"}`);
  }
  if (search.polygon) where.push("an area drawn on the map");
  const parts = [where.join(" or ")];
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
  const [placeQuery, setPlaceQuery] = useState("");
  const [places, setPlaces] = useState(null);
  const [placeError, setPlaceError] = useState("");
  const { valid, invalid } = parseAreas(form.areasText);

  async function findPlace() {
    if (placeQuery.trim().length < 2) return;
    setPlaceError("");
    setPlaces(null);
    try {
      const response = await postAuthed("/api/lookup", { action: "places", q: placeQuery });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Place search failed");
      if (!body.results.length) {
        setPlaceError("No places found. Try a nearby area or a postcode.");
      } else if (body.results.length === 1) {
        choosePlace(body.results[0]);
      } else {
        setPlaces(body.results);
      }
    } catch (err) {
      setPlaceError(err.message);
    }
  }

  function choosePlace(place) {
    setForm((current) => ({ ...current, center: place }));
    setPlaces(null);
    setPlaceQuery("");
  }

  function mapClick(point) {
    if (form.where === "circle") {
      setForm((current) => ({
        ...current,
        center: { label: "a point on the map", lat: round6(point.lat), lng: round6(point.lng) },
      }));
    } else if (form.where === "polygon") {
      setForm((current) =>
        current.polygon.length >= 100
          ? current
          : { ...current, polygon: [...current.polygon, [round6(point.lat), round6(point.lng)]] }
      );
    }
  }

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

    if (form.where === "postcodes") {
      if (!valid.length) {
        setError("Add at least one postcode area, e.g. SW17 or SE24.");
        return;
      }
      if (invalid.length) {
        setError(`These aren't postcode areas: ${invalid.join(", ")}. Use the first half, e.g. SW17.`);
        return;
      }
    }
    if (form.where === "circle" && !form.center) {
      setError("Choose a place, or tap the map to set the centre.");
      return;
    }
    if (form.where === "polygon" && form.polygon.length < 3) {
      setError("Tap at least three points on the map to draw your area.");
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
      // One way of saying where per search; the others are cleared.
      areas: form.where === "postcodes" ? valid : [],
      center_label: form.where === "circle" ? form.center.label.slice(0, 120) : null,
      center_lat: form.where === "circle" ? form.center.lat : null,
      center_lng: form.where === "circle" ? form.center.lng : null,
      radius_m: form.where === "circle" ? Number(form.radius_m) : null,
      polygon: form.where === "polygon" ? form.polygon : null,
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
          {isFirst === "guessed"
            ? "We've filled this in from the homes you've saved. Check it and tap Save."
            : "Tell us where and what you're looking for. Agents send you new homes that fit."}
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

      <fieldset className="where-options">
        <legend>Where</legend>
        <div className="segmented" role="radiogroup">
          {WHERE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              role="radio"
              aria-checked={form.where === option.key}
              className={form.where === option.key ? "active" : ""}
              onClick={() => setForm({ ...form, where: option.key })}
            >
              {option.label}
            </button>
          ))}
        </div>
      </fieldset>

      {form.where === "postcodes" && (
        <>
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
        </>
      )}

      {form.where === "circle" && (
        <div className="where-circle">
          <div className="place-row">
            <label className="radius-select">
              Within
              <select value={form.radius_m} onChange={update("radius_m")}>
                {RADII.map((r) => (
                  <option key={r.metres} value={r.metres}>
                    {milesText(r.metres)}
                  </option>
                ))}
              </select>
            </label>
            <label className="place-search">
              of
              <input
                value={placeQuery}
                onChange={(event) => setPlaceQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    findPlace();
                  }
                }}
                placeholder={form.center ? form.center.label : "Battersea, Clapham Junction, SW11 1AA..."}
              />
            </label>
            <button type="button" onClick={findPlace}>
              Find
            </button>
          </div>
          {places && (
            <ul className="place-results">
              {places.map((place) => (
                <li key={place.label}>
                  <button type="button" className="link-button" onClick={() => choosePlace(place)}>
                    {place.label}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {placeError && <p className="booking-error">{placeError}</p>}
          <p className="field-hint">
            {form.center
              ? `Within ${milesText(form.radius_m)} of ${form.center.label}. Tap the map to move the centre.`
              : "Search for a place, or tap the map to set the centre."}
          </p>
        </div>
      )}

      {form.where === "polygon" && (
        <div className="where-polygon">
          <p className="field-hint">
            Tap the map to mark the corners of the area you want (at least three). Drag to move
            the map; pinch or use + and − to zoom.
          </p>
          <div className="buyer-search-actions">
            <button
              type="button"
              disabled={!form.polygon.length}
              onClick={() => setForm({ ...form, polygon: form.polygon.slice(0, -1) })}
            >
              Undo last point
            </button>
            <button type="button" disabled={!form.polygon.length} onClick={() => setForm({ ...form, polygon: [] })}>
              Clear
            </button>
            <span className="muted">
              {form.polygon.length} point{form.polygon.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}

      {form.where !== "postcodes" && (
        <Suspense fallback={<div className="search-map loading">Loading map...</div>}>
          <SearchAreaMap
            mode={form.where}
            center={form.center}
            radiusM={Number(form.radius_m)}
            polygon={form.polygon}
            onMapClick={mapClick}
          />
        </Suspense>
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
    where: search.polygon ? "polygon" : search.radius_m ? "circle" : "postcodes",
    center: search.radius_m
      ? { label: search.center_label || "a point on the map", lat: search.center_lat, lng: search.center_lng }
      : null,
    radius_m: search.radius_m || RADII[3].metres,
    polygon: search.polygon || [],
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

  // First search: guess it from what they've saved.
  const [starter, setStarter] = useState(null);
  useEffect(() => {
    if (searches?.length === 0 && !starter) starterSearch(BLANK).then(setStarter);
  }, [searches, starter]);

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

  if (searches === null || (searches.length === 0 && !starter && !message.includes("migration"))) {
    return <p>Loading your searches...</p>;
  }

  // No searches yet: go straight to a form guessed from their saved homes.
  if (searches.length === 0 && !message.includes("migration")) {
    return (
      <SearchForm
        initial={starter.initial}
        isFirst={starter.guessed ? "guessed" : "blank"}
        onSave={(v) => save(null, v)}
      />
    );
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
