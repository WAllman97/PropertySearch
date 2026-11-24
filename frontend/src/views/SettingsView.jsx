import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import BookingSettings from "../components/BookingSettings";
import BuyerPositionSettings from "../components/BuyerPositionSettings";
import { DeleteBuyerAccount, HouseholdMembers } from "../components/HouseholdSettings";
import BuyerSearches from "../components/BuyerSearches";
import BuyerProfileSettings from "../components/BuyerProfileSettings";
import PushSettings from "../components/PushSettings";
import { isNativeApp } from "../lib/platform";
import EmailPreferences from "../components/EmailPreferences";
import SearchStatus, { statusSummary } from "../components/SearchStatus";
import AgentControls from "../components/AgentControls";
import { MustHaveSettings } from "../components/MustHaves";

const PHONE = "(max-width: 760px)";
const isPhone = () => typeof window !== "undefined" && window.matchMedia?.(PHONE).matches;

// One Settings card. On a phone each starts closed (title and one line), so
// the page isn't six screens long; tap to open. On a computer they're open.
// Contents stay mounted while closed, so half-typed forms aren't lost.
function SettingsSection({ id, title, summary, open, onToggle, children }) {
  return (
    <section className={`card settings-section${open ? " open" : ""}`} id={id ? `settings-${id}` : undefined}>
      <button type="button" className="settings-section-head" onClick={onToggle} aria-expanded={open}>
        <span>
          <h2>{title}</h2>
          {summary && <p>{summary}</p>}
        </span>
        <span className="settings-chevron" aria-hidden="true">
          ›
        </span>
      </button>
      <div className="settings-section-body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

function SettingsView({ user, focusSection, onFocused, onLogOut, isAgent = false }) {
  const [household, setHousehold] = useState(null);
  // Which sections are open: all on a computer, none on a phone.
  const [openSections, setOpenSections] = useState(() => (isPhone() ? {} : null));

  const isOpen = (key) => openSections === null || Boolean(openSections[key]);
  const toggle = (key) =>
    setOpenSections((current) => (current === null ? current : { ...current, [key]: !current[key] }));

  const loadHousehold = useCallback(async () => {
    const { data, error } = await supabase.rpc("my_household");
    if (error) console.error("Could not load household:", error);
    else setHousehold(data);
  }, []);

  useEffect(() => {
    if (user) loadHousehold();
  }, [user, loadHousehold]);

  // Arrived from a "Getting started" step or the Dashboard: open that card
  // and scroll to it. Waits for the household card, which only renders once
  // loaded.
  useEffect(() => {
    if (!focusSection || (focusSection === "household" && !household)) return undefined;
    setOpenSections((current) => (current === null ? current : { ...current, [focusSection]: true }));
    const timer = setTimeout(() => {
      const card = document.getElementById(`settings-${focusSection}`);
      if (card) {
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        card.classList.add("settings-focus");
        setTimeout(() => card.classList.remove("settings-focus"), 2000);
      }
      onFocused?.();
    }, 250);
    return () => clearTimeout(timer);
  }, [focusSection, household, onFocused]);

  if (!user) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Settings</h2>
          <p>Please log in to manage your saved searches.</p>
        </div>
      </section>
    );
  }

  const section = (key, title, summary, children) => (
    <SettingsSection
      key={key}
      id={key}
      title={title}
      summary={summary}
      open={isOpen(key)}
      onToggle={() => toggle(key)}
    >
      {children}
    </SettingsSection>
  );

  return (
    <>
      {household &&
        section(
          "status",
          "Where you are",
          statusSummary(household.search_status || "searching", household.paused_until),
          <SearchStatus household={household} onChange={loadHousehold} />
        )}

      {section(
        "searches",
        "What you're looking for",
        "Agents' new listings that fit one of these searches are sent straight to you.",
        <BuyerSearches user={user} />
      )}

      {section(
        "musthaves",
        "Your must-haves",
        "Your dealbreakers. Tick them off at each viewing to see which homes fall short.",
        <MustHaveSettings />
      )}

      {section(
        "position",
        "Your Buying Position",
        "Agents prioritise buyers who can move quickly. Shared with the agents you book viewings or make offers with.",
        <BuyerPositionSettings />
      )}

      {household &&
        section(
          "household",
          "Household",
          "Everyone here shares one property list, calendar and notes.",
          <HouseholdMembers household={household} onChange={loadHousehold} />
        )}

      {isNativeApp && section("notifications", "Phone Notifications", null, <PushSettings />)}

      {household &&
        section(
          "agents",
          "Agents",
          "Which agents can see your buying position and status, and send you homes.",
          <AgentControls householdId={household.id} />
        )}

      {section("emails", "Emails", "Choose which emails you get. Everything is still in the app.", <EmailPreferences user={user} />)}

      {section(
        "booking",
        "Agent Booking Page",
        "Give agents this link instead of your number. They pick a free slot for a call or viewing, you accept it, and it lands in your calendar.",
        <BookingSettings user={user} />
      )}

      {section(
        "commute",
        "Buyer Profile & Commute",
        "Add commute locations, choose your preferred travel method, and refresh commute times.",
        <BuyerProfileSettings user={user} />
      )}

      {/* Only for accounts that are also estate agents: most buyers never
          need it, so it lives here rather than on every page. */}
      {isAgent && (
        <section className="card settings-switch">
          <div className="section-header">
            <div>
              <h2>Agent area</h2>
              <p>Your listings, viewing times and bookings as an agent.</p>
            </div>
            <a className="secondary-button" href="/agent">
              Switch to agent area →
            </a>
          </div>
        </section>
      )}

      {household &&
        section("delete", "Delete Account", null, <DeleteBuyerAccount household={household} />)}

      {onLogOut && (
        <section className="card settings-logout">
          <div className="section-header">
            <h2>Log out</h2>
            <p>{user.email}</p>
          </div>
          <button type="button" className="secondary-button" onClick={onLogOut}>
            Log out of this device
          </button>
        </section>
      )}
    </>
  );
}

export default SettingsView;
