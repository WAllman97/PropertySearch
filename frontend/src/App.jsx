import { lazy, Suspense, useEffect, useState } from "react";
import { ConfirmEmailPage } from "./components/ConfirmEmail";
import { arrivedFromPasswordReset, supabase } from "./lib/supabaseClient";
import AuthForm from "./components/AuthForm";
import SetNewPasswordForm from "./components/SetNewPasswordForm";

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

// Email links can open a tab directly, e.g. /?view=calendar
function getInitialView() {
  const view = new URLSearchParams(window.location.search).get("view");
  return VIEWS.includes(view) ? view : "properties";
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

  // The link in the "confirm your email" message sent at sign-up.
  if (/^\/confirm\/?$/.test(window.location.pathname)) {
    return <ConfirmEmailPage />;
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
  const [invite] = useState(getInviteCode);
  // Settings card to scroll to when another view links there.
  const [settingsFocus, setSettingsFocus] = useState(null);

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
    (async () => {
      const [{ data: isMember }, { data: agent }] = await Promise.all([
        supabase.rpc("is_household_member"),
        supabase.from("agents").select("user_id").eq("user_id", user.id).maybeSingle(),
      ]);
      if (agent && isMember === false) window.location.replace("/agent");
    })();
  }, [user]);

  // iPhone app: keep this phone's notification token current, and offer
  // notifications once. Both do nothing on the website.
  const [offerPush, setOfferPush] = useState(false);
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    refreshPushRegistration();
    shouldOfferPush().then(setOfferPush).catch(() => {});
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
            {invite && getInviteCode() && (
              <p className="auth-banner" role="status">
                You're already signed in, so this invite link doesn't apply. To join that
                household instead, log out and sign up with a different email.
              </p>
            )}
            {activeView === "properties" && (
              <PropertiesView
                onOpenSettings={(section) => {
                  setSettingsFocus(section);
                  setActiveView("settings");
                }}
              />
            )}
            {activeView === "dashboard" && (
              <DashboardView
                onNavigate={(view, section) => {
                  if (section) setSettingsFocus(section);
                  setActiveView(view);
                }}
              />
            )}
            {activeView === "calendar" && <CalendarView />}
            {activeView === "history" && <HistoryView />}
            {activeView === "settings" && (
              <SettingsView
                user={user}
                focusSection={settingsFocus}
                onFocused={() => setSettingsFocus(null)}
                onLogOut={logOut}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

export default App;