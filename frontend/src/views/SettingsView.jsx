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
          <p>Manage your saved property searches.</p>
        </div>

        <SearchCriteriaManager user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Buyer Profile</h2>
          <p>
            Add the places that matter to your search so commute times can be
            calculated automatically.
          </p>
        </div>

        <BuyerProfileSettings user={user} />
      </section>
    </>
  );
}

export default SettingsView;
