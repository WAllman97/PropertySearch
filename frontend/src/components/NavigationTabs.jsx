function NavigationTabs({ activeView, setActiveView }) {
  const tabs = [
    { id: "home", label: "Feed" },
    { id: "dashboard", label: "Dashboard" },
    { id: "history", label: "Watchlist" },
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