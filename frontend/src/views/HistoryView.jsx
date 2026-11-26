import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { fromLocalInputValue, toLocalInputValue } from "../utils/datetime";
import PropertyScoreEditor from "../components/PropertyScoreEditor";
import CommuteSummary from "../components/CommuteSummary";
import MarketSignals from "../components/MarketSignals";
import ViewingSlots, { useAvailableViewings } from "../components/ViewingSlots";
import { OfferAcceptedButton, OfferStatus } from "../components/OfferStatus";
import { daysOnMarket, priceDrop } from "../utils/market";
import LoadError from "../components/LoadError";
import { friendlyError } from "../lib/errors";
import { findAgentContact } from "../lib/agentContacts";
import { cleanAddress, listingLinkLabel, portalName } from "../utils/listingText";
import { ChecklistChip, ViewingChecklist, useMustHaves } from "../components/MustHaves";
import StagePicker, { STAGES } from "../components/StagePicker";
import UndoBar from "../components/UndoBar";
import TotalCost, { useBuyerPosition } from "../components/TotalCost";
import CompareHomes from "../components/CompareHomes";
import ViewingDayCard, { ViewingPhotos, isViewingDay, useMinuteClock } from "../components/ViewingDayCard";

const emptyNotes = {
  viewing_datetime: "",
  estate_agent: "",
  estate_agent_email: "",
  estate_agent_phone: "",
  viewing_notes: "",
  positives: "",
  negatives: "",
  questions: "",
  general_notes: "",
};

// The free-text notes, saved as you type. (The viewing date and agent are
// saved separately, only when changed by hand.)
const NOTE_FIELDS = ["viewing_notes", "positives", "negatives", "questions", "general_notes"];
const noteText = (notes) => JSON.stringify(NOTE_FIELDS.map((field) => notes[field] || ""));
const NOTES_LOAD_FAILED = "Couldn't load your notes. Go back and open this home again before typing.";

// How far along each home is, for "Progress" (offers first).
const STAGE = {
  offer_accepted: 0,
  offer_made: 1,
  offer_considered: 2,
  viewing_booked: 3,
  viewed: 4,
  favourite: 5,
};
const time = (value) => (value ? new Date(value).getTime() : 0);

// Homes with no price (or score, or cut) always go last.
const WATCHLIST_SORTS = [
  { key: "newest", label: "Newest added", compare: (a, b) => time(b.created_at) - time(a.created_at) },
  { key: "oldest", label: "Oldest added", compare: (a, b) => time(a.created_at) - time(b.created_at) },
  { key: "price_low", label: "Price: low to high", compare: (a, b) => (a.price || Infinity) - (b.price || Infinity) },
  { key: "price_high", label: "Price: high to low", compare: (a, b) => (b.price || -Infinity) - (a.price || -Infinity) },
  { key: "score", label: "Highest score", compare: (a, b) => (b.overall_score ?? -1) - (a.overall_score ?? -1) },
  {
    key: "progress",
    label: "Progress (offers first)",
    compare: (a, b) => (STAGE[a.status] ?? 9) - (STAGE[b.status] ?? 9) || time(b.created_at) - time(a.created_at),
  },
  { key: "biggest_cut", label: "Biggest price cut", compare: (a, b) => (priceDrop(b)?.pct ?? -1) - (priceDrop(a)?.pct ?? -1) },
  { key: "longest_listed", label: "Longest on market", compare: (a, b) => (daysOnMarket(b) ?? -1) - (daysOnMarket(a) ?? -1) },
];
const SORT_KEY = "watchlistSort";
const FILTER_KEY = "watchlist-filter";
const MAX_COMPARE = 3;

const viewingWhen = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

const pounds = (price) => (price ? `£${Number(price).toLocaleString("en-GB")}` : "Price unavailable");

// The viewing as booked (through an agent, or typed in by the buyer), shown
// as a summary. Bookings fill this in themselves; editing is the exception.
function ViewingSummary({ notes, request, onEdit }) {
  const when = notes.viewing_datetime ? new Date(notes.viewing_datetime) : null;
  const past = when && when < new Date();
  const agent = notes.estate_agent;
  const phone = notes.estate_agent_phone;
  const email = notes.estate_agent_email;
  const waiting = !when && request && ["pending", "proposed"].includes(request.status);

  if (!when && !agent && !waiting) {
    return (
      <div className="viewing-summary none">
        <p>No viewing booked yet. Book one from the agent's times above, or add one you arranged yourself.</p>
        <div className="viewing-summary-links">
          <button type="button" className="link-button" onClick={onEdit}>
            + Add a viewing
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="viewing-summary">
      {when ? (
        <p className="viewing-summary-when">
          {past ? "Viewed" : "Viewing"} {viewingWhen.format(when)}
        </p>
      ) : waiting ? (
        <p className="viewing-summary-when">Viewing asked for, waiting to hear back</p>
      ) : (
        <p className="viewing-summary-when">No viewing date yet</p>
      )}
      {agent && <p>With {agent}</p>}
      <div className="viewing-summary-links">
        {phone && <a href={`tel:${phone.replace(/\s+/g, "")}`}>{phone}</a>}
        {email && <a href={`mailto:${email}`}>{email}</a>}
        <button type="button" className="link-button" onClick={onEdit}>
          Change
        </button>
      </div>
    </div>
  );
}

function getPropertyAgeDays(property) {
  const dateValue =
    property.date_found ||
    property.created_at ||
    property.uploaded_at;

  if (!dateValue) return null;

  const startDate = new Date(dateValue);
  const today = new Date();

  return Math.max(
    0,
    Math.floor((today - startDate) / (1000 * 60 * 60 * 24))
  );
}

function getAgeClass(days) {
  if (days === null) return "";
  if (days < 14) return "age-new";
  if (days < 60) return "age-medium";
  return "age-old";
}

function getAgeLabel(days) {
  if (days === null) return null;
  return days === 0 ? "Added today" : `Added ${days} ${days === 1 ? "day" : "days"} ago`;
}

// Same badges as the Properties tiles, minus "New" (it's already saved).
function tileBadges(property) {
  const badges = [];
  if (property.price && property.initial_price && property.price < property.initial_price) {
    badges.push({ text: "Reduced", kind: "reduced" });
  }
  if (property.listing_status === "sold_stc") badges.push({ text: "Sold STC", kind: "muted" });
  else if (property.listing_status === "under_offer") badges.push({ text: "Under offer", kind: "muted" });
  else if (property.listing_status === "removed") badges.push({ text: "Off market", kind: "muted" });
  return badges;
}

// A Watchlist tile: tap the photo to open the home; the stage button under
// it changes stage without opening anything. In Compare mode a tap picks it.
function WatchlistTile({ property, note, picking, picked, pickDisabled, onOpen, onPick, onStage }) {
  const badges = tileBadges(property);
  const facts = [
    property.bedrooms != null ? (property.bedrooms === 0 ? "Studio" : `${property.bedrooms} bed`) : "",
    property.property_type && property.property_type !== "house" ? property.property_type : "",
  ].filter(Boolean);

  return (
    <article className={`property-tile watch-tile${picked ? " picked" : ""}`}>
      <button
        type="button"
        className="tile-front"
        onClick={picking ? onPick : onOpen}
        disabled={picking && pickDisabled && !picked}
        aria-pressed={picking ? picked : undefined}
        aria-label={`${pounds(property.price)}, ${property.address || "property"}. ${
          picking ? (picked ? "Picked to compare" : "Pick to compare") : "Open"
        }`}
      >
        <div className="tile-photo">
          {property.image_url ? (
            <img src={property.image_url} alt="" loading="lazy" />
          ) : (
            <span className="tile-photo-empty" aria-hidden="true">
              🏠
            </span>
          )}
          {badges.length > 0 && (
            <span className="tile-badges">
              {badges.map((b) => (
                <span key={b.text} className={`tile-badge ${b.kind}`}>
                  {b.text}
                </span>
              ))}
            </span>
          )}
          {picking && (
            <span className="compare-tick" aria-hidden="true">
              {picked ? "✓" : ""}
            </span>
          )}
        </div>
        <div className="tile-caption">
          <strong>{pounds(property.price)}</strong>
          <span className="tile-address">{cleanAddress(property.address)}</span>
          {facts.length > 0 && <span className="tile-facts">{facts.join(" · ")}</span>}
          {note}
        </div>
      </button>
      {!picking && (
        <div className="watch-tile-stage">
          <StagePicker status={property.status} onChoose={onStage} />
        </div>
      )}
    </article>
  );
}

function HistoryView({ focusPropertyId, onFocused, onOpenSettings }) {
  const [sortKey, setSortKey] = useState(() => {
    try {
      const saved = localStorage.getItem(SORT_KEY);
      return WATCHLIST_SORTS.some((s) => s.key === saved) ? saved : "newest";
    } catch {
      return "newest";
    }
  });
  // Show only one stage (e.g. "Viewing booked"), remembered like the sort.
  const [stageFilter, setStageFilter] = useState(() => {
    try {
      const saved = localStorage.getItem(FILTER_KEY);
      return STAGES.some((s) => s.key === saved) ? saved : "all";
    } catch {
      return "all";
    }
  });
  function chooseFilter(key) {
    setStageFilter(key);
    try {
      localStorage.setItem(FILTER_KEY, key);
    } catch {
      // Private mode: just don't remember it.
    }
  }
  function chooseSort(key) {
    setSortKey(key);
    try {
      localStorage.setItem(SORT_KEY, key);
    } catch {
      // Private mode: just don't remember it.
    }
  }
  const { byProperty: viewingsByProperty, requestsByProperty, reload: reloadViewings } = useAvailableViewings();
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [notes, setNotes] = useState(emptyNotes);
  const [notesReady, setNotesReady] = useState(false);
  const [notesStatus, setNotesStatus] = useState("");
  const [savingViewing, setSavingViewing] = useState(false);
  const [viewingMessage, setViewingMessage] = useState("");
  const [editingViewing, setEditingViewing] = useState(false);
  // Which notes request is current, and whether this home's notes loaded.
  const notesRequest = useRef(0);
  const notesLoaded = useRef(false);
  // For the autosave (same approach as ViewingChecklist in MustHaves.jsx):
  // the latest typed notes, which home they belong to, the text as last
  // saved, and the text on its way to the server. Refs, so the tab-hidden
  // and close saves see the newest words.
  const notesRef = useRef(emptyNotes);
  const notesFor = useRef(null);
  const savedText = useRef(null);
  const savingText = useRef(null);
  const { items: mustHaves } = useMustHaves();
  // Each home's must-have ticks, for the tiles.
  const [checklists, setChecklists] = useState({});
  // Live accepted offers by property id (withdrawn ones are hidden).
  const [offers, setOffers] = useState({});
  const position = useBuyerPosition();
  const now = useMinuteClock();
  // A stage change that failed, or what just happened (offer saved...).
  const [actionError, setActionError] = useState("");
  const [actionMessage, setActionMessage] = useState("");
  // The last archive, for "Archived · Undo": { id, previous, key }.
  const [undo, setUndo] = useState(null);
  // "Offer accepted" chosen from the stage list: ask for the amount.
  const [reportingOffer, setReportingOffer] = useState(false);
  // Compare: picking homes, and the homes picked.
  const [picking, setPicking] = useState(false);
  const [pickedIds, setPickedIds] = useState([]);
  const [comparing, setComparing] = useState(false);

  useEffect(() => {
    loadWatchlist();
  }, []);

  useEffect(() => {
    if (selectedProperty) {
      loadNotes(selectedProperty.id);
    }
    setReportingOffer((current) => (selectedProperty ? current : false));
    // Only when a different home is opened, not on every refresh of it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProperty?.id]);

  // Arrived from a calendar viewing or the Dashboard: open that home.
  useEffect(() => {
    if (!focusPropertyId) return;
    supabase
      .from("properties")
      .select("*")
      .eq("id", focusPropertyId)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          setSelectedProperty(data);
          window.scrollTo(0, 0);
        }
        onFocused?.();
      });
  }, [focusPropertyId, onFocused]);

  // quiet: refresh in place (after a status tap, a booking, going back)
  // instead of swapping the list for a spinner and losing the scroll.
  async function loadWatchlist({ quiet = false } = {}) {
    if (!quiet) setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .in("status", [
        "favourite",
        "viewing_booked",
        "viewed",
        "offer_considered",
        "offer_made",
        "offer_accepted",
      ])
      .order("created_at", { ascending: false });

    const { data: offerRows } = await supabase
      .from("offers")
      .select("id, property_id, amount, status")
      .neq("status", "withdrawn");
    setOffers(Object.fromEntries((offerRows || []).map((o) => [o.property_id, o])));

    // checklist arrives with migration 031; before that, no ticks to show.
    const { data: noteRows } = await supabase.from("property_notes").select("property_id, checklist");
    setChecklists(Object.fromEntries((noteRows || []).map((n) => [n.property_id, n.checklist])));

    if (error) {
      console.error("Error loading watchlist:", error);
      setLoadError(error);
    } else {
      setLoadError(null);
      setProperties(
        (data || []).sort((a, b) => {
          const scoreA = a.overall_score || 0;
          const scoreB = b.overall_score || 0;
          return scoreB - scoreA;
        })
      );
    }

    setLoading(false);
  }

  function updateLocalProperty(updatedProperty) {
    setProperties((current) =>
      current.map((property) =>
        property.id === updatedProperty.id ? updatedProperty : property
      )
    );

    setSelectedProperty((current) =>
      current?.id === updatedProperty.id ? updatedProperty : current
    );
  }

  async function refreshSelectedProperty(propertyId) {
    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .eq("id", propertyId)
      .single();

    if (error) {
      console.error("Error refreshing property:", error);
      return;
    }

    if (data) {
      setSelectedProperty(data);
    }

    await loadWatchlist({ quiet: true });
  }

  // viewingOnly: a booking or a cancelled edit changed the viewing details;
  // refresh those and leave the notes being typed alone.
  async function loadNotes(propertyId, { viewingOnly = false } = {}) {
    const sameHome = notesFor.current === propertyId && notesLoaded.current;
    const ticket = ++notesRequest.current;
    setEditingViewing(false);
    setViewingMessage("");
    if (!(viewingOnly && sameHome)) {
      notesLoaded.current = false;
      notesFor.current = propertyId;
      savedText.current = null;
      savingText.current = null;
      notesRef.current = emptyNotes;
      setNotes(emptyNotes);
      setNotesReady(false);
      setNotesStatus("");
    }

    const { data, error } = await supabase
      .from("property_notes")
      .select("*")
      .eq("property_id", propertyId)
      .maybeSingle();

    // Opened another home since: this answer is for the old one.
    if (ticket !== notesRequest.current) return;

    if (error) {
      console.error("Error loading notes:", error);
      if (viewingOnly && sameHome) return;
      setNotesStatus(NOTES_LOAD_FAILED);
      return;
    }

    const viewing = {
      viewing_datetime: toLocalInputValue(data?.viewing_datetime),
      estate_agent: data?.estate_agent || "",
      estate_agent_email: data?.estate_agent_email || "",
      estate_agent_phone: data?.estate_agent_phone || "",
    };
    if (viewingOnly && sameHome) {
      notesRef.current = { ...notesRef.current, ...viewing };
      setNotes(notesRef.current);
      return;
    }

    const loaded = {
      ...viewing,
      viewing_notes: data?.viewing_notes || "",
      positives: data?.positives || "",
      negatives: data?.negatives || "",
      questions: data?.questions || "",
      general_notes: data?.general_notes || "",
    };
    notesRef.current = loaded;
    savedText.current = noteText(loaded);
    notesLoaded.current = true;
    setNotes(loaded);
    setNotesReady(true);
    fillAgentContact(propertyId, { save: true });
  }

  // The agent's email and phone from another home with the same agent (the
  // household's address book), into whichever is blank. On opening a home
  // they're saved with it; after typing a name they're saved with "Save
  // viewing", like the rest of that form.
  async function fillAgentContact(propertyId, { save = false } = {}) {
    const start = notesRef.current;
    if (!start.estate_agent?.trim() || (start.estate_agent_email && start.estate_agent_phone)) return;
    const known = await findAgentContact(start.estate_agent);
    const current = notesRef.current;
    if (!known || notesFor.current !== propertyId || current.estate_agent !== start.estate_agent) return;
    const fill = {};
    if (!current.estate_agent_email && known.email) fill.estate_agent_email = known.email;
    if (!current.estate_agent_phone && known.phone) fill.estate_agent_phone = known.phone;
    if (!Object.keys(fill).length) return;
    notesRef.current = { ...current, ...fill };
    setNotes(notesRef.current);
    if (save) {
      const { error } = await supabase.from("property_notes").update(fill).eq("property_id", propertyId);
      if (error) console.error("Could not save the agent's details:", error);
    }
  }

  // Saves the typed notes for home `id` if they've changed. Never before
  // they've loaded (that would write a blank form over the real notes), and
  // never twice for the same text, so the timer, blur, tab-hidden and close
  // saves can't double up.
  async function saveNoteText(id) {
    if (!id || !notesLoaded.current || notesFor.current !== id) return;
    const current = notesRef.current;
    const text = noteText(current);
    if (text === savedText.current || text === savingText.current) return;
    savingText.current = text;
    setNotesStatus("Saving...");

    let saveError;
    try {
      ({ error: saveError } = await supabase.from("property_notes").upsert(
        {
          property_id: id,
          viewing_notes: current.viewing_notes || null,
          positives: current.positives,
          negatives: current.negatives,
          questions: current.questions,
          general_notes: current.general_notes,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "property_id" }
      ));
    } catch (err) {
      saveError = err;
    }

    if (savingText.current === text) savingText.current = null;
    // A late reply for a home we've since left: nothing to update here.
    if (notesFor.current !== id) return;
    if (saveError) {
      console.error("Error saving notes:", saveError);
      setNotesStatus("Couldn't save. Check your connection; we'll try again as you type.");
      return;
    }
    savedText.current = text;
    setNotesStatus("Saved");
  }
  const saveNoteTextRef = useRef(saveNoteText);
  saveNoteTextRef.current = saveNoteText;

  // Autosave shortly after typing stops.
  const selectedId = selectedProperty?.id;
  useEffect(() => {
    if (!selectedId) return undefined;
    const timer = setTimeout(() => saveNoteTextRef.current(selectedId), 800);
    return () => clearTimeout(timer);
  }, [notes, selectedId]);

  // And straight away when the app goes to the background, when going back
  // to the list, or when this tab closes (cleanup runs with the old id).
  useEffect(() => {
    if (!selectedId) return undefined;
    const onVisibility = () => {
      if (document.visibilityState === "hidden") saveNoteTextRef.current(selectedId);
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      saveNoteTextRef.current(selectedId);
    };
  }, [selectedId]);

  // The viewing date and agent, when changed by hand. Only these fields, so
  // a booking made since this page opened isn't written over by accident.
  async function saveViewing() {
    if (!selectedProperty) return;
    if (!notesLoaded.current) {
      setViewingMessage(NOTES_LOAD_FAILED);
      return;
    }

    setSavingViewing(true);
    setViewingMessage("");
    const viewingDatetime = fromLocalInputValue(notes.viewing_datetime);
    const { error } = await supabase.from("property_notes").upsert(
      {
        property_id: selectedProperty.id,
        viewing_datetime: viewingDatetime,
        estate_agent: notes.estate_agent,
        estate_agent_email: notes.estate_agent_email,
        estate_agent_phone: notes.estate_agent_phone,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "property_id" }
    );
    setSavingViewing(false);

    if (error) {
      console.error("Error saving viewing:", error);
      setViewingMessage(friendlyError(error));
      return;
    }

    // A date added by hand moves an early-stage home on to "Viewing booked".
    if (viewingDatetime && ["new", "favourite"].includes(selectedProperty.status)) {
      await updateStatus(selectedProperty.id, "viewing_booked");
    }
    setEditingViewing(false);
    setViewingMessage("Viewing saved.");
  }

  // Returns true when it worked; a failure shows inline.
  async function updateStatus(propertyId, status) {
    setActionError("");
    const { error } = await supabase
      .from("properties")
      .update({ status })
      .eq("id", propertyId);

    if (error) {
      console.error("Error updating property:", error);
      setActionError(friendlyError(error));
      return false;
    }

    if (selectedProperty?.id === propertyId) {
      setSelectedProperty((current) =>
        current ? { ...current, status } : current
      );
    }

    await loadWatchlist({ quiet: true });
    return true;
  }

  async function archive(property) {
    const previous = property.status;
    if (!(await updateStatus(property.id, "archived"))) return;
    if (selectedProperty?.id === property.id) setSelectedProperty(null);
    setUndo({ id: property.id, previous, key: Date.now() });
  }

  async function undoArchive() {
    const last = undo;
    setUndo(null);
    if (last) await updateStatus(last.id, last.previous);
  }

  // A choice from the stage list, on a tile or in the home's page.
  async function chooseStage(property, key) {
    setActionMessage("");
    if (key === "archived") {
      await archive(property);
      return;
    }
    // An accepted offer goes to the agent to confirm, so it needs the amount.
    if (key === "offer_accepted" && !offers[property.id]) {
      if (selectedProperty?.id !== property.id) setSelectedProperty(property);
      setReportingOffer(true);
      return;
    }
    if (!(await updateStatus(property.id, key))) return;
    // Just viewed: straight to the must-haves and notes.
    if (key === "viewed" && selectedProperty?.id !== property.id) {
      setSelectedProperty({ ...property, status: "viewed" });
      window.scrollTo(0, 0);
    }
  }

  function offerChanged(message) {
    setReportingOffer(false);
    if (message) setActionMessage(message);
    if (selectedProperty) refreshSelectedProperty(selectedProperty.id);
    else loadWatchlist({ quiet: true });
  }

  function handleNotesChange(event) {
    const { name, value } = event.target;
    const next = { ...notesRef.current, [name]: value };
    notesRef.current = next;
    setNotes(next);
  }

  function togglePick(id) {
    setPickedIds((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : current.length < MAX_COMPARE ? [...current, id] : current
    );
  }

  function stopPicking() {
    setPicking(false);
    setPickedIds([]);
    setComparing(false);
  }

  const sortedProperties = useMemo(() => {
    const sort = WATCHLIST_SORTS.find((item) => item.key === sortKey) || WATCHLIST_SORTS[0];
    return [...properties].sort(sort.compare);
  }, [properties, sortKey]);

  const stageCounts = useMemo(() => {
    const counts = {};
    for (const p of properties) counts[p.status] = (counts[p.status] || 0) + 1;
    return counts;
  }, [properties]);
  const shownProperties =
    stageFilter === "all" ? sortedProperties : sortedProperties.filter((p) => p.status === stageFilter);

  // Hidden while picking homes to compare: both bars sit at the bottom.
  const undoBar = undo && !picking && (
    <UndoBar key={undo.key} message="Archived" onUndo={undoArchive} onDone={() => setUndo(null)} />
  );

  if (selectedProperty) {
    const selectedAgeDays = getPropertyAgeDays(selectedProperty);
    const offer = offers[selectedProperty.id];
    const viewingToday = !editingViewing && isViewingDay(notes.viewing_datetime, now);

    const mustHaveTicks = (
      <ViewingChecklist propertyId={selectedProperty.id} onOpenSettings={onOpenSettings} withNotes={false} />
    );

    // One Notes box: viewing notes, pros, cons, questions and anything else,
    // all saved as you type.
    const notesBox = (
      <div className="notes-box">
        <div className="notes-box-head">
          <h3>Notes</h3>
          <span className="notes-status" aria-live="polite">
            {notesStatus}
          </span>
        </div>

        <label>
          At the viewing
          <textarea
            name="viewing_notes"
            value={notes.viewing_notes}
            onChange={handleNotesChange}
            onBlur={() => saveNoteText(selectedProperty.id)}
            readOnly={!notesReady}
            rows={3}
            placeholder="How did it feel? Light, noise, the neighbours, what the agent said..."
          />
        </label>

        <div className="notes-box-pair">
          <label>
            Positives
            <textarea
              name="positives"
              value={notes.positives}
              onChange={handleNotesChange}
              onBlur={() => saveNoteText(selectedProperty.id)}
              readOnly={!notesReady}
            />
          </label>

          <label>
            Negatives
            <textarea
              name="negatives"
              value={notes.negatives}
              onChange={handleNotesChange}
              onBlur={() => saveNoteText(selectedProperty.id)}
              readOnly={!notesReady}
            />
          </label>
        </div>

        <label>
          Questions to ask
          <textarea
            name="questions"
            value={notes.questions}
            onChange={handleNotesChange}
            onBlur={() => saveNoteText(selectedProperty.id)}
            readOnly={!notesReady}
          />
        </label>

        <label>
          Anything else
          <textarea
            name="general_notes"
            value={notes.general_notes}
            onChange={handleNotesChange}
            onBlur={() => saveNoteText(selectedProperty.id)}
            readOnly={!notesReady}
          />
        </label>

        <p className="notes-hint">Saves as you type. Your household sees the same notes.</p>
      </div>
    );

    return (
      <>
        <section className="card">
          <button
            type="button"
            className="secondary-button"
            onClick={() => {
              setSelectedProperty(null);
              setActionMessage("");
              // Ticks and changes made here show on the tiles.
              loadWatchlist({ quiet: true });
            }}
          >
            ← Back to Watchlist
          </button>

          <div className="property-detail-layout">
            {selectedProperty.image_url && (
              <img
                src={selectedProperty.image_url}
                alt={selectedProperty.address}
                className="property-detail-image"
              />
            )}

            <div>
              <h2>{pounds(selectedProperty.price)}</h2>

              <p>{cleanAddress(selectedProperty.address)}</p>

              {position && (
                <TotalCost price={selectedProperty.price} position={position} onOpenSettings={() => onOpenSettings?.("position")} />
              )}

              <div className="detail-stage-row">
                <StagePicker
                  status={selectedProperty.status}
                  onChoose={(key) => chooseStage(selectedProperty, key)}
                />
                {offer && <OfferStatus offer={offer} onChanged={offerChanged} />}
                {!offer && !reportingOffer && selectedProperty.status === "offer_accepted" && (
                  <button type="button" className="link-button" onClick={() => setReportingOffer(true)}>
                    Add the accepted amount
                  </button>
                )}
                {!offer && reportingOffer && (
                  <OfferAcceptedButton
                    property={selectedProperty}
                    startOpen
                    onChanged={offerChanged}
                    onCancel={() => setReportingOffer(false)}
                  />
                )}
              </div>
              {actionError && (
                <p className="form-error" role="alert">
                  {actionError}
                </p>
              )}
              {actionMessage && <p className="form-message">{actionMessage}</p>}

              <MarketSignals property={selectedProperty} defaultOpen />
              <ViewingSlots
                property={selectedProperty}
                slots={viewingsByProperty[selectedProperty.id]}
                request={requestsByProperty[selectedProperty.id]}
                onChanged={() => {
                  // A booking fills in the viewing and moves the home to
                  // "Viewing booked" on the server: show both straight away.
                  reloadViewings();
                  loadNotes(selectedProperty.id, { viewingOnly: true });
                  refreshSelectedProperty(selectedProperty.id);
                }}
              />

              <div className="property-score-strip">
                <span>🏠 {selectedProperty.overall_score ? `${selectedProperty.overall_score}/100` : "Not scored"}</span>
                <span>❤️ {selectedProperty.score_gut_feel || 0}/10</span>
                {selectedProperty.offer_interest && (
                  <span>Offer: {selectedProperty.offer_interest}</span>
                )}
              </div>

              <CommuteSummary
                property={selectedProperty}
                onCommuteSaved={updateLocalProperty}
              />

              <div className="property-meta">
                <span>{portalName(selectedProperty.source)}</span>

                {selectedProperty.bedrooms && (
                  <span>{selectedProperty.bedrooms} bed{selectedProperty.bedrooms === 1 ? "" : "s"}</span>
                )}

                {selectedAgeDays !== null && (
                  <span className={getAgeClass(selectedAgeDays)}>
                    {getAgeLabel(selectedAgeDays)}
                  </span>
                )}
              </div>

              {selectedProperty.listing_url && (
                <a
                  className="listing-link"
                  href={selectedProperty.listing_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {listingLinkLabel(selectedProperty.source, selectedProperty.listing_url)}
                </a>
              )}
            </div>
          </div>

          <div className="details-section">
            <h3>Viewing</h3>
            <ViewingSummary
              notes={notes}
              request={requestsByProperty[selectedProperty.id]}
              onEdit={() => setEditingViewing(true)}
            />

            {editingViewing && (
              <div className="viewing-edit">
                <label>
                  Viewing date and time
                  <input
                    name="viewing_datetime"
                    type="datetime-local"
                    value={notes.viewing_datetime}
                    onChange={handleNotesChange}
                  />
                </label>

                <label>
                  Estate agent
                  <input
                    name="estate_agent"
                    type="text"
                    value={notes.estate_agent}
                    onChange={handleNotesChange}
                    onBlur={() => fillAgentContact(selectedProperty?.id)}
                    placeholder="Agent name / branch"
                  />
                </label>

                <label>
                  Estate agent email
                  <input
                    name="estate_agent_email"
                    type="email"
                    value={notes.estate_agent_email}
                    onChange={handleNotesChange}
                    placeholder="agent@example.com"
                  />
                </label>

                <label>
                  Estate agent phone
                  <input
                    name="estate_agent_phone"
                    type="tel"
                    autoComplete="tel"
                    value={notes.estate_agent_phone}
                    onChange={handleNotesChange}
                    placeholder="Phone number"
                  />
                </label>

                <div className="property-actions">
                  <button type="button" className="primary-button" onClick={saveViewing} disabled={savingViewing}>
                    {savingViewing ? "Saving..." : "Save viewing"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingViewing(false);
                      loadNotes(selectedProperty.id, { viewingOnly: true });
                    }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
            {viewingMessage && <p className="form-message">{viewingMessage}</p>}
          </div>

          {/* On the day: directions, the agent and photos at the top. The
              must-haves and notes stay where they always are, so the card
              appearing or going (on the minute) never rebuilds them and
              closes the keyboard mid-sentence. */}
          {viewingToday && (
            <div className="details-section">
              <ViewingDayCard
                address={selectedProperty.address}
                when={notes.viewing_datetime}
                agent={notes.estate_agent}
                phone={notes.estate_agent_phone}
                householdId={selectedProperty.household_id}
                propertyId={selectedProperty.id}
              />
            </div>
          )}
          <div className="details-section">{mustHaveTicks}</div>
          <div className="details-section">{notesBox}</div>
          {/* After the day the photos stay here with the home. */}
          {!viewingToday && notes.viewing_datetime && selectedProperty.household_id && (
            <div className="details-section">
              <ViewingPhotos householdId={selectedProperty.household_id} propertyId={selectedProperty.id} />
            </div>
          )}

          <div className="details-section">
            <PropertyScoreEditor
              property={selectedProperty}
              onUpdate={async () => {
                await refreshSelectedProperty(selectedProperty.id);
              }}
            />
          </div>
        </section>
        {undoBar}
      </>
    );
  }

  if (loading) {
    return (
      <section className="card">
        <h2>Loading watchlist...</h2>
      </section>
    );
  }

  if (loadError) return <LoadError error={loadError} onRetry={loadWatchlist} />;

  const pickedHomes = pickedIds.map((id) => properties.find((p) => p.id === id)).filter(Boolean);

  if (comparing && pickedHomes.length >= 2) {
    return (
      <section className="card">
        <CompareHomes
          homes={pickedHomes}
          mustHaves={mustHaves}
          checklists={checklists}
          offers={offers}
          position={position}
          onBack={() => setComparing(false)}
          onOpen={(home) => {
            stopPicking();
            setSelectedProperty(home);
            window.scrollTo(0, 0);
          }}
        />
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <div className="section-header watchlist-head">
          <div>
            <h2>Watchlist</h2>
            <p>
              {picking
                ? `Pick 2 or ${MAX_COMPARE} homes to compare`
                : stageFilter === "all"
                  ? `${properties.length} ${properties.length === 1 ? "home" : "homes"}`
                  : `${shownProperties.length} of ${properties.length} homes`}
            </p>
          </div>
          <div className="watchlist-tools">
            {properties.length > 1 && !picking && (
              <label className="market-sort watchlist-sort">
                Show
                <select value={stageFilter} onChange={(event) => chooseFilter(event.target.value)}>
                  <option value="all">All ({properties.length})</option>
                  {STAGES.filter((s) => stageCounts[s.key] || s.key === stageFilter).map((s) => (
                    <option key={s.key} value={s.key}>
                      {s.label} ({stageCounts[s.key] || 0})
                    </option>
                  ))}
                </select>
              </label>
            )}
            {properties.length > 1 && !picking && (
              <label className="market-sort watchlist-sort">
                Sort
                <select value={sortKey} onChange={(event) => chooseSort(event.target.value)}>
                  {WATCHLIST_SORTS.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {properties.length > 1 && (
              <button
                type="button"
                className="secondary-button"
                aria-pressed={picking}
                onClick={() => (picking ? stopPicking() : setPicking(true))}
              >
                {picking ? "Cancel" : "Compare"}
              </button>
            )}
          </div>
        </div>

        {actionError && (
          <p className="form-error" role="alert">
            {actionError}
          </p>
        )}

        {stageFilter !== "all" && !shownProperties.length && (
          <p className="empty-state">
            No homes at "{STAGES.find((s) => s.key === stageFilter)?.label}" right now.{" "}
            <button type="button" className="link-button" onClick={() => chooseFilter("all")}>
              Show all
            </button>
          </p>
        )}

        <div className="tile-grid">
          {shownProperties.map((property) => (
            <WatchlistTile
              key={property.id}
              property={property}
              note={<ChecklistChip items={mustHaves} checklist={checklists[property.id]} />}
              picking={picking}
              picked={pickedIds.includes(property.id)}
              pickDisabled={pickedIds.length >= MAX_COMPARE}
              onOpen={() => {
                setActionMessage("");
                setSelectedProperty(property);
                window.scrollTo(0, 0);
              }}
              onPick={() => togglePick(property.id)}
              onStage={(key) => chooseStage(property, key)}
            />
          ))}
        </div>
      </section>

      {picking && (
        <div className="compare-bar" role="status">
          <span>
            {pickedIds.length} of {MAX_COMPARE} picked
          </span>
          <button
            type="button"
            className="primary-button"
            disabled={pickedIds.length < 2}
            onClick={() => {
              setComparing(true);
              window.scrollTo(0, 0);
            }}
          >
            Compare
          </button>
        </div>
      )}
      {undoBar}
    </>
  );
}

export default HistoryView;
