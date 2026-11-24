import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { fromLocalInputValue, toLocalInputValue } from "../utils/datetime";
import PropertyScoreEditor from "../components/PropertyScoreEditor";
import CommuteSummary from "../components/CommuteSummary";
import MarketSignals from "../components/MarketSignals";
import ViewingSlots, { useAvailableViewings } from "../components/ViewingSlots";
import { OfferAcceptedButton, OfferStatus } from "../components/OfferStatus";
import PropertyTile from "../components/PropertyTile";
import { daysOnMarket, priceDrop } from "../utils/market";
import LoadError from "../components/LoadError";
import { friendlyError } from "../lib/errors";
import { ChecklistChip, ViewingChecklist, useMustHaves } from "../components/MustHaves";

const emptyNotes = {
  viewing_datetime: "",
  estate_agent: "",
  estate_agent_email: "",
  estate_agent_phone: "",
  positives: "",
  negatives: "",
  questions: "",
  general_notes: "",
};

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

const viewingWhen = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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
  return days === 0 ? "Added today" : `Added ${days} days ago`;
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
  const [savingNotes, setSavingNotes] = useState(false);
  const [notesMessage, setNotesMessage] = useState("");
  const [editingViewing, setEditingViewing] = useState(false);
  const { items: mustHaves } = useMustHaves();
  // Each home's must-have ticks, for the tiles.
  const [checklists, setChecklists] = useState({});
  // Live accepted offers by property id (withdrawn ones are hidden).
  const [offers, setOffers] = useState({});
  // The one tile flipped open to show its details.
  const [openId, setOpenId] = useState(null);

  useEffect(() => {
    loadWatchlist();
  }, []);

  useEffect(() => {
    if (selectedProperty) {
      loadNotes(selectedProperty.id);
    }
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

  async function loadWatchlist() {
    setLoading(true);

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

    await loadWatchlist();
  }

  async function loadNotes(propertyId) {
    setNotesMessage("");
    setEditingViewing(false);

    const { data, error } = await supabase
      .from("property_notes")
      .select("*")
      .eq("property_id", propertyId)
      .maybeSingle();

    if (error) {
      console.error("Error loading notes:", error);
      setNotes(emptyNotes);
      return;
    }

    setNotes({
      viewing_datetime: toLocalInputValue(data?.viewing_datetime),
      estate_agent: data?.estate_agent || "",
      estate_agent_email: data?.estate_agent_email || "",
      estate_agent_phone: data?.estate_agent_phone || "",
      positives: data?.positives || "",
      negatives: data?.negatives || "",
      questions: data?.questions || "",
      general_notes: data?.general_notes || "",
    });
  }

  async function saveNotes() {
    if (!selectedProperty) return;

    setSavingNotes(true);
    setNotesMessage("");

    // The viewing details only when changed by hand here, so a booking
    // made since this page opened isn't written over.
    const viewingFields = editingViewing
      ? {
          viewing_datetime: fromLocalInputValue(notes.viewing_datetime),
          estate_agent: notes.estate_agent,
          estate_agent_email: notes.estate_agent_email,
          estate_agent_phone: notes.estate_agent_phone,
        }
      : {};
    const { error } = await supabase.from("property_notes").upsert(
      {
        property_id: selectedProperty.id,
        positives: notes.positives,
        negatives: notes.negatives,
        questions: notes.questions,
        general_notes: notes.general_notes,
        ...viewingFields,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "property_id",
      }
    );

    setSavingNotes(false);

    if (error) {
      console.error("Error saving notes:", error);
      setNotesMessage(error.message);
      return;
    }

    // A date added by hand moves an early-stage home on to "Viewing booked".
    if (viewingFields.viewing_datetime && ["new", "favourite"].includes(selectedProperty.status)) {
      await updateStatus(selectedProperty.id, "viewing_booked");
    }
    setEditingViewing(false);
    setNotesMessage("Notes saved.");
  }

  async function updateStatus(propertyId, status) {
    const { error } = await supabase
      .from("properties")
      .update({ status })
      .eq("id", propertyId);

    if (error) {
      console.error("Error updating property:", error);
      alert(friendlyError(error));
      return;
    }

    if (selectedProperty?.id === propertyId) {
      setSelectedProperty((current) =>
        current ? { ...current, status } : current
      );
    }

    await loadWatchlist();
  }

  function handleNotesChange(event) {
    const { name, value } = event.target;
    setNotes((current) => ({ ...current, [name]: value }));
  }

  function getStatusLabel(status) {
    const labels = {
      favourite: "⭐ Favourite",
      viewing_booked: "📅 Viewing Booked",
      viewed: "👀 Viewed",
      offer_considered: "💷 Offer Considered",
      offer_made: "🤝 Offer Made",
      offer_accepted: "✅ Offer Accepted",
    };

    return labels[status] || status;
  }

  const sortedProperties = useMemo(() => {
    const sort = WATCHLIST_SORTS.find((item) => item.key === sortKey) || WATCHLIST_SORTS[0];
    return [...properties].sort(sort.compare);
  }, [properties, sortKey]);

  if (selectedProperty) {
    const selectedAgeDays = getPropertyAgeDays(selectedProperty);

    return (
      <section className="card">
        <button
          type="button"
          className="secondary-button"
          onClick={() => setSelectedProperty(null)}
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
            <h2>
              {selectedProperty.price
                ? `£${Number(selectedProperty.price).toLocaleString()}`
                : "Price unavailable"}
            </h2>

            <p>{selectedProperty.address}</p>

            <MarketSignals property={selectedProperty} defaultOpen />
            <ViewingSlots
              property={selectedProperty}
              slots={viewingsByProperty[selectedProperty.id]}
              request={requestsByProperty[selectedProperty.id]}
              onChanged={reloadViewings}
            />

            <div className="property-score-strip">
              <span>🏠 {selectedProperty.overall_score || "--"}/100</span>
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
              <span>{selectedProperty.source}</span>

              {selectedProperty.bedrooms && (
                <span>{selectedProperty.bedrooms} beds</span>
              )}

              {selectedAgeDays !== null && (
                <span className={getAgeClass(selectedAgeDays)}>
                  {getAgeLabel(selectedAgeDays)}
                </span>
              )}

              <span className={`status-badge status-${selectedProperty.status}`}>
                {getStatusLabel(selectedProperty.status)}
              </span>
            </div>

            <a
              href={selectedProperty.listing_url}
              target="_blank"
              rel="noreferrer"
            >
              View original listing
            </a>
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
                <button type="button" className="primary-button" onClick={saveNotes} disabled={savingNotes}>
                  {savingNotes ? "Saving..." : "Save viewing"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditingViewing(false);
                    loadNotes(selectedProperty.id);
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="details-section">
          <ViewingChecklist propertyId={selectedProperty.id} onOpenSettings={onOpenSettings} />
        </div>

        <div className="details-section">
          <PropertyScoreEditor
            property={selectedProperty}
            onUpdate={async () => {
              await refreshSelectedProperty(selectedProperty.id);
            }}
          />
        </div>

        <div className="details-section">
          <h3>Pros, cons and questions</h3>

          <label>
            Positives
            <textarea
              name="positives"
              value={notes.positives}
              onChange={handleNotesChange}
            />
          </label>

          <label>
            Negatives
            <textarea
              name="negatives"
              value={notes.negatives}
              onChange={handleNotesChange}
            />
          </label>

          <label>
            Questions to ask
            <textarea
              name="questions"
              value={notes.questions}
              onChange={handleNotesChange}
            />
          </label>

          <label>
            General notes
            <textarea
              name="general_notes"
              value={notes.general_notes}
              onChange={handleNotesChange}
            />
          </label>

          <button
            type="button"
            className="primary-button"
            onClick={saveNotes}
            disabled={savingNotes}
          >
            {savingNotes ? "Saving..." : "Save notes"}
          </button>

          {notesMessage && <p className="form-message">{notesMessage}</p>}
        </div>
      </section>
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

  return (
    <section className="card">
      <div className="section-header watchlist-head">
        <div>
          <h2>Watchlist</h2>
          <p>{properties.length} tracked properties</p>
        </div>
        {properties.length > 1 && (
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
      </div>

      <div className="tile-grid">
        {sortedProperties.map((property) => {
          const propertyAgeDays = getPropertyAgeDays(property);

          return (
            <PropertyTile
              key={property.id}
              property={property}
              open={openId === property.id}
              onToggle={() => setOpenId((current) => (current === property.id ? null : property.id))}
              tag={getStatusLabel(property.status)}
            >
              <div className="property-content">
                <MarketSignals property={property} />
                <OfferStatus offer={offers[property.id]} onChanged={loadWatchlist} />
                <ViewingSlots
                  property={property}
                  slots={viewingsByProperty[property.id]}
                  request={requestsByProperty[property.id]}
                  onChanged={reloadViewings}
                />

                <div className="property-score-strip">
                  <span>🏠 {property.overall_score || "--"}/100</span>
                  <span>❤️ {property.score_gut_feel || 0}/10</span>

                  {property.offer_interest && (
                    <span>Offer: {property.offer_interest}</span>
                  )}
                  <ChecklistChip items={mustHaves} checklist={checklists[property.id]} />
                </div>

                <CommuteSummary
                  property={property}
                  onCommuteSaved={updateLocalProperty}
                />

                <div className="property-meta">
                  <span>{property.source}</span>

                  {property.bedrooms && <span>{property.bedrooms} beds</span>}

                  {propertyAgeDays !== null && (
                    <span className={getAgeClass(propertyAgeDays)}>
                      {getAgeLabel(propertyAgeDays)}
                    </span>
                  )}

                  <span className={`status-badge status-${property.status}`}>
                    {getStatusLabel(property.status)}
                  </span>
                </div>

                <a href={property.listing_url} target="_blank" rel="noreferrer">
                  View Listing
                </a>

                <div className="property-actions">
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => setSelectedProperty(property)}
                  >
                    Notes &amp; scoring
                  </button>

                  <button
                    disabled={property.status === "viewing_booked"}
                    onClick={() => updateStatus(property.id, "viewing_booked")}
                  >
                    Viewing booked
                  </button>

                  <button
                    disabled={property.status === "viewed"}
                    onClick={() => {
                      updateStatus(property.id, "viewed");
                      setSelectedProperty({ ...property, status: "viewed" });
                    }}
                  >
                    Viewed
                  </button>

                  <button
                    disabled={property.status === "offer_considered"}
                    onClick={() =>
                      updateStatus(property.id, "offer_considered")
                    }
                  >
                    Offer considered
                  </button>

                  <button
                    disabled={property.status === "offer_made"}
                    onClick={() => updateStatus(property.id, "offer_made")}
                  >
                    Offer made
                  </button>

                  {!offers[property.id] && (
                    <OfferAcceptedButton property={property} onChanged={loadWatchlist} />
                  )}

                  <button onClick={() => updateStatus(property.id, "archived")}>
                    Archive
                  </button>
                </div>
              </div>
            </PropertyTile>
          );
        })}
      </div>
    </section>
  );
}

export default HistoryView;