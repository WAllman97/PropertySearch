import "./AgentPortal.css";

// Public privacy policy: /privacy. Apple needs a URL for this in App Store
// Connect, and links it from the app listing.
//
// DRAFT: review before launch (company name, contact address, and anything
// that changes in how data is used). Not legal advice.
const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || "[contact email]";
const UPDATED = "19 November 2026";

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
            <strong>Home buyers:</strong> your name, the properties you save, your notes, ratings
            and viewing times, the places you commute to (so we can work out journey times), and
            your saved searches (areas, a place and distance, or an area you draw on a map, plus
            price, bedrooms and type).
          </li>
          <li>
            <strong>Household:</strong> if you invite a partner, everyone in the household shares
            the same property list, notes, calendar and buying position.
          </li>
          <li>
            <strong>Buying position (optional):</strong> budget, deposit, whether you're buying
            with cash or a mortgage, mortgage agreement details (amount, lender, expiry), whether
            you have a home to sell, solicitor and moving timescale. You can also upload one
            document as proof (a mortgage agreement or proof of funds), stored privately.
          </li>
          <li>
            <strong>Offers:</strong> if you tell us an offer was accepted, the property and amount.
          </li>
          <li>
            <strong>Estate agents:</strong> your name, agency, branch, phone and email, the
            listings you add and the viewing times you publish.
          </li>
          <li>
            <strong>Viewing bookings:</strong> the name, email and phone number a buyer enters
            when booking, which we pass to the agent for that viewing.
          </li>
          <li>
            <strong>Phone notifications:</strong> if you turn them on, a notification token for
            your phone, so we can send you alerts. It's deleted when you log out or turn them off.
          </li>
        </ul>
        <p>
          We don't collect your phone's location, contacts or photos, and we don't track you
          across other apps or websites.
        </p>
      </section>

      <section className="card">
        <h3>How we use it</h3>
        <ul>
          <li>To run the app: show your properties, book and remind you of viewings.</li>
          <li>To send emails you'd expect: booking confirmations, cancellations and reminders.</li>
          <li>
            To give each viewing's agent the buyer's contact details, and each buyer the agent's.
          </li>
          <li>
            To send you new listings from agents that match your saved searches. Agents only see
            how many buyers a listing matches, never who.
          </li>
          <li>
            To show your buying position to agents whose homes you book a viewing for or report
            an accepted offer on, if you leave sharing switched on. It's marked as your own
            declaration, and those agents can open any proof document you've uploaded. You can
            switch sharing off or remove the document in Settings at any time.
          </li>
          <li>
            To ask the selling agent to confirm an offer you report as accepted. They see the
            amount and your name.
          </li>
        </ul>
        <p>We don't sell your data or use it for advertising.</p>
      </section>

      <section className="card">
        <h3>Who processes it for us</h3>
        <ul>
          <li>Supabase: database and logins</li>
          <li>Vercel: hosting the app</li>
          <li>Resend: sending emails (sent from its servers in Ireland)</li>
          <li>Google Maps: journey times (only the addresses involved)</li>
          <li>HM Land Registry: local sold prices (only the postcodes near a saved home)</li>
          <li>Apple: delivering phone notifications</li>
          <li>postcodes.io: finding where places and postcodes are (only the place or postcode)</li>
          <li>OpenStreetMap: the map tiles shown when you draw a search area</li>
        </ul>
      </section>

      <section className="card">
        <h3>Keeping and deleting it</h3>
        <p>
          We keep your data while you have an account. You can delete your account in the app at
          any time. Buyers: Settings, then Delete Account. This removes your login, and when the
          last person leaves a household, its properties, notes, searches and buying position too.
          Agents: Delete account at the bottom of the agent page, which removes their profile,
          listings and viewing times and tells buyers with upcoming viewings. You can also ask us
          to delete your data, or for a copy of it, by emailing {CONTACT_EMAIL}.
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
