import { useEffect, useState } from "react";
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
import "./App.css";

const VIEWS = ["properties", "history", "calendar", "dashboard", "settings"];

// Public agent booking page: /book/<slug>. Rendered without login.
function getBookingSlug() {
  const match = window.location.pathname.match(/^\/book\/([a-z0-9-]+)\/?$/);
  return match ? match[1] : null;
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">PropertySearch</p>
          <h1>Home-buying command centre</h1>
        </div>

        {user && !settingPassword && (
          <button
            type="button"
            className="secondary-button"
            // Local scope: only this browser. The default ("global") also
            // revoked the session on every other device, which left those
            // tabs looking signed in while every API call failed.
            onClick={() => supabase.auth.signOut({ scope: "local" })}
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
          <AuthForm />
        ) : (
          <>
            {activeView === "properties" && <PropertiesView />}
            {activeView === "dashboard" && <DashboardView />}
            {activeView === "calendar" && <CalendarView />}
            {activeView === "history" && <HistoryView />}
            {activeView === "settings" && <SettingsView user={user} />}
          </>
        )}
      </main>
    </div>
  );
}

export default App;