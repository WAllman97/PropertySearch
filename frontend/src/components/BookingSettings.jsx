import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

const WEEKDAYS = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [7, "Sun"],
];

// Sensible first-time defaults: lunchtimes and early evenings on weekdays,
// Saturday morning for viewings.
const DEFAULT_WINDOWS = [
  ...[1, 2, 3, 4, 5].flatMap((weekday) => [
    { weekday, start_time: "12:30", end_time: "13:30" },
    { weekday, start_time: "18:00", end_time: "19:30" },
  ]),
  { weekday: 6, start_time: "10:00", end_time: "13:00" },
];

function suggestSlug(text) {
  return (text || "")
    .toLowerCase()
    .replace(/@.*/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const hhmm = (value) => String(value || "").slice(0, 5);

function BookingSettings({ user }) {
  const [page, setPage] = useState(null);
  const [windows, setWindows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    load();
  }, [user?.id]);

  async function load() {
    setLoading(true);

    const [{ data: pageRow }, { data: windowRows }] = await Promise.all([
      supabase.from("booking_pages").select("*").eq("user_id", user.id).maybeSingle(),
      supabase
        .from("availability_windows")
        .select("*")
        .eq("user_id", user.id)
        .order("weekday")
        .order("start_time"),
    ]);

    setPage(
      pageRow || {
        slug: suggestSlug(user.email),
        display_name: "",
        phone: "",
        intro: "",
        slot_minutes: 30,
        min_notice_hours: 2,
        days_ahead: 14,
        is_active: true,
        isNew: true,
      }
    );

    setWindows(
      windowRows?.length
        ? windowRows.map((w) => ({ ...w, start_time: hhmm(w.start_time), end_time: hhmm(w.end_time) }))
        : DEFAULT_WINDOWS
    );

    setLoading(false);
  }

  function updatePage(field, value) {
    setPage((p) => ({ ...p, [field]: value }));
    setMessage("");
  }

  function updateWindow(index, field, value) {
    setWindows((ws) => ws.map((w, i) => (i === index ? { ...w, [field]: value } : w)));
    setMessage("");
  }

  function addWindow(weekday) {
    setWindows((ws) => [...ws, { weekday, start_time: "12:00", end_time: "13:00" }]);
  }

  function removeWindow(index) {
    setWindows((ws) => ws.filter((_, i) => i !== index));
  }

  async function save() {
    const slug = page.slug.trim().toLowerCase();

    if (!/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/.test(slug)) {
      setMessage("Link name: 3-40 lowercase letters, numbers or dashes.");
      return;
    }

    if (!page.display_name.trim()) {
      setMessage("Add the name agents will see.");
      return;
    }

    const invalid = windows.find((w) => !w.start_time || !w.end_time || w.end_time <= w.start_time);
    if (invalid) {
      setMessage("Each time window needs an end time after its start time.");
      return;
    }

    setSaving(true);
    setMessage("");

    const { error: pageError } = await supabase.from("booking_pages").upsert(
      {
        user_id: user.id,
        slug,
        display_name: page.display_name.trim(),
        phone: page.phone?.trim() || null,
        intro: page.intro?.trim() || null,
        slot_minutes: Number(page.slot_minutes),
        min_notice_hours: Number(page.min_notice_hours),
        days_ahead: Number(page.days_ahead),
        is_active: page.is_active,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );

    if (pageError) {
      setSaving(false);
      setMessage(
        pageError.code === "23505"
          ? "That link name is taken. Try another."
          : pageError.message
      );
      return;
    }

    // Replace the weekly windows wholesale; there are only a handful.
    const { error: deleteError } = await supabase
      .from("availability_windows")
      .delete()
      .eq("user_id", user.id);

    const { error: insertError } = deleteError
      ? { error: deleteError }
      : windows.length
        ? await supabase.from("availability_windows").insert(
            windows.map((w) => ({
              user_id: user.id,
              weekday: w.weekday,
              start_time: w.start_time,
              end_time: w.end_time,
            }))
          )
        : { error: null };

    setSaving(false);

    if (insertError) {
      setMessage(insertError.message);
      return;
    }

    setMessage("Saved.");
    await load();
  }

  const link = page ? `${window.location.origin}/book/${page.slug}` : "";

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setMessage(link);
    }
  }

  if (loading || !page) {
    return <p className="muted">Loading booking settings…</p>;
  }

  return (
    <div className="booking-settings">
      {!page.isNew && (
        <div className="booking-link-row">
          <a href={link} target="_blank" rel="noreferrer">
            {link}
          </a>
          <button type="button" onClick={copyLink}>
            {copied ? "Copied" : "Copy link"}
          </button>
        </div>
      )}

      <div className="booking-form-grid">
        <label>
          Name agents see
          <input
            value={page.display_name}
            maxLength={80}
            placeholder="e.g. Will Allman"
            onChange={(e) => updatePage("display_name", e.target.value)}
          />
        </label>

        <label>
          Link name
          <input
            value={page.slug}
            maxLength={40}
            onChange={(e) => updatePage("slug", e.target.value.toLowerCase())}
          />
        </label>

        <label>
          Your phone (only sent to agents you accept)
          <input
            type="tel"
            value={page.phone || ""}
            maxLength={40}
            onChange={(e) => updatePage("phone", e.target.value)}
          />
        </label>

        <label>
          Slot length
          <select
            value={page.slot_minutes}
            onChange={(e) => updatePage("slot_minutes", Number(e.target.value))}
          >
            {[15, 30, 45, 60].map((m) => (
              <option key={m} value={m}>
                {m} minutes
              </option>
            ))}
          </select>
        </label>
      </div>

      <label className="booking-intro">
        Message on your booking page
        <textarea
          rows={2}
          maxLength={500}
          value={page.intro || ""}
          placeholder="e.g. Looking for a 3-bed house with a garden in Herne Hill, up to £800k. Proceedable, mortgage agreed in principle."
          onChange={(e) => updatePage("intro", e.target.value)}
        />
      </label>

      <h3 className="booking-step">When agents can book you (UK time)</h3>
      <div className="availability-grid">
        {WEEKDAYS.map(([weekday, label]) => {
          const dayWindows = windows
            .map((w, index) => ({ ...w, index }))
            .filter((w) => w.weekday === weekday);

          return (
            <div className="availability-day" key={weekday}>
              <strong>{label}</strong>
              <div className="availability-windows">
                {dayWindows.length === 0 && <span className="muted">Not available</span>}
                {dayWindows.map((w) => (
                  <div className="availability-window" key={w.index}>
                    <input
                      type="time"
                      step={900}
                      value={w.start_time}
                      aria-label={`${label} start`}
                      onChange={(e) => updateWindow(w.index, "start_time", e.target.value)}
                    />
                    <span>–</span>
                    <input
                      type="time"
                      step={900}
                      value={w.end_time}
                      aria-label={`${label} end`}
                      onChange={(e) => updateWindow(w.index, "end_time", e.target.value)}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`Remove ${label} window`}
                      onClick={() => removeWindow(w.index)}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button type="button" className="link-button" onClick={() => addWindow(weekday)}>
                + Add time
              </button>
            </div>
          );
        })}
      </div>

      <label className="booking-toggle">
        <input
          type="checkbox"
          checked={page.is_active}
          onChange={(e) => updatePage("is_active", e.target.checked)}
        />
        Booking page is live
      </label>

      <div className="button-row">
        <button type="button" className="primary" onClick={save} disabled={saving}>
          {saving ? "Saving…" : page.isNew ? "Create booking page" : "Save"}
        </button>
        {message && <span className="muted">{message}</span>}
      </div>
    </div>
  );
}

export default BookingSettings;
