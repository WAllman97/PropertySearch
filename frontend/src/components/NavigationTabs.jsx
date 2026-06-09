function NavigationTabs({ activeView, setActiveView }) {
  const tabs = [
    { id: "properties", label: "Properties" },
    { id: "history", label: "Watchlist" },
    { id: "calendar", label: "Calendar" },
    { id: "dashboard", label: "Dashboard" },
    { id: "settings", label: "Settings" },
  ];

  return (
    <nav className="nav-tabs">
      {tabs.map((tab) => (
        <button
          key={tab.id}
          className={activeView === tab.id ? "active" : ""}
          onClick={() => setActiveView(tab.id)}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}

export default NavigationTabs;