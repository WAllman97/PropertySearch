import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";

// Save-a-link: paste a Rightmove / OnTheMarket / Zoopla link, we fill in the
// details (/api/lookup), the buyer checks them and saves. Replaces
// typing everything in by hand, and the daily portal scraping.

const TYPES = [
  { value: "", label: "Not sure" },
  { value: "terraced", label: "Terraced house" },
  { value: "semi-detached", label: "Semi-detached house" },
  { value: "detached", label: "Detached house" },
  { value: "house", label: "House (other)" },
  { value: "flat", label: "Flat / maisonette" },
];

const PORTAL_NAMES = { rightmove: "Rightmove", zoopla: "Zoopla", onthemarket: "OnTheMarket" };

function toForm(details = {}) {
  return {
    address: details.address || "",
    postcode: details.postcode || "",
    price: details.price ?? "",
    bedrooms: details.bedrooms ?? "",
    property_type: details.property_type || "",
    image_url: details.image_url || "",
  };
}

// Local calendar date as YYYY-MM-DD. toISOString() is UTC, which is still
// yesterday between midnight and 1am in British Summer Time.
function localDateString(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function SaveLinkForm({ onSaved, initialUrl = null }) {
  const [url, setUrl] = useState(initialUrl || "");
  const [preview, setPreview] = useState(null);
  const [form, setForm] = useState(toForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const update = (key) => (event) => setForm({ ...form, [key]: event.target.value });
  const [pasteHint, setPasteHint] = useState("");

  // Opened with a shared link: look it up straight away.
  useEffect(() => {
    if (initialUrl) lookUp(initialUrl);
    // Only when the form opens with a link.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // One tap instead of press-and-hold: reads the copied link (the phone may
  // show its own "Paste" button to allow it).
  async function pasteLink() {
    setPasteHint("");
    try {
      const text = (await navigator.clipboard.readText()).trim();
      const link = text.match(/https?:\/\/\S+/)?.[0];
      if (!link) {
        setPasteHint("No link copied. In Rightmove or Zoopla, tap Share, then Copy link.");
        return;
      }
      setUrl(link);
      lookUp(link);
    } catch {
      setPasteHint("Couldn't read the clipboard here. Press and hold the box, then Paste.");
      document.getElementById("save-link-url")?.focus();
    }
  }

  async function lookUp(value = url) {
    const link = value.trim();
    if (!link) return;
    setBusy(true);
    setError("");
    setPreview(null);
    try {
      const response = await postAuthed("/api/lookup", { action: "listing", url: link });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || "Could not read that link");
      setPreview(body);
      setForm(toForm(body.details));
    } catch (err) {
      setError(err.message);
    }
    setBusy(false);
  }

  async function save(event) {
    event.preventDefault();
    if (!form.address.trim()) {
      setError("Add the address.");
      return;
    }
    setBusy(true);
    setError("");

    const d = preview.details || {};
    const price = Number(String(form.price).replace(/[^0-9]/g, "")) || null;
    const { data, error: insertError } = await supabase
      .from("properties")
      .insert({
        source: preview.portal,
        listing_id: preview.listingId,
        title: form.address.trim(),
        address: form.address.trim(),
        price,
        initial_price: price,
        bedrooms: form.bedrooms === "" ? null : Number(form.bedrooms),
        image_url: form.image_url.trim(),
        listing_url: preview.listingUrl,
        postcode: form.postcode.trim().toUpperCase() || null,
        property_type: form.property_type || null,
        latitude: d.latitude ?? null,
        longitude: d.longitude ?? null,
        description: d.description || null,
        listing_status: d.listing_status || null,
        date_found: localDateString(),
        status: "favourite",
      })
      .select()
      .single();

    if (insertError) {
      setBusy(false);
      setError(insertError.message);
      return;
    }

    // The listing's agent, from the link preview: ready for viewing requests.
    if (d.agent_name) {
      const { error: notesError } = await supabase
        .from("property_notes")
        .insert({ property_id: data.id, estate_agent: d.agent_name });
      if (notesError) console.error("Could not save the agent:", notesError);
    }

    // Work out commutes in the background: no need to make them wait.
    postAuthed("/api/calculate-commute", { propertyId: data.id }).catch((err) =>
      console.error("Commute calculation failed:", err)
    );

    setBusy(false);
    setUrl("");
    setPreview(null);
    onSaved(data);
  }

  const portalName = PORTAL_NAMES[preview?.portal] || "the portal";
  const gotDetails = preview?.status === "ok";

  return (
    <div className="save-link">
      <form
        className="save-link-lookup"
        onSubmit={(event) => {
          event.preventDefault();
          lookUp();
        }}
      >
        <label>
          Property link
          <span className="save-link-input">
          <input
            id="save-link-url"
            type="url"
            required
            value={url}
            placeholder="Paste a Rightmove, OnTheMarket or Zoopla link"
            onChange={(event) => setUrl(event.target.value)}
            // Pasting is the whole point: look it up straight away.
            onPaste={(event) => {
              const pasted = event.clipboardData.getData("text");
              if (pasted) setTimeout(() => lookUp(pasted), 0);
            }}
          />
          <button type="button" className="secondary-button" disabled={busy} onClick={pasteLink}>
            Paste
          </button>
          </span>
        </label>
        {pasteHint && <p className="save-link-note">{pasteHint}</p>}
        <button type="submit" className="primary-button" disabled={busy || !url.trim()}>
          {busy && !preview ? "Getting details..." : "Get details"}
        </button>
      </form>

      {error && <p className="booking-error">{error}</p>}

      {preview?.existing && (
        <p className="save-link-note">
          This one is already in your list
          {preview.existing.status && preview.existing.status !== "new"
            ? ` (${preview.existing.status})`
            : ""}
          .
        </p>
      )}

      {preview && !preview.existing && (
        <form className="save-link-preview" onSubmit={save}>
          {gotDetails ? (
            <p className="save-link-note">
              {preview.from === "agent"
                ? "Details from the listing agent on PropertySearch. Check and save."
                : `Details from ${portalName}. Check and save.`}
            </p>
          ) : (
            <p className="save-link-note warn">
              {preview.status === "blocked"
                ? `${portalName} doesn't let us read the page, so add the key details yourself.`
                : "We couldn't read that listing (it may have been taken down). Add the details yourself."}
            </p>
          )}

          {form.image_url && <img className="save-link-photo" src={form.image_url} alt="" />}

          <div className="save-link-grid">
            <label className="save-link-wide">
              Address *
              <input required maxLength={200} value={form.address} onChange={update("address")} />
            </label>
            <label>
              Postcode
              <input
                maxLength={10}
                autoCapitalize="characters"
                value={form.postcode}
                onChange={update("postcode")}
                placeholder="SW17 0AB"
              />
            </label>
            <label>
              Price (£)
              <input inputMode="numeric" value={form.price} onChange={update("price")} />
            </label>
            <label>
              Bedrooms
              <input inputMode="numeric" value={form.bedrooms} onChange={update("bedrooms")} />
            </label>
            <label>
              Type
              <select value={form.property_type} onChange={update("property_type")}>
                {TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            {!gotDetails && (
              <label className="save-link-wide">
                Main photo link (optional)
                <input type="url" value={form.image_url} onChange={update("image_url")} />
              </label>
            )}
          </div>

          <button type="submit" className="primary-button" disabled={busy}>
            {busy ? "Saving..." : "Add to Watchlist"}
          </button>
        </form>
      )}
    </div>
  );
}

export default SaveLinkForm;
