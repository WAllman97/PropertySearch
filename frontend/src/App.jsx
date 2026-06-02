import { useState } from "react";
import HomeView from "./views/HomeView";
import DashboardView from "./views/DashboardView";
import HistoryView from "./views/HistoryView";
import SettingsView from "./views/SettingsView";
import NavigationTabs from "./components/NavigationTabs";
import "./App.css";

function App() {
  const [activeView, setActiveView] = useState("home");

  return (
    <div className="app-shell">
      <header className="app-header">
        <div>
          <p className="eyebrow">PropertySearch</p>
          <h1>Home-buying command centre</h1>
        </div>
      </header>

      <NavigationTabs activeView={activeView} setActiveView={setActiveView} />

      <main className="app-main">
        {activeView === "home" && <HomeView />}
        {activeView === "dashboard" && <DashboardView />}
        {activeView === "history" && <HistoryView />}
        {activeView === "settings" && <SettingsView />}
      </main>
    </div>
  );
}

export default App;