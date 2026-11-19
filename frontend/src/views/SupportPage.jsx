import "./AgentPortal.css";

// Public support page: /support. App Store Connect needs a support URL.
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || "[contact email]";

function SupportPage() {
  return (
    <div className="booking-shell privacy-page">
      <header className="booking-header">
        <p className="eyebrow">PropertySearch</p>
        <h1>Help and support</h1>
      </header>

      <section className="card">
        <h3>Contact us</h3>
        <p>
          Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> and we'll get back to you,
          usually within a working day.
        </p>
      </section>

      <section className="card">
        <h3>Common questions</h3>
        <h4>How do I add my partner?</h4>
        <p>Settings, then Household: copy the invite link and send it to them.</p>
        <h4>How do I get new listings sent to me?</h4>
        <p>
          Settings, then What you're looking for: choose postcodes, a place and distance, or draw
          an area on the map, and set your price and bedrooms. Agents' new listings that fit are
          sent to you.
        </p>
        <h4>Why aren't I getting phone notifications?</h4>
        <p>
          Settings, then Phone Notifications: make sure they're on, and that notifications for
          PropertySearch are allowed in your iPhone's Settings.
        </p>
        <h4>I'm an estate agent. How do I list a property?</h4>
        <p>
          Sign in or sign up from the estate agent link on the login screen, add the listing's
          link and postcode, then publish viewing times or send it to matching buyers.
        </p>
        <h4>How do I delete my account?</h4>
        <p>
          Buyers: Settings, then Delete Account. Agents: Delete account at the bottom of the agent
          page.
        </p>
      </section>

      <p className="muted">
        <a href="/privacy">Privacy policy</a>
      </p>
    </div>
  );
}

export default SupportPage;
