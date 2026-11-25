import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// On the day of a viewing, the things you need standing outside the door:
// directions, the agent's number, your must-haves and notes, and photos.
// Photos are private to the household (bucket viewing-photos, migration 036),
// stored as <household id>/<property id>/<random id>.jpg.

const PHOTO_BUCKET = "viewing-photos";
// Phone photos are 3-5 MB; this is plenty to remember a room by.
const MAX_SIDE = 1600;
const HOUR_MS = 3600000;

export function directionsUrl(address) {
  // Apple Maps on iPhone; other devices get a web map.
  return `https://maps.apple.com/?q=${encodeURIComponent(address || "")}`;
}

// From the start of the viewing's day until about an hour after it starts.
export function isViewingDay(when, now = new Date()) {
  if (!when) return false;
  const at = new Date(when);
  if (Number.isNaN(at.getTime())) return false;
  const dayStart = new Date(at);
  dayStart.setHours(0, 0, 0, 0);
  return now >= dayStart && now.getTime() <= at.getTime() + HOUR_MS;
}

// Re-render once a minute, so the card appears and goes on time.
export function useMinuteClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function timeText(when) {
  return new Date(when).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

// Shrink to a JPEG before uploading: smaller, quicker on mobile data, and the
// same format whatever the camera produced. Falls back to the original file.
async function toJpeg(file) {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.82));
    if (blob) return { body: blob, type: "image/jpeg" };
  } catch {
    // Older browsers: upload as it came.
  }
  return { body: file, type: file.type || "image/jpeg" };
}

export function ViewingPhotos({ householdId, propertyId }) {
  const [photos, setPhotos] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // The photo waiting for "Delete" to be confirmed.
  const [confirming, setConfirming] = useState(null);
  const inputRef = useRef(null);
  const folder = `${householdId}/${propertyId}`;

  const load = useCallback(async () => {
    const { data, error: listError } = await supabase.storage
      .from(PHOTO_BUCKET)
      .list(folder, { sortBy: { column: "created_at", order: "asc" } });
    if (listError) {
      // Usually the bucket isn't there yet (migration 036).
      setPhotos([]);
      return;
    }
    const files = (data || []).filter((f) => f.id && f.name);
    if (!files.length) {
      setPhotos([]);
      return;
    }
    const paths = files.map((f) => `${folder}/${f.name}`);
    // The bucket is private: short-lived links, made fresh on each visit.
    const { data: signed } = await supabase.storage.from(PHOTO_BUCKET).createSignedUrls(paths, 3600);
    setPhotos(
      paths.map((path, i) => ({ path, url: signed?.[i]?.signedUrl || null })).filter((p) => p.url)
    );
  }, [folder]);

  useEffect(() => {
    setPhotos(null);
    load();
  }, [load]);

  async function add(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setError("That isn't a photo.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const { body, type } = await toJpeg(file);
      const { error: uploadError } = await supabase.storage
        .from(PHOTO_BUCKET)
        .upload(`${folder}/${crypto.randomUUID()}.jpg`, body, { contentType: type, upsert: false });
      if (uploadError) throw uploadError;
      await load();
    } catch (err) {
      console.error("Photo upload failed:", err);
      setError("Couldn't add that photo. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(photo) {
    setConfirming(null);
    const { error: removeError } = await supabase.storage.from(PHOTO_BUCKET).remove([photo.path]);
    if (removeError) {
      setError("Couldn't delete that photo. Please try again.");
      return;
    }
    setPhotos((current) => (current || []).filter((p) => p.path !== photo.path));
  }

  return (
    <div className="viewing-photos">
      <div className="viewing-photos-head">
        <h4>Photos</h4>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => inputRef.current?.click()}>
          {busy ? "Adding..." : "📷 Add photo"}
        </button>
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          capture="environment"
          onChange={add}
          hidden
        />
      </div>

      {photos === null ? null : photos.length ? (
        <ul className="viewing-photo-grid">
          {photos.map((photo) => (
            <li key={photo.path}>
              <a href={photo.url} target="_blank" rel="noreferrer">
                <img src={photo.url} alt="Viewing photo" loading="lazy" />
              </a>
              {confirming === photo.path ? (
                <span className="viewing-photo-confirm">
                  <button type="button" className="danger-button" onClick={() => remove(photo)}>
                    Delete
                  </button>
                  <button type="button" onClick={() => setConfirming(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="viewing-photo-remove"
                  aria-label="Delete this photo"
                  onClick={() => setConfirming(photo.path)}
                >
                  ✕
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Snap the rooms, the view, anything you'll want to remember. Only your household sees them.</p>
      )}

      {error && <p className="form-error">{error}</p>}
    </div>
  );
}

// address, agent, phone and when describe the viewing; children is the
// must-haves checklist and notes, which differ by screen.
function ViewingDayCard({ address, when, agent, phone, householdId, propertyId, children, onDetails }) {
  return (
    <section className="viewing-day" aria-label="Viewing today">
      <p className="eyebrow">Viewing today</p>
      <h3>{address || "Viewing"}</h3>
      <p className="viewing-day-when">
        {timeText(when)}
        {agent ? ` · with ${agent}` : ""}
      </p>

      <div className="viewing-day-actions">
        {address && (
          <a className="primary-button" href={directionsUrl(address)} target="_blank" rel="noreferrer">
            Directions
          </a>
        )}
        {phone && (
          <a className="secondary-button" href={`tel:${phone.replace(/\s+/g, "")}`}>
            Call agent
          </a>
        )}
        {onDetails && (
          <button type="button" className="secondary-button" onClick={onDetails}>
            Details
          </button>
        )}
      </div>

      {children && <div className="viewing-day-notes">{children}</div>}

      {householdId && propertyId && <ViewingPhotos householdId={householdId} propertyId={propertyId} />}
    </section>
  );
}

export default ViewingDayCard;
