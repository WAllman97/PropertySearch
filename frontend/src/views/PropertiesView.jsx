import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import PropertyScoreEditor from "../components/PropertyScoreEditor";
import CommuteSummary from "../components/CommuteSummary";
import MarketSignals from "../components/MarketSignals";
import ViewingSlots, { useAvailableViewings } from "../components/ViewingSlots";
import MarketToolbar from "../components/MarketToolbar";
import SaveLinkForm from "../components/SaveLinkForm";
import { onSharedLink, takeSharedLink } from "../lib/sharedLinks";
import GettingStarted from "../components/GettingStarted";
import PropertyTile from "../components/PropertyTile";
import LoadError from "../components/LoadError";
import { friendlyError } from "../lib/errors";
import { applyMarketView } from "../utils/market";

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

function PropertiesView({ onOpenSettings, onOpenWatchlist }) {
  const { byProperty: viewingsByProperty, requestsByProperty, reload: reloadViewings } = useAvailableViewings();
  const [properties, setProperties] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [showAddModal, setShowAddModal] = useState(false);
  // A link shared to the app (Share → PropertySearch, or /?add=) to fill in.
  const [addLink, setAddLink] = useState(null);

  useEffect(() => {
    const open = (link) => {
      takeSharedLink();
      setAddLink(link);
      setShowAddModal(true);
    };
    const waiting = takeSharedLink();
    if (waiting) open(waiting);
    return onSharedLink(open);
  }, []);
  const [selectedProperty, setSelectedProperty] = useState(null);
  const [showScoreModal, setShowScoreModal] = useState(false);
  const [marketFilter, setMarketFilter] = useState("all");
  const [marketSort, setMarketSort] = useState("newest");
  // The one tile flipped open to show its details.
  const [openId, setOpenId] = useState(null);
  // "Added to Watchlist" note with Undo after a one-tap favourite.
  const [favNote, setFavNote] = useState(null);
  // A save or undo that failed, shown above the homes (not a pop-up).
  const [actionError, setActionError] = useState("");
  // "Saved to your Watchlist" after adding a home by its link, and a count
  // of saves so the getting-started checklist re-checks itself.
  const [savedNote, setSavedNote] = useState(null);
  const [saves, setSaves] = useState(0);

  const [shareProperty, setShareProperty] = useState(null);
  const [shareEmail, setShareEmail] = useState(
    () => localStorage.getItem("shareRecipient") || ""
  );
  const [shareMessage, setShareMessage] = useState("");
  const [sharing, setSharing] = useState(false);
  const [shareStatus, setShareStatus] = useState("");

  useEffect(() => {
    loadProperties();
  }, []);

  // quiet: refresh in place after an action, without the full-page
  // "Loading..." that would wipe the list and jump the scroll position.
  async function loadProperties({ quiet = false } = {}) {
    if (!quiet) setLoading(true);

    const { data, error } = await supabase
      .from("properties")
      .select("*")
      .or("status.eq.new,status.is.null")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Error loading properties:", error);
      // A failed background refresh keeps the list already on screen.
      if (!quiet) setLoadError(error);
    } else {
      setLoadError(null);
      setProperties(data || []);
    }

    setLoading(false);
  }

  function updateLocalProperty(updatedProperty) {
    setProperties((current) =>
      current.map((property) =>
        property.id === updatedProperty.id ? updatedProperty : property
      )
    );
  }

  async function updateStatus(listingId, status) {
    setActionError("");
    const { data, error } = await supabase
      .from("properties")
      .update({ status })
      .eq("listing_id", listingId)
      .select();

    if (error) {
      console.error("Error updating property:", error);
      setActionError(friendlyError(error));
      return;
    }

    if (!data || data.length === 0) {
      setActionError("That home couldn't be updated. Please refresh and try again.");
      return;
    }

    const updatedProperty = data[0];

    if (status === "favourite") {
      setSelectedProperty(updatedProperty);
      setShowScoreModal(true);
    }

    setProperties((current) =>
      current.filter((property) => property.listing_id !== listingId)
    );
  }

  // One tap on a tile's star: straight to the Watchlist, no scoring pop-up
  // (score it later from the Watchlist). Undo puts it back.
  async function quickFavourite(property) {
    setActionError("");
    const { error } = await supabase
      .from("properties")
      .update({ status: "favourite" })
      .eq("id", property.id);
    if (error) {
      setActionError(friendlyError(error));
      return;
    }
    setProperties((current) => current.filter((p) => p.id !== property.id));
    setFavNote(property);
  }

  async function undoFavourite() {
    const property = favNote;
    setFavNote(null);
    if (!property) return;
    const { error } = await supabase
      .from("properties")
      .update({ status: property.status || "new" })
      .eq("id", property.id);
    if (error) {
      setActionError(friendlyError(error));
      return;
    }
    await loadProperties({ quiet: true });
  }

  // The note fades after a few seconds.
  useEffect(() => {
    if (!favNote) return undefined;
    const timer = setTimeout(() => setFavNote(null), 6000);
    return () => clearTimeout(timer);
  }, [favNote]);

  useEffect(() => {
    if (!savedNote) return undefined;
    const timer = setTimeout(() => setSavedNote(null), 8000);
    return () => clearTimeout(timer);
  }, [savedNote]);

  function openShareModal(property) {
    setShareProperty(property);
    setShareMessage("");
    setShareStatus("");
  }

  function closeShareModal() {
    setShareProperty(null);
    setShareMessage("");
    setShareStatus("");
    setSharing(false);
  }

  async function sendShare(event) {
    event.preventDefault();

    const toEmail = shareEmail.trim();

    if (!toEmail) {
      setShareStatus("Enter a recipient email.");
      return;
    }

    setSharing(true);
    setShareStatus("Sending…");

    try {
      const response = await postAuthed("/api/share-property", {
        propertyId: shareProperty.id,
        toEmail,
        message: shareMessage.trim(),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(result.error || `Failed (status ${response.status})`);
      }

      // Remember the recipient for next time.
      localStorage.setItem("shareRecipient", toEmail);

      setShareStatus(`Sent to ${toEmail}.`);
      setTimeout(closeShareModal, 1200);
    } catch (error) {
      console.error("Share failed:", error);
      setShareStatus(error.message || "Could not send.");
    } finally {
      setSharing(false);
    }
  }

  if (loading) {
    return (
      <section className="card">
        <p>Loading properties...</p>
      </section>
    );
  }

  if (loadError) return <LoadError error={loadError} onRetry={() => loadProperties()} />;

  return (
    <>
    <GettingStarted
      refreshKey={`${properties.length}:${saves}`}
      onAddHome={() => setShowAddModal(true)}
      onOpenSettings={onOpenSettings}
    />
    <section className="card">
      <div className="section-header properties-head">
        <div>
          <h2>Latest Property Matches</h2>
          <p>{properties.length} active properties found</p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={() => setShowAddModal(true)}
        >
          + Add Property
        </button>
      </div>

      {showAddModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Add Property</h3>
                <p>
                  Paste a property link. We fill in the details for you to check.
                </p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowAddModal(false);
                  setAddLink(null);
                }}
              >
                Close
              </button>
            </div>

            <SaveLinkForm
              key={addLink || "blank"}
              initialUrl={addLink}
              onSaved={async (saved) => {
                setShowAddModal(false);
                setAddLink(null);
                // Saved homes go to the Watchlist, not this list: say so,
                // with a way to go and see it.
                setSavedNote(saved || {});
                setSaves((n) => n + 1);
                await loadProperties({ quiet: true });
              }}
            />
          </div>
        </div>
      )}

      {showScoreModal && selectedProperty && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Initial Property Score</h3>
                <p>{selectedProperty.address}</p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  setShowScoreModal(false);
                  setSelectedProperty(null);
                }}
              >
                Close
              </button>
            </div>

            <PropertyScoreEditor
              property={selectedProperty}
              onUpdate={async () => {
                setShowScoreModal(false);
                setSelectedProperty(null);
                await loadProperties({ quiet: true });
              }}
            />
          </div>
        </div>
      )}

      {shareProperty && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <div className="section-header">
              <div>
                <h3>Share property</h3>
                <p>{shareProperty.address}</p>
              </div>

              <button
                type="button"
                className="secondary-button"
                onClick={closeShareModal}
              >
                Close
              </button>
            </div>

            <form className="manual-property-form" onSubmit={sendShare}>
              <label>
                Send to
                <input
                  type="email"
                  value={shareEmail}
                  onChange={(event) => setShareEmail(event.target.value)}
                  placeholder="name@example.com"
                  required
                />
              </label>

              <label>
                Message (optional)
                <textarea
                  value={shareMessage}
                  onChange={(event) => setShareMessage(event.target.value)}
                  placeholder="Thought you'd like this one…"
                  rows={3}
                />
              </label>

              <button type="submit" className="primary-button" disabled={sharing}>
                {sharing ? "Sending…" : "Send email"}
              </button>

              {shareStatus && <p className="form-message">{shareStatus}</p>}
            </form>
          </div>
        </div>
      )}

      {properties.length > 0 && (
        <MarketToolbar
          properties={properties}
          filter={marketFilter}
          sort={marketSort}
          onFilter={setMarketFilter}
          onSort={setMarketSort}
        />
      )}

      {properties.length === 0 && (
        <div className="empty-state">
          <h3>No homes here yet</h3>
          <p>
            Paste a link to a home you like from Rightmove, Zoopla or OnTheMarket, and we'll fill
            in the details for you to check. Homes that agents send you appear here too, and when an
            agent on PropertySearch cuts the price of a home you saved, you're told straight away.
          </p>
          <button type="button" className="primary-button" onClick={() => setShowAddModal(true)}>
            + Add your first home
          </button>
        </div>
      )}

      {actionError && (
        <p className="form-error" role="alert">
          {actionError}
        </p>
      )}

      <div className="tile-grid">
        {applyMarketView(properties, marketFilter, marketSort).map((property) => {
          const propertyAgeDays = getPropertyAgeDays(property);

          return (
            <PropertyTile
              key={property.id}
              property={property}
              open={openId === property.id}
              onToggle={() => setOpenId((current) => (current === property.id ? null : property.id))}
              onFavourite={() => quickFavourite(property)}
            >
              <div className="property-content">
                <MarketSignals property={property} />
                <ViewingSlots
                  property={property}
                  slots={viewingsByProperty[property.id]}
                  request={requestsByProperty[property.id]}
                  onChanged={() => {
                    reloadViewings();
                    // A booked home leaves "new", so refresh the list too.
                    loadProperties({ quiet: true });
                  }}
                />

                <div className="property-score-strip">
                  <span>
                    🏠{" "}
                    {property.overall_score
                      ? `${property.overall_score}/100`
                      : "Not scored"}
                    {property.scores_source === "ai" && " (AI)"}
                  </span>

                  <span>❤️ {property.score_gut_feel || 0}/10</span>

                  {property.offer_interest && (
                    <span>Offer: {property.offer_interest}</span>
                  )}
                </div>

                <CommuteSummary
                  property={property}
                  onCommuteSaved={updateLocalProperty}
                />

                <div className="property-meta">
                  <span>{property.source}</span>

                  {property.bedrooms != null && <span>{property.bedrooms === 0 ? "Studio" : `${property.bedrooms} bed${property.bedrooms === 1 ? "" : "s"}`}</span>}

                  {propertyAgeDays !== null && (
                    <span className={getAgeClass(propertyAgeDays)}>
                      Added{" "}
                      {propertyAgeDays === 0
                        ? "today"
                        : `${propertyAgeDays} ${propertyAgeDays === 1 ? "day" : "days"} ago`}
                    </span>
                  )}

                  {property.status && <span>{property.status}</span>}
                </div>

                <a href={property.listing_url} target="_blank" rel="noreferrer">
                  View Listing
                </a>

                <div className="property-actions">
                  <button
                    onClick={() =>
                      updateStatus(property.listing_id, "favourite")
                    }
                  >
                    Favourite
                  </button>

                  <button
                    onClick={() => updateStatus(property.listing_id, "ignored")}
                  >
                    Ignore
                  </button>

                  <button onClick={() => openShareModal(property)}>
                    Share
                  </button>
                </div>
              </div>
            </PropertyTile>
          );
        })}
      </div>
    </section>

    {favNote && (
      <div className="toast" role="status">
        <span>⭐ Added to your Watchlist</span>
        <button type="button" className="link-button" onClick={undoFavourite}>
          Undo
        </button>
      </div>
    )}

    {savedNote && !favNote && (
      <div className="toast" role="status">
        <span>✅ Saved{savedNote.address ? `: ${savedNote.address}` : ""}. It's in your Watchlist.</span>
        {onOpenWatchlist && (
          <button type="button" className="link-button" onClick={onOpenWatchlist}>
            View
          </button>
        )}
      </div>
    )}
    </>
  );
}

export default PropertiesView;