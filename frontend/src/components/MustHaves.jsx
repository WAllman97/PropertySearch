import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// The household's must-haves (dealbreaker list), set once in Settings, and
// each home's ticks against it, made while viewing (migration 031). Ticks are
// stored with the home's notes: property_notes.checklist = {id: "yes"|"no"}.

const SUGGESTIONS = [
  "Garden",
  "Off-street parking",
  "Good natural light",
  "Quiet street",
  "Walk to a station",
  "Room for a home office",
  "Plenty of storage",
  "Separate kitchen and living space",
  "No major work needed",
  "Good phone signal",
];

const MISSING = "Must-haves aren't switched on yet (database migration 031).";

export function useMustHaves() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState("");

  const reload = useCallback(async () => {
    const { data, error: loadError } = await supabase
      .from("must_haves")
      .select("id, label, position")
      .order("position")
      .order("created_at");
    if (loadError) {
      setError(MISSING);
      setItems([]);
      return;
    }
    setError("");
    setItems(data || []);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  return { items, error, reload };
}

// How a home did against the list: { yes, no, total }.
export function checklistSummary(items, checklist) {
  const ticks = checklist || {};
  let yes = 0;
  let no = 0;
  for (const item of items || []) {
    if (ticks[item.id] === "yes") yes += 1;
    else if (ticks[item.id] === "no") no += 1;
  }
  return { yes, no, total: (items || []).length };
}

// One short line for a tile: "✗ 1 dealbreaker" beats "4 of 5 ticked".
export function ChecklistChip({ items, checklist }) {
  const { yes, no, total } = checklistSummary(items, checklist);
  if (!total || (!yes && !no)) return null;
  if (no) {
    return (
      <span className="must-have-chip bad">
        ✗ {no} must-have{no === 1 ? "" : "s"} missing
      </span>
    );
  }
  return (
    <span className={`must-have-chip${yes === total ? " good" : ""}`}>
      ✓ {yes} of {total} must-haves
    </span>
  );
}

// Settings: add and remove the household's must-haves.
export function MustHaveSettings() {
  const { items, error, reload } = useMustHaves();
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  async function add(text) {
    const clean = text.trim();
    if (!clean) return;
    if (items.some((item) => item.label.toLowerCase() === clean.toLowerCase())) {
      setMessage("That's already on your list.");
      return;
    }
    setSaving(true);
    setMessage("");
    const position = items.length ? Math.max(...items.map((item) => item.position)) + 1 : 0;
    const { error: saveError } = await supabase.from("must_haves").insert({ label: clean.slice(0, 80), position });
    setSaving(false);
    if (saveError) {
      setMessage("Couldn't add that. Please try again.");
      return;
    }
    setLabel("");
    reload();
  }

  async function remove(item) {
    const { error: removeError } = await supabase.from("must_haves").delete().eq("id", item.id);
    if (removeError) {
      setMessage("Couldn't remove that. Please try again.");
      return;
    }
    reload();
  }

  if (!items) return <p className="muted">Loading...</p>;
  if (error) return <p className="muted">{error}</p>;

  const unused = SUGGESTIONS.filter((s) => !items.some((item) => item.label.toLowerCase() === s.toLowerCase()));

  return (
    <div className="must-have-settings">
      {items.length ? (
        <ul className="must-have-list">
          {items.map((item) => (
            <li key={item.id}>
              <span>{item.label}</span>
              <button type="button" className="link-button" onClick={() => remove(item)} aria-label={`Remove ${item.label}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">
          Nothing yet. Add the things a home must have. At each viewing you tick them off, so you can see at a glance
          which homes fall short.
        </p>
      )}

      <form
        className="must-have-add"
        onSubmit={(event) => {
          event.preventDefault();
          add(label);
        }}
      >
        <input
          type="text"
          value={label}
          maxLength={80}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="e.g. South-facing garden"
          aria-label="New must-have"
        />
        <button type="submit" className="primary-button" disabled={saving || !label.trim()}>
          Add
        </button>
      </form>

      {unused.length > 0 && (
        <div className="must-have-suggestions">
          <span className="muted small">Quick add:</span>
          {unused.map((s) => (
            <button key={s} type="button" className="chip-button" onClick={() => add(s)} disabled={saving}>
              + {s}
            </button>
          ))}
        </div>
      )}

      {message && <p className="form-message">{message}</p>}
    </div>
  );
}

// At a viewing: tick each must-have off, and jot notes. Saves as you go.
export function ViewingChecklist({ propertyId, onOpenSettings }) {
  const { items, error } = useMustHaves();
  const [checklist, setChecklist] = useState({});
  const [notes, setNotes] = useState("");
  const savedNotes = useRef("");
  // The latest typed text, and the text currently on its way to the server.
  // Refs, so the unmount / tab-hidden saves see the newest words.
  const notesRef = useRef("");
  const savingNotes = useRef(null);
  const currentId = useRef(propertyId);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    setStatus("");
    const load = (columns) =>
      supabase.from("property_notes").select(columns).eq("property_id", propertyId).maybeSingle();
    // Before migration 031 there's no checklist column: still show the notes.
    load("checklist, viewing_notes")
      .then((result) => (result.error ? load("viewing_notes") : result))
      .then(({ data }) => {
        if (!live) return;
        setChecklist(data?.checklist || {});
        setNotes(data?.viewing_notes || "");
        notesRef.current = data?.viewing_notes || "";
        savedNotes.current = data?.viewing_notes || "";
      });
    return () => {
      live = false;
    };
  }, [propertyId]);

  async function save(values, id = propertyId, { quiet = false } = {}) {
    if (!quiet) setStatus("Saving...");
    let saveError;
    try {
      ({ error: saveError } = await supabase
        .from("property_notes")
        .upsert({ property_id: id, ...values, updated_at: new Date().toISOString() }, { onConflict: "property_id" }));
    } catch (err) {
      saveError = err;
    }
    setStatus(saveError ? "Couldn't save. Check your connection and try again." : "Saved");
    return !saveError;
  }

  // Tap the same answer again to clear it.
  async function tick(item, answer) {
    const before = checklist;
    const next = { ...checklist };
    if (next[item.id] === answer) delete next[item.id];
    else next[item.id] = answer;
    setChecklist(next);
    if (!(await save({ checklist: next }))) setChecklist(before);
  }

  // Saves the notes for `id` if they've changed. Skips unchanged text and
  // text that's already being saved, so the timer, blur and unmount saves
  // can't double up.
  async function saveNotes(id = propertyId) {
    const text = notesRef.current;
    if (text === savedNotes.current || text === savingNotes.current) return;
    savingNotes.current = text;
    const ok = await save({ viewing_notes: text || null }, id, { quiet: true });
    if (savingNotes.current === text) savingNotes.current = null;
    // Ignore a late reply for a home we've since moved away from.
    if (ok && currentId.current === id) savedNotes.current = text;
  }
  const saveNotesRef = useRef(saveNotes);
  saveNotesRef.current = saveNotes;

  function changeNotes(value) {
    notesRef.current = value;
    setNotes(value);
  }

  // Autosave shortly after typing stops, so closing the sheet or locking the
  // phone mid-sentence doesn't lose anything.
  useEffect(() => {
    const timer = setTimeout(() => saveNotesRef.current(propertyId), 800);
    return () => clearTimeout(timer);
  }, [notes, propertyId]);

  // Also save straight away when the app goes to the background, and when
  // the sheet closes or switches to another home (cleanup runs with the old id).
  useEffect(() => {
    // A new home starts blank until its notes load, so the old home's text
    // can't be autosaved onto it.
    if (currentId.current !== propertyId) {
      notesRef.current = "";
      savedNotes.current = "";
      savingNotes.current = null;
      setNotes("");
    }
    currentId.current = propertyId;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveNotesRef.current(propertyId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      saveNotesRef.current(propertyId);
    };
  }, [propertyId]);

  const { yes, no, total } = checklistSummary(items, checklist);

  return (
    <div className="viewing-checklist">
      <div className="viewing-checklist-head">
        <h3>Must-haves</h3>
        {total > 0 && (
          <span className="muted small">
            {no ? `${no} missing · ` : ""}
            {yes} of {total} ticked
          </span>
        )}
      </div>

      {error && <p className="muted">{error}</p>}
      {items && !error && !items.length && (
        <p className="muted">
          Add your must-haves (garden, parking, light...) and tick them off at each viewing.{" "}
          {onOpenSettings && (
            <button type="button" className="link-button" onClick={onOpenSettings}>
              Set them up
            </button>
          )}
        </p>
      )}

      {items?.length > 0 && (
        <ul className="checklist-items">
          {items.map((item) => {
            const answer = checklist[item.id];
            return (
              <li key={item.id} className={answer ? `answered ${answer}` : ""}>
                <span className="checklist-label">{item.label}</span>
                <span className="checklist-answers" role="group" aria-label={item.label}>
                  <button
                    type="button"
                    className={`checklist-answer yes${answer === "yes" ? " active" : ""}`}
                    aria-pressed={answer === "yes"}
                    onClick={() => tick(item, "yes")}
                  >
                    ✓ Yes
                  </button>
                  <button
                    type="button"
                    className={`checklist-answer no${answer === "no" ? " active" : ""}`}
                    aria-pressed={answer === "no"}
                    onClick={() => tick(item, "no")}
                  >
                    ✗ No
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <label className="viewing-notes-field">
        Viewing notes
        <textarea
          value={notes}
          onChange={(event) => changeNotes(event.target.value)}
          onBlur={() => saveNotes()}
          placeholder="How did it feel? Light, noise, the neighbours, what the agent said..."
          rows={4}
        />
      </label>
      <div className="viewing-checklist-foot">
        {notes !== savedNotes.current && (
          <button type="button" className="secondary-button" onClick={() => saveNotes()}>
            Save notes
          </button>
        )}
        {status && <span className="muted small">{status}</span>}
      </div>
    </div>
  );
}
