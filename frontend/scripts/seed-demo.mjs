// Demo accounts for Apple's App Review and the App Store screenshots.
//
//   cd frontend
//   node --env-file=../backend/.env --env-file=.env scripts/seed-demo.mjs
//
// Creates (or rebuilds from scratch on every run) two fictional accounts,
// separate from every real household and agent:
//   * a buyer household, "Sam & Alex", house-hunting in south-west London:
//     saved homes, notes and scores, a search area, travel times, a buying
//     position, a booked viewing and an offer, and the agent below under
//     Settings → Agents;
//   * an agent, "Jordan Ellis, Larkspur Homes · Clapham", with listings that
//     match some of the buyer's homes, weekly viewing hours, the buyer's
//     booking and offer, and some time saved.
// Both logins are already confirmed. Passwords are made on the first run and
// kept in docs/app-review-logins.local.md (git-ignored); later runs reuse them.
//
// Nothing here sends email: rows are written directly with the service role.
// Photos are from Unsplash (free to use commercially, no credit required).
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { createClient } = require("@supabase/supabase-js");

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const BUYER_EMAIL = "appreview.buyer@viewpal.co.uk";
const AGENT_EMAIL = "appreview.agent@viewpal.co.uk";
const LOGINS_FILE = path.resolve(process.cwd(), "../docs/app-review-logins.local.md");

const DAY = 86400000;
const now = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const daysAgo = (d) => iso(now - d * DAY);
const photo = (id) => `https://images.unsplash.com/${id}?w=1200&h=800&fit=crop&q=75`;

// hh:mm UK time, `days` from today.
function londonAt(days, hh, mm) {
  const d = new Date(now + days * DAY);
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/London" }).format(d);
  const guess = new Date(`${day}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00Z`);
  const offset = new Date(guess.toLocaleString("en-US", { timeZone: "Europe/London" })) - new Date(guess.toLocaleString("en-US", { timeZone: "UTC" }));
  return new Date(guess.getTime() - offset);
}
// The next Monday-Friday at least `min` days ahead.
function weekdayAhead(min) {
  for (let d = min; d < min + 7; d += 1) {
    const wd = new Date(now + d * DAY).getUTCDay();
    if (wd >= 1 && wd <= 5) return d;
  }
  return min;
}

// ---------------------------------------------------------------------------

function loadPasswords() {
  const found = {};
  if (fs.existsSync(LOGINS_FILE)) {
    const text = fs.readFileSync(LOGINS_FILE, "utf8");
    for (const [, who, pw] of text.matchAll(/^- (buyer|agent) password: `([^`]+)`/gm)) found[who] = pw;
  }
  const make = () => `Demo-${randomBytes(9).toString("base64url")}`;
  const pw = { buyer: found.buyer || make(), agent: found.agent || make() };
  fs.mkdirSync(path.dirname(LOGINS_FILE), { recursive: true });
  fs.writeFileSync(
    LOGINS_FILE,
    `# App Review demo logins (local only, not in git)

Made by frontend/scripts/seed-demo.mjs. Paste into App Store Connect →
your app → App Review Information → Sign-in required.

Buyer app (log in on the first screen):
- buyer email: \`${BUYER_EMAIL}\`
- buyer password: \`${pw.buyer}\`

Agent portal (on the log-in screen tap "Estate agent? Sign in or sign up here"):
- agent email: \`${AGENT_EMAIL}\`
- agent password: \`${pw.agent}\`

Re-running the script rebuilds both accounts' data with these same passwords.
`
  );
  return pw;
}

async function removeExisting() {
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  for (const email of [BUYER_EMAIL, AGENT_EMAIL]) {
    const user = data.users.find((u) => u.email === email);
    if (!user) continue;
    const { data: member } = await admin
      .from("household_members").select("household_id").eq("user_id", user.id).maybeSingle();
    if (member) {
      const { data: hh } = await admin.from("households").select("is_original").eq("id", member.household_id).single();
      if (hh?.is_original) throw new Error("Refusing to touch the original household");
    }
    // Agent rows (listings, slots, bookings) cascade from the login.
    await admin.auth.admin.deleteUser(user.id);
    if (member) await admin.from("households").delete().eq("id", member.household_id);
  }
}

async function createLogin(email, password, metadata) {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: metadata,
  });
  if (error) throw error;
  return data.user.id;
}

async function must(promise, what) {
  const { data, error } = await promise;
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
}

// ---------------------------------------------------------------------------
// The homes. Streets are real south-west London streets with no house
// numbers (as portals show them); listings, prices and photos are made up.

const HOMES = [
  {
    key: "booked", title: "Elsley Road, Battersea", postcode: "SW11", lat: 51.4655, lng: -0.1636,
    price: 925000, beds: 3, type: "Terraced", sub: "Victorian terrace", tenure: "Freehold", sqft: 1240,
    photo: "photo-1759338584492-45647a320916", url: "https://www.zoopla.co.uk/for-sale/details/90100001/",
    status: "viewing_booked", listed: 9, transit: 28, partner: 34,
    desc: "A bright three-bedroom Victorian terrace moments from Clapham Junction, with a 40ft south-facing garden, a kitchen-diner opening onto the garden and a loft ready to convert (STPP).",
    scores: [8, 7, 8, 7, 8, 9],
    notes: { positives: "- South-facing garden\n- Walk to Clapham Junction\n- Loft potential", negatives: "- Small third bedroom", questions: "- How old is the boiler?\n- Any planning on the loft?" },
    agentListing: true,
  },
  {
    key: "offer", title: "Gowrie Road, Battersea", postcode: "SW11", lat: 51.4626, lng: -0.1574,
    price: 850000, beds: 3, type: "Terraced", sub: "Terraced house", tenure: "Freehold", sqft: 1105,
    photo: "photo-1782470691291-cae461d3e3fa", url: "https://www.zoopla.co.uk/for-sale/details/90100002/",
    status: "offer_made", listed: 21, transit: 31, partner: 30, viewedDaysAgo: 6,
    desc: "Well-kept three-bedroom house on a quiet tree-lined street off Lavender Hill, with an extended kitchen, a separate reception and a patio garden.",
    scores: [8, 8, 7, 8, 7, 8],
    notes: { positives: "- Extended kitchen\n- Quiet street\n- Ready to move in", negatives: "- Patio not lawn\n- On-street parking", viewing_notes: "Loved it. Neighbours friendly. Light in the evening." },
    offer: 835000, agentListing: true,
  },
  {
    key: "fav1", title: "Bolingbroke Grove, Battersea", postcode: "SW11", lat: 51.4567, lng: -0.1676,
    price: 1150000, beds: 4, type: "Semi-detached", sub: "Semi-detached house", tenure: "Freehold", sqft: 1680,
    photo: "photo-1607900840367-a83dcd63296d", url: "https://www.zoopla.co.uk/for-sale/details/90100003/",
    status: "favourite", listed: 5, transit: 33, partner: 38,
    desc: "Handsome four-bedroom family house overlooking Wandsworth Common, with a large living room, a family kitchen and a 60ft garden.",
    scores: [9, 8, 7, 6, 9, 8], agentListing: true,
  },
  {
    key: "reduced", title: "Abbeville Road, Clapham", postcode: "SW4", lat: 51.4560, lng: -0.1428,
    price: 799950, initial: 850000, reducedDaysAgo: 3, beds: 2, type: "Terraced", sub: "Terraced house", tenure: "Freehold", sqft: 905,
    photo: "photo-1689867373120-355ce130d485", url: "https://www.onthemarket.com/details/90100004/",
    status: "favourite", listed: 34, transit: 26, partner: 29,
    desc: "Charming two-bedroom cottage-style house in Abbeville Village, with a modern kitchen, a sunny courtyard garden and cafés on the doorstep.",
    scores: [9, 7, 8, 8, 6, 8],
  },
  {
    key: "new1", title: "Ramsden Road, Balham", postcode: "SW12", lat: 51.4458, lng: -0.1555,
    price: 875000, beds: 3, type: "Terraced", sub: "Victorian terrace", tenure: "Freehold", sqft: 1190,
    photo: "photo-1686053246030-f7ca291c9145", url: "https://www.onthemarket.com/details/90100005/",
    status: "new", listed: 1, transit: 30, partner: 27,
    desc: "Three-bedroom Victorian house a short walk from Balham station, with period features, two receptions and a west-facing garden.",
    scores: [8, 7, 8, 7, 8, 7],
  },
  {
    key: "new2", title: "Hendham Road, Wandsworth Common", postcode: "SW17", lat: 51.4426, lng: -0.1719,
    price: 1050000, beds: 4, type: "Terraced", sub: "Terraced house", tenure: "Freehold", sqft: 1520,
    photo: "photo-1732721176814-c0bc82db3971", url: "https://www.zoopla.co.uk/for-sale/details/90100006/",
    status: "new", listed: 2, transit: 37, partner: 41,
    desc: "Four-bedroom house in the Heaver Estate, with a kitchen extension, a lovely garden and Wandsworth Common at the end of the road.",
    scores: [9, 8, 6, 7, 9, 7],
  },
  {
    key: "sstc", title: "Fernlea Road, Balham", postcode: "SW12", lat: 51.4447, lng: -0.1478,
    price: 715000, beds: 2, type: "Terraced", sub: "Terraced house", tenure: "Freehold", sqft: 860,
    photo: "photo-1774156720905-11b4f15b284d", url: "https://www.onthemarket.com/details/90100007/",
    status: "favourite", listed: 40, transit: 29, partner: 26, listingStatus: "sold_stc",
    desc: "Two-bedroom terraced house with a through reception, a galley kitchen and a private garden, close to Balham High Road.",
    scores: [7, 6, 8, 8, 6, 6],
  },
  {
    key: "new3", title: "Lavender Gardens, Battersea", postcode: "SW11", lat: 51.4630, lng: -0.1640,
    price: 995000, beds: 3, type: "Terraced", sub: "Townhouse", tenure: "Freehold", sqft: 1310,
    photo: "photo-1651964723487-722c8acc07d6",
    url: "https://www.zoopla.co.uk/for-sale/details/90100008/",
    status: "new", listed: 3, transit: 27, partner: 32,
    desc: "Elegant three-bedroom townhouse on a garden square, with a double reception, a roof terrace and a garden.",
    scores: [9, 9, 8, 6, 8, 8],
  },
  {
    key: "new4", title: "Nightingale Lane, Clapham South", postcode: "SW12", lat: 51.4497, lng: -0.1593,
    price: 1275000, beds: 4, type: "Detached", sub: "Detached house", tenure: "Freehold", sqft: 1890,
    photo: "photo-1772364588829-2d1ad8557d56", url: "https://www.onthemarket.com/details/90100009/",
    status: "new", listed: 6, transit: 32, partner: 31,
    desc: "Detached four-bedroom Edwardian house between the commons, with a driveway, a large garden and room to extend.",
    scores: [9, 8, 7, 5, 9, 7],
  },
  {
    key: "new5", title: "Honeywell Road, Battersea", postcode: "SW11", lat: 51.4560, lng: -0.1640,
    price: 940000, beds: 3, type: "Terraced", sub: "Victorian terrace", tenure: "Freehold", sqft: 1210,
    photo: "photo-1775052235903-67d3496c5061", url: "https://www.onthemarket.com/details/90100012/",
    status: "new", listed: 2, transit: 31, partner: 36,
    desc: "Three-bedroom Victorian house in the Between the Commons area, with a side-return kitchen extension and a 45ft garden.",
    scores: [9, 8, 7, 7, 8, 8],
  },
  {
    key: "new6", title: "Cautley Avenue, Clapham South", postcode: "SW4", lat: 51.4540, lng: -0.1460,
    price: 865000, beds: 3, type: "Terraced", sub: "Edwardian terrace", tenure: "Freehold", sqft: 1080,
    photo: "photo-1732721176441-c99964b8f022", url: "https://www.zoopla.co.uk/for-sale/details/90100013/",
    status: "new", listed: 4, transit: 25, partner: 28,
    desc: "Edwardian three-bedroom house moments from Clapham Common, with a through reception, a modern kitchen and a lawned garden.",
    scores: [9, 7, 9, 7, 7, 8],
  },
  {
    key: "viewed", title: "Thurleigh Road, Clapham", postcode: "SW12", lat: 51.4520, lng: -0.1578,
    price: 899000, beds: 3, type: "Terraced", sub: "Terraced house", tenure: "Freehold", sqft: 1150,
    photo: "photo-1657073900955-add2877e53b3", url: "https://www.zoopla.co.uk/for-sale/details/90100010/",
    status: "viewed", listed: 18, transit: 30, partner: 33, viewedDaysAgo: 9,
    desc: "Three-bedroom house with a wisteria-clad front, a kitchen-diner, a cellar and a 50ft garden.",
    scores: [8, 7, 7, 7, 7, 6],
    notes: { positives: "- Lovely garden\n- Cellar storage", negatives: "- Needs a new bathroom\n- Busy road at rush hour", viewing_notes: "Good, but not as light as Gowrie Road." },
  },
];

// ---------------------------------------------------------------------------

async function main() {
  const pw = loadPasswords();
  await removeExisting();

  // --- Buyer household ---------------------------------------------------------
  const buyerId = await createLogin(BUYER_EMAIL, pw.buyer, { role: "buyer", name: "Sam Taylor" });
  const household = await must(
    admin.from("households").insert({ name: "Sam & Alex's household" }).select("id").single(),
    "household"
  );
  const H = household.id;
  await must(admin.from("household_members").insert({ user_id: buyerId, household_id: H }), "member");

  await must(admin.from("buyer_profiles").insert({
    user_id: buyerId, household_id: H,
    user_work_address: "Bank, London EC2", partner_work_address: "King's Cross, London N1",
    school_address: "", has_school_commute: false, commute_mode: "TRANSIT",
    email_alerts_enabled: false, alert_email: BUYER_EMAIL,
  }), "buyer profile");

  await must(admin.from("buyer_searches").insert([
    {
      user_id: buyerId, name: "Near Clapham Junction", min_price: 700000, max_price: 1000000,
      min_bedrooms: 3, property_types: ["house"], must_have_garden: true, is_active: true,
      areas: [], center_label: "Clapham Junction", center_lat: 51.4643, center_lng: -0.1704, radius_m: 1609,
    },
    {
      user_id: buyerId, name: "Between the commons", min_price: 700000, max_price: 1200000,
      min_bedrooms: 3, property_types: null, must_have_garden: true, is_active: true, areas: [],
      polygon: [[51.4605, -0.1795], [51.4612, -0.1495], [51.4470, -0.1425], [51.4405, -0.1600], [51.4460, -0.1790]],
    },
  ]), "searches");

  await must(admin.from("buyer_positions").insert({
    household_id: H, max_budget: 950000, deposit: 190000, buying_with: "mortgage",
    mortgage_status: "aip", aip_amount: 760000, aip_lender: "Nationwide", aip_expires: iso(now + 75 * DAY).slice(0, 10),
    selling_status: "first_time", solicitor_ready: true, move_timeframe: "3_months", share_with_agents: true,
    updated_by: buyerId,
  }), "buying position");

  const ids = {};
  for (const h of HOMES) {
    const [loc, qual, com, val, fut, gut] = h.scores;
    // Out of 100, as the app shows it.
    const overall = Math.round(((loc + qual + com + val + fut + gut) / 6) * 10);
    const row = await must(admin.from("properties").insert({
      household_id: H, source: new URL(h.url).hostname.includes("zoopla") ? "zoopla" : "onthemarket",
      listing_id: `demo_${h.key}`, title: h.title, address: h.title, price: h.price, bedrooms: h.beds,
      image_url: photo(h.photo), listing_url: h.url, date_found: daysAgo(Math.min(h.listed, 4)).slice(0, 10),
      status: h.status, description: h.desc, postcode: h.postcode, latitude: h.lat, longitude: h.lng,
      property_type: h.type, property_sub_type: h.sub, tenure: h.tenure, size_sqft: h.sqft,
      first_listed_at: daysAgo(h.listed), listing_status: h.listingStatus || "live", listing_checked_at: daysAgo(0),
      initial_price: h.initial || h.price, price_reduced_at: h.reducedDaysAgo ? daysAgo(h.reducedDaysAgo) : null,
      last_price_change_at: h.reducedDaysAgo ? daysAgo(h.reducedDaysAgo) : null,
      user_transit_minutes: h.transit, partner_transit_minutes: h.partner,
      user_commute_minutes: h.transit, partner_commute_minutes: h.partner,
      commute_average_minutes: Math.round((h.transit + h.partner) / 2), commute_mode: "TRANSIT",
      user_transit_status: "OK", partner_transit_status: "OK", commute_last_checked_at: daysAgo(0),
      location_score: loc, quality_score: qual, commute_score: com, value_score: val, future_fit_score: fut, gut_feel: gut,
      score_location: loc, score_quality: qual, score_commute: com, score_value: val, score_future_fit: fut, score_gut_feel: gut,
      overall_score: overall, scores_source: "manual",
      created_at: daysAgo(Math.min(h.listed, 4)),
    }).select("id").single(), `home ${h.key}`);
    ids[h.key] = row.id;

    const history = [{ property_id: row.id, price: h.initial || h.price, observed_at: daysAgo(h.listed), source: "initial" }];
    if (h.initial) history.push({ property_id: row.id, price: h.price, observed_at: daysAgo(h.reducedDaysAgo), source: "refresh" });
    await must(admin.from("price_history").insert(history), "price history");

    if (h.notes || h.viewedDaysAgo) {
      await must(admin.from("property_notes").insert({
        property_id: row.id, positives: h.notes?.positives || "", negatives: h.notes?.negatives || "",
        questions: h.notes?.questions || "", viewing_notes: h.notes?.viewing_notes || null, general_notes: "",
        estate_agent: h.agentListing ? "Jordan Ellis, Larkspur Homes" : "Mia Clarke, Commonside Estates",
        viewing_datetime: h.viewedDaysAgo ? iso(londonAt(-h.viewedDaysAgo, 18, 0)) : null,
      }), "notes");
    }
  }

  // --- Agent ------------------------------------------------------------------
  const agentId = await createLogin(AGENT_EMAIL, pw.agent, { role: "agent", name: "Jordan Ellis" });
  await must(admin.from("agents").insert({
    user_id: agentId, name: "Jordan Ellis", agency: "Larkspur Homes", branch: "Clapham",
    phone: "020 7946 0018", email: AGENT_EMAIL,
  }), "agent");

  const listingIds = {};
  for (const h of HOMES.filter((x) => x.agentListing)) {
    const l = await must(admin.from("agent_listings").insert({
      agent_id: agentId, listing_url: h.url, address: h.title, price: h.price, postcode: h.postcode,
      bedrooms: h.beds, property_type: "house", has_garden: true, image_url: photo(h.photo),
      notes: "Meet outside. Street parking only.",
    }).select("id").single(), `listing ${h.key}`);
    listingIds[h.key] = l.id;
  }
  const extra = await must(admin.from("agent_listings").insert({
    agent_id: agentId, listing_url: "https://www.zoopla.co.uk/for-sale/details/90100011/",
    address: "Mallinson Road, Battersea", price: 1095000, postcode: "SW11", bedrooms: 4,
    property_type: "house", has_garden: true, image_url: photo("photo-1710883727427-59d1ccc368fa"),
    notes: "Keys at the office.",
  }).select("id").single(), "extra listing");
  listingIds.extra = extra.id;

  // The agent has sent their listings to matching buyers.
  await must(admin.from("listing_sends").insert(
    Object.values(listingIds).map((listing_id) => ({ listing_id, user_id: buyerId }))
  ), "sends");

  // Weekly hours: weekday evenings and Saturday morning, 20-minute viewings.
  await must(admin.from("agent_availability").insert({
    agent_id: agentId, enabled: true, slot_minutes: 20, travel_minutes: 15, days_ahead: 14, notice_hours: 2,
  }), "availability");
  await must(admin.from("agent_hours").insert([
    ...[1, 2, 3, 4, 5].map((weekday) => ({ agent_id: agentId, weekday, starts: "17:00", ends: "19:00" })),
    { agent_id: agentId, weekday: 6, starts: "10:00", ends: "13:00" },
  ]), "hours");
  await must(admin.rpc("sync_pattern_slots", { p_agent: agentId }), "slots");

  // The buyer's booked viewing at Elsley Road (no emails: written directly).
  const viewDay = weekdayAhead(2);
  const start = londonAt(viewDay, 17, 40);
  const { data: slot } = await admin.from("viewing_slots").select("id, starts_at, ends_at")
    .eq("listing_id", listingIds.booked).eq("starts_at", start.toISOString()).maybeSingle();
  if (!slot) throw new Error("No 17:40 slot to book");
  await must(admin.from("viewing_bookings").insert({
    slot_id: slot.id, buyer_id: buyerId, property_id: ids.booked, buyer_name: "Sam Taylor",
    buyer_email: BUYER_EMAIL, buyer_phone: "07700 900123",
  }), "booking");
  await must(admin.from("property_notes").update({ viewing_datetime: slot.starts_at })
    .eq("property_id", ids.booked), "viewing time");

  // A second viewing on the calendar, with an agent who isn't on the app.
  await must(admin.from("property_notes").insert({
    property_id: ids.reduced, positives: "- Price just dropped\n- Abbeville Village", negatives: "", questions: "",
    general_notes: "", estate_agent: "Mia Clarke, Commonside Estates", viewing_datetime: iso(londonAt(weekdayAhead(4), 12, 30)),
  }), "second viewing");

  // The offer on Gowrie Road, waiting for the agent to confirm.
  await must(admin.from("offers").insert({
    household_id: H, property_id: ids.offer, agent_listing_id: listingIds.offer, amount: 835000,
    reported_by: buyerId, reported_at: daysAgo(1), status: "awaiting_agent",
  }), "offer");

  // Time saved (migration 030): two buyers this agent didn't chase because
  // they'd paused or found somewhere. Bookings and sends above count too.
  await must(admin.from("agent_activity").insert({
    agent_id: agentId, listing_id: listingIds.extra, kind: "buyers_skipped", count: 2,
  }), "time saved");

  // No reminder emails for the demo viewings (the hourly job sends them).
  await must(admin.from("property_notes").update({ reminder_sent_at: iso(now) })
    .in("property_id", Object.values(ids)), "reminders off");

  console.log(`Demo ready. Buyer household ${H}, ${HOMES.length} homes; agent with ${Object.keys(listingIds).length} listings.`);
  console.log(`Viewing booked ${slot.starts_at}. Logins in ${path.relative(process.cwd(), LOGINS_FILE)}.`);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
