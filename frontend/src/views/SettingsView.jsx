import SearchCriteriaManager from "../components/SearchCriteriaManager";

function SettingsView({ user }) {
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

  return (
    <section className="card">
      <div className="section-header">
        <h2>Settings</h2>
        <p>Manage your saved property searches.</p>
      </div>

      <SearchCriteriaManager user={user} />
    </section>
  );
}

export default SettingsView;
