import { useEffect, useState } from "react";
import { supabase } from "./lib/supabaseClient";
import AuthForm from "./components/AuthForm";

import DashboardView from "./views/DashboardView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";
import PropertiesView from "./views/PropertiesView";
import NavigationTabs from "./components/NavigationTabs";
import CalendarView from "./views/CalendarView";
import "./App.css";

function App() {
  const [activeView, setActiveView] = useState("properties");
  const [user, setUser] = useState(null);

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
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });

    return () => subscription.unsubscribe();
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">PropertySearch</p>
          <h1>Home-buying command centre</h1>
        </div>

        {user && (
          <button
            type="button"
            className="secondary-button"
            onClick={() => supabase.auth.signOut()}
          >
            Log Out
          </button>
        )}
      </header>

      {user && (
        <NavigationTabs
          activeView={activeView}
          setActiveView={setActiveView}
        />
      )}

      <main className="app-main">
        {!user ? (
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