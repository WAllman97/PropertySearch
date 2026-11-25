import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { ConfirmEmailPage } from "./components/ConfirmEmail";
import { onSharedLink } from "./lib/sharedLinks";
import ViewingRequestPage from "./views/ViewingRequestPage";
import OfferConfirmPage from "./views/OfferConfirmPage";
import SellerReportPage from "./views/SellerReportPage";
import SuggestedTimePage from "./views/SuggestedTimePage";
import { arrivedFromPasswordReset, supabase } from "./lib/supabaseClient";
import AuthForm, { SEEN_ACCOUNT_KEY } from "./components/AuthForm";
import SetNewPasswordForm from "./components/SetNewPasswordForm";
import JoinHousehold from "./components/JoinHousehold";
import ResetPasswordPage from "./views/ResetPasswordPage";
import UnsubscribePage from "./views/UnsubscribePage";

import DashboardView from "./views/DashboardView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";
import PropertiesView from "./views/PropertiesView";
import NavigationTabs from "./components/NavigationTabs";
import CalendarView from "./views/CalendarView";
import BookingPage from "./views/BookingPage";
import AgentPortal from "./views/AgentPortal";
import PublicViewingPage from "./views/PublicViewingPage";
import PrivacyPage from "./views/PrivacyPage";
import SupportPage from "./views/SupportPage";
import AgentsPage from "./views/AgentsPage";
// Loaded only when someone opens /admin, not shipped to every visitor.
const AdminPage = lazy(() => import("./views/AdminPage"));
import {
  dismissPushOffer,
  enablePush,
  forgetThisPhone,
  refreshPushRegistration,
  shouldOfferPush,
} from "./lib/push";
import "./App.css";

const VIEWS = ["properties", "history", "calendar", "dashboard", "settings"];

// Public agent booking page: /book/<slug>. Rendered without login.
function getBookingSlug() {
  const match = window.location.pathname.match(/^\/book\/([a-z0-9-]+)\/?$/);
  return match ? match[1] : null;
}

// Partner invite links: /join/<code> (Settings → Household).
function getInviteCode() {
  const match = window.location.pathname.match(/^\/join\/([0-9a-f]{24})\/?$/i);
  return match ? match[1].toLowerCase() : null;
}

// Email links can open a tab directly, e.g. /?view=calendar. The param is
// then removed from the address, otherwise opening the same link again later
// looks like "already here" and does nothing. Read once and remembered, so a
// second call (React may run this twice) still gets the right tab.
let launchView;
function getInitialView() {
  if (launchView === undefined) {
    const params = new URLSearchParams(window.location.search);
    const view = params.get("view");
    launchView = VIEWS.includes(view) ? view : "properties";
    if (params.has("view")) {
      params.delete("view");
      const rest = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`
      );
    }
  }
  return launchView;
}

function App() {
  const bookingSlug = getBookingSlug();

  if (bookingSlug) {
    return <BookingPage slug={bookingSlug} />;
  }

  // Public page an agent shares with buyers to book a listing's viewings.
  const viewingsMatch = window.location.pathname.match(/^\/viewings\/([0-9a-f-]{36})\/?$/i);
  if (viewingsMatch) {
    return <PublicViewingPage listingId={viewingsMatch[1]} />;
  }

  // An agent who isn't on PropertySearch answering a buyer's viewing request.
  const requestMatch = window.location.pathname.match(/^\/request\/([0-9a-f-]{36})\/?$/i);
  if (requestMatch) {
    return <ViewingRequestPage token={requestMatch[1]} />;
  }

  // An agent confirming a buyer's accepted offer from the email (no login).
  const offerMatch = window.location.pathname.match(/^\/offer\/([0-9a-f-]{36})\/?$/i);
  if (offerMatch) {
    return <OfferConfirmPage token={offerMatch[1]} />;
  }

  // The seller report an agent shares with the vendor (no login).
  const reportMatch = window.location.pathname.match(/^\/report\/([0-9a-f-]{36})\/?$/i);
  if (reportMatch) {
    return <SellerReportPage token={reportMatch[1]} />;
  }

  // A buyer answering a time the agent suggested, from the email (no login).
  const suggestedMatch = window.location.pathname.match(/^\/suggested\/([0-9a-f-]{36})\/?$/i);
  if (suggestedMatch) {
    return <SuggestedTimePage token={suggestedMatch[1]} />;
  }

  // The link in a password-reset email (straight to our site, so it opens
  // the iPhone app): /reset/buyer or /reset/agent.
  const resetMatch = window.location.pathname.match(/^\/reset\/(buyer|agent)\/?$/);
  if (resetMatch) {
    return <ResetPasswordPage who={resetMatch[1]} />;
  }
  // Sent from the Supabase dashboard ("Send password recovery"): the Site URL
  // with the code on the end.
  const query = new URLSearchParams(window.location.search);
  if (query.get("type") === "recovery" && query.get("token_hash")) {
    return <ResetPasswordPage who="buyer" />;
  }

  // The link in the "confirm your email" message sent at sign-up.
  if (/^\/confirm\/?$/.test(window.location.pathname)) {
    return <ConfirmEmailPage />;
  }

  // The unsubscribe link in "new match" and price-cut emails.
  if (/^\/unsubscribe\/?$/.test(window.location.pathname)) {
    return <UnsubscribePage />;
  }

  if (/^\/privacy\/?$/.test(window.location.pathname)) {
    return <PrivacyPage />;
  }
  if (/^\/support\/?$/.test(window.location.pathname)) {
    return <SupportPage />;
  }
  if (/^\/admin\/?$/.test(window.location.pathname)) {
    return (
      <Suspense fallback={null}>
        <AdminPage />
      </Suspense>
    );
  }

  // Public page for estate agents explaining the product.
  if (/^\/agents\/?$/.test(window.location.pathname)) {
    return <AgentsPage />;
  }

  // Estate agent area: own sign-up/login, listings and viewing times.
  if (/^\/agent\/?$/.test(window.location.pathname)) {
    return <AgentPortal />;
  }

  return <MainApp />;
}

function MainApp() {
  const [activeView, setActiveView] = useState(getInitialView);
  const [user, setUser] = useState(null);
  const [settingPassword, setSettingPassword] = useState(arrivedFromPasswordReset);
  const [passwordChanged, setPasswordChanged] = useState(false);
  const [isAgent, setIsAgent] = useState(false);
  const [invite] = useState(getInviteCode);
  // Signed in already and opened a partner's invite: offer to join.
  const [showJoin, setShowJoin] = useState(() => Boolean(getInviteCode()));
  // Settings card to scroll to when another view links there.
  const [settingsFocus, setSettingsFocus] = useState(null);
  // A home to open on the Watchlist (from a calendar viewing or the Dashboard).
  const [focusProperty, setFocusProperty] = useState(null);
  const clearFocusProperty = useCallback(() => setFocusProperty(null), []);
  const openNotes = useCallback((propertyId) => {
    setFocusProperty(propertyId);
    setActiveView("history");
  }, []);
  const openSettings = useCallback((section) => {
    setSettingsFocus(section);
    setActiveView("settings");
  }, []);

  // A property link shared to the app opens Add Property on the Properties tab.
  useEffect(() => onSharedLink(() => setActiveView("properties")), []);

  useEffect(() => {
    async function getSession() {
      const {
        data: { session },
      } = await supabase.auth.getSession();

      setUser(session?.user ?? null);
    }

    getSession();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY") setSettingPassword(true);
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Agents who log in on the main page belong in the agent area: they can't
  // see household data, so the tabs would just be empty.
  useEffect(() => {
    if (!user) return;
    // Someone has an account on this device: open on Log In next time.
    try {
      localStorage.setItem(SEEN_ACCOUNT_KEY, "1");
    } catch {
      // Private mode: they just see Create account first.
    }
    (async () => {
      const [{ data: isMember }, { data: agent }] = await Promise.all([
        supabase.rpc("is_household_member"),
        supabase.from("agents").select("user_id").eq("user_id", user.id).maybeSingle(),
      ]);
      if (agent && isMember === false) window.location.replace("/agent");
      // Buyer who is also an agent: offer a way across to the agent area.
      setIsAgent(Boolean(agent));
    })();
  }, [user]);

  // iPhone app: keep this phone's notification token current, and offer
  // notifications once. Both do nothing on the website.
  const [offerPush, setOfferPush] = useState(false);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    refreshPushRegistration();
    // New buyers are asked right after saving their first search, when the
    // reason is obvious (BuyerSearches). Only buyers who already have a
    // search, and so won't see that, are asked here.
    supabase
      .from("buyer_searches")
      .select("id", { count: "exact", head: true })
      .then(({ count }) => (count ? shouldOfferPush() : false))
      .then(setOfferPush)
      .catch(() => {});
  }, [userId]);

  async function logOut() {
    await forgetThisPhone();
    // Local scope: only this browser. The default ("global") also revoked
    // the session on every other device, which left those tabs looking
    // signed in while every API call failed.
    supabase.auth.signOut({ scope: "local" });
  }

  const signedIn = Boolean(user && !settingPassword);

  return (
    <div className={`app-shell${signedIn ? " signed-in" : ""}`}>
      <header className="app-header">
        <div>
          <p className="eyebrow">PropertySearch</p>
          <h1>Home-buying command centre</h1>
        </div>

        {/* On a phone this lives at the bottom of Settings instead. */}
        {signedIn && (
          <button
            type="button"
            className="secondary-button header-logout"
            onClick={logOut}
          >
            Log Out
          </button>
        )}
      </header>

      {user && !settingPassword && (
        <NavigationTabs
          activeView={activeView}
          setActiveView={setActiveView}
        />
      )}

      {user && !settingPassword && offerPush && (
        <div className="push-offer" role="status">
          <p>Get a notification when a new home matches your search, and the day before a viewing.</p>
          <div className="push-offer-actions">
            <button
              type="button"
              className="primary-button"
              onClick={async () => {
                setOfferPush(false);
                try {
                  await enablePush();
                } catch (error) {
                  console.error("Could not turn on notifications:", error);
                }
              }}
            >
              Turn on
            </button>
            <button
              type="button"
              className="secondary-button"
              onClick={() => {
                dismissPushOffer();
                setOfferPush(false);
              }}
            >
              Not now
            </button>
          </div>
        </div>
      )}

      {passwordChanged && (
        <p className="auth-banner" role="status">
          Password updated. You're signed in.
        </p>
      )}

      <main className="app-main">
        {settingPassword && user ? (
          <SetNewPasswordForm
            onDone={() => {
              setSettingPassword(false);
              setPasswordChanged(true);
              // Drop the recovery hash/params so a refresh doesn't reopen this.
              window.history.replaceState(null, "", window.location.pathname);
            }}
          />
        ) : !user ? (
          <AuthForm invite={invite} />
        ) : (
          <>
            {invite && showJoin && (
              <JoinHousehold invite={invite} onDone={() => setShowJoin(false)} />
            )}
            {activeView === "properties" && (
              <PropertiesView
                onOpenSettings={(section) => {
                  setSettingsFocus(section);
                  setActiveView("settings");
                }}
                onOpenWatchlist={() => setActiveView("history")}
              />
            )}
            {activeView === "dashboard" && (
              <DashboardView
                onNavigate={(view, section, propertyId) => {
                  if (section) setSettingsFocus(section);
                  if (propertyId) setFocusProperty(propertyId);
                  setActiveView(view);
                }}
              />
            )}
            {activeView === "calendar" && (
              <CalendarView onOpenNotes={openNotes} onOpenSettings={() => openSettings("musthaves")} />
            )}
            {activeView === "history" && (
              <HistoryView
                focusPropertyId={focusProperty}
                onFocused={clearFocusProperty}
                onOpenSettings={() => openSettings("musthaves")}
              />
            )}
            {activeView === "settings" && (
              <SettingsView
                user={user}
                focusSection={settingsFocus}
                onFocused={() => setSettingsFocus(null)}
                onLogOut={logOut}
                isAgent={isAgent}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;