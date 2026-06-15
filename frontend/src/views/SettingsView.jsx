import SearchCriteriaManager from "../components/SearchCriteriaManager";
import BuyerProfileSettings from "../components/BuyerProfileSettings";

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
    <>
      <section className="card">
        <div className="section-header">
          <h2>Saved Searches</h2>
          <p>Manage your saved property searches and alert sources.</p>
        </div>

        <SearchCriteriaManager user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Buyer Profile & Alerts</h2>
          <p>
            Add commute locations, choose your commute method, and manage email
            alerts for newly found properties.
          </p>
        </div>

        <BuyerProfileSettings user={user} />
      </section>
    </>
  );
}

export default SettingsView;
