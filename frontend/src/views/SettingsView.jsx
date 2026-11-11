import BookingSettings from "../components/BookingSettings";
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
      {/* Saved Searches is hidden: the scraper reads backend/config.yaml, not
          the search_criteria table, so edits there had no effect. Bring it
          back once searches are per-user. */}
      <section className="card">
        <div className="section-header">
          <h2>Agent Booking Page</h2>
          <p>
            Give agents this link instead of your number. They pick a free
            slot for a call or viewing, you accept it, and it lands in your
            calendar.
          </p>
        </div>

        <BookingSettings user={user} />
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