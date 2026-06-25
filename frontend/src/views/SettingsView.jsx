import SearchCriteriaManager from "../components/SearchCriteriaManager";
import BuyerProfileSettings from "../components/BuyerProfileSettings";
import NotificationSettings from "../components/NotificationSettings";

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
          <h2>Buyer Profile & Commute</h2>
          <p>
            Add commute locations, choose your preferred travel method, and
            refresh commute times.
          </p>
        </div>

        <BuyerProfileSettings user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Email Notifications</h2>
          <p>
            Choose how often you receive property alerts and add extra
            recipients, such as your partner.
          </p>
        </div>

        <NotificationSettings user={user} />
      </section>
    </>
  );
}

export default SettingsView;