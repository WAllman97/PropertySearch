import "./AgentPortal.css";

// Public privacy policy: /privacy. Apple needs a URL for this in App Store
// Connect, and links it from the app listing.
//
// DRAFT: review before launch (company name, contact address, and anything
// that changes in how data is used). Not legal advice.
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || "[contact email]";
const UPDATED = "17 November 2026";

function PrivacyPage() {
  return (
    <div className="booking-shell privacy-page">
      <header className="booking-header">
        <p className="eyebrow">PropertySearch</p>
        <h1>Privacy policy</h1>
        <p className="muted">Last updated {UPDATED}</p>
      </header>

      <section className="card">
        <h3>What we collect</h3>
        <ul>
          <li>
            <strong>Your account:</strong> email address and password (stored encrypted by our
            login provider; we never see it).
          </li>
          <li>
            <strong>Home buyers:</strong> the properties you save, your notes, ratings and viewing
            times, and the places you commute to so we can work out journey times.
          </li>
          <li>
            <strong>Estate agents:</strong> your name, agency, branch, phone and email, the
            listings you add and the viewing times you publish.
          </li>
          <li>
            <strong>Viewing bookings:</strong> the name, email and phone number a buyer enters
            when booking, which we pass to the agent for that viewing.
          </li>
        </ul>
      </section>

      <section className="card">
        <h3>How we use it</h3>
        <ul>
          <li>To run the app: show your properties, book and remind you of viewings.</li>
          <li>To send emails you'd expect: booking confirmations, cancellations and reminders.</li>
          <li>
            To give each viewing's agent the buyer's contact details, and each buyer the agent's.
          </li>
        </ul>
        <p>We don't sell your data or use it for advertising.</p>
      </section>

      <section className="card">
        <h3>Who processes it for us</h3>
        <ul>
          <li>Supabase: database and logins</li>
          <li>Vercel: hosting the app</li>
          <li>Resend: sending emails</li>
          <li>Google Maps: journey times (only the addresses involved)</li>
          <li>Anthropic: summarising and scoring property listings (listing details only)</li>
        </ul>
      </section>

      <section className="card">
        <h3>Keeping and deleting it</h3>
        <p>
          We keep your data while you have an account. Agents can delete their account in the app
          (Delete account, at the bottom of the agent page), which removes their profile, listings
          and viewing times and tells buyers with upcoming viewings. Anyone else can ask us to
          delete their data, or for a copy of it, by emailing {CONTACT_EMAIL}.
        </p>
      </section>

      <section className="card">
        <h3>Your rights</h3>
        <p>
          Under UK data protection law you can ask to see, correct or delete your data, and you
          can complain to the Information Commissioner's Office (ico.org.uk). Contact us first at{" "}
          {CONTACT_EMAIL} and we'll help.
        </p>
      </section>
    </div>
  );
}

export default PrivacyPage;
