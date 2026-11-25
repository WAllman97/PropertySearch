import "./AgentPortal.css";

// Public page for estate agents: /agents. What they get, how it works, and
// how to join (agents sign up at /agent with their agency's code).

const CONTACT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL || "";

const BENEFITS = [
  {
    icon: "📅",
    title: "Viewings that book themselves",
    text: "Publish the times you can show a home. Buyers who've saved it book straight in. You get their details and a calendar invite, and they get a reminder the day before.",
  },
  {
    icon: "✅",
    title: "Know who can proceed",
    text: "Buyers share their position before they turn up: mortgage agreed, nothing to sell, solicitor ready. They can attach their agreement in principle or proof of funds for you to open.",
  },
  {
    icon: "📣",
    title: "New listings to the right buyers",
    text: "Send a listing to buyers whose search it fits, by postcode, distance or an area they drew. You see how many it reaches before you send. Who they are stays private until they book.",
  },
  {
    icon: "🤝",
    title: "Offers confirmed in one tap",
    text: "When a buyer says you've accepted their offer, you're asked to confirm it. One tap keeps everyone's records straight.",
  },
];

const STEPS = [
  ["Add a listing", "Paste its Rightmove, Zoopla or OnTheMarket link and the postcode. No feed to set up."],
  ["Add viewing times", "Private slots or an open house. Share the booking link anywhere you like."],
  ["Buyers book", "You see each buyer's position next to their booking, and it lands in your calendar."],
];

const FAQS = [
  [
    "Is this another property portal?",
    "No. Keep listing where you do now. ViewPal is where buyers organise their search, so your viewing times and listings reach buyers who are already looking.",
  ],
  [
    "Do buyers see my phone number?",
    "Only if you add it, and only buyers who book a viewing with you see it.",
  ],
  [
    "What does it cost?",
    "Nothing during the pilot in south-west London. We'll talk to you before anything changes.",
  ],
  [
    "Can colleagues use it?",
    "Yes. Tell us how many people at your branch need access and each signs up with your branch's code, with their own login. Need more later? They can request a place from the sign-up page.",
  ],
];

function AgentsPage() {
  const mailto = CONTACT_EMAIL
    ? `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(
        "ViewPal sign-up code for agents"
      )}&body=${encodeURIComponent(
        "Hello,\n\nI'd like a sign-up code for our branch.\n\nAgency:\nBranch:\nHow many people need access:\nYour name:\nPhone:\n"
      )}`
    : null;

  return (
    <div className="booking-shell agents-page">
      <header className="booking-header agents-hero">
        <p className="eyebrow">ViewPal for estate agents</p>
        <h1>Proceedable buyers, booked into your viewings</h1>
        <p className="agents-lead">
          Buyers in your area already use ViewPal to save homes and plan viewings. Add your
          listings and the times you can show them, and the buyers who are ready to move book
          themselves in.
        </p>
        <div className="agents-cta">
          <a className="primary-button" href="/agent?mode=signup">
            Sign up with your branch's code
          </a>
          <a className="secondary-button" href="/agent">
            Log in
          </a>
        </div>
      </header>

      <section className="agents-benefits">
        {BENEFITS.map((b) => (
          <div key={b.title} className="card agents-benefit">
            <span className="agents-benefit-icon" aria-hidden="true">
              {b.icon}
            </span>
            <h3>{b.title}</h3>
            <p>{b.text}</p>
          </div>
        ))}
      </section>

      <section className="card">
        <h2>How it works</h2>
        <ol className="agents-steps">
          {STEPS.map(([title, text], i) => (
            <li key={title}>
              <span className="agents-step-number" aria-hidden="true">
                {i + 1}
              </span>
              <div>
                <strong>{title}</strong>
                <p>{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="card" id="get-a-code">
        <h2>Get your branch's code</h2>
        <p>
          Sign-up is by invitation so buyers only ever see real agents' times. Each branch gets
          its own code for the number of people who need access.
        </p>
        {mailto ? (
          <a className="primary-button" href={mailto}>
            Email us for a code
          </a>
        ) : (
          <p className="muted">Ask the person who told you about ViewPal for your code.</p>
        )}
      </section>

      <section className="card">
        <h2>Questions</h2>
        <dl className="agents-faq">
          {FAQS.map(([q, a]) => (
            <div key={q}>
              <dt>{q}</dt>
              <dd>{a}</dd>
            </div>
          ))}
        </dl>
      </section>

      <p className="muted agents-foot">
        <a href="/privacy">Privacy policy</a> · <a href="/support">Help</a> ·{" "}
        <a href="/">For buyers</a>
      </p>
    </div>
  );
}

export default AgentsPage;
