// Raw App Store screenshots (6.9-inch iPhone, 1320 x 2868) of the demo
// accounts. Frame them afterwards with compose.py.
//
//   cd frontend
//   node --env-file=../backend/.env --env-file=.env scripts/seed-demo.mjs
//   npm install --no-save puppeteer-core@23.11.1
//   npm run dev                      (in another terminal)
//   node scripts/app-store/shoot.mjs ../docs/app-store/raw
//   python scripts/app-store/compose.py ../docs/app-store/raw ../docs/app-store/screenshots
//
// Uses the Chrome installed on this PC (CHROME_PATH to override), at
// 440 x 956 points and 3x scale. Logins come from the seed script's
// git-ignored docs/app-review-logins.local.md.
import puppeteer from "puppeteer-core";
import fs from "node:fs";
import path from "node:path";

const LOGINS = path.resolve(process.cwd(), "../docs/app-review-logins.local.md");
const text = fs.readFileSync(LOGINS, "utf8");
const cred = (who) => ({
  email: text.match(new RegExp(`${who} email: \`([^\`]+)\``))[1],
  password: text.match(new RegExp(`${who} password: \`([^\`]+)\``))[1],
});
const BASE = process.env.SHOOT_BASE || "http://localhost:5173";
const out = process.argv[2] || "../docs/app-store/raw";
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: true,
  args: ["--hide-scrollbars", "--force-color-profile=srgb"],
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function newPage() {
  const page = await browser.newPage();
  await page.setViewport({ width: 440, height: 956, deviceScaleFactor: 3, isMobile: true, hasTouch: true });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  return page;
}

async function login(page, who, at = "/") {
  const c = cred(who);
  await page.goto(BASE + at, { waitUntil: "networkidle2" });
  // Clear any old session, but say this device has logged in before, so
  // it opens on Log in rather than Create account (AuthForm.jsx).
  await page.evaluate(() => {
    Object.keys(localStorage).forEach((k) => localStorage.removeItem(k));
    localStorage.setItem("ps:hasLoggedIn", "1");
  });
  await page.goto(BASE + at, { waitUntil: "networkidle2" });
  await page.type('input[type="email"]', c.email);
  await page.type('input[type="password"]', c.password);
  await page.keyboard.press("Enter");
  await sleep(3500);
}

async function clickText(page, selector, label) {
  const ok = await page.evaluate((sel, t) => {
    const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().includes(t));
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.click();
    return true;
  }, selector, label);
  if (!ok) console.warn("not found:", selector, label);
  await sleep(1200);
}

async function scrollToText(page, label, offset = 90) {
  await page.evaluate((t, off) => {
    const all = [...document.querySelectorAll("h1,h2,h3,h4,strong,p,span,button,label")];
    const el = all.find((e) => e.textContent.trim().startsWith(t));
    if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - off);
  }, label, offset);
  await sleep(1200);
}

async function shot(page, name) {
  await sleep(800);
  await page.screenshot({ path: `${out}/${name}.png` });
  console.log("saved", name);
}

async function buyer(page) {
  await login(page, "buyer");
  await shot(page, "01_properties");

  await clickText(page, "nav button, nav a", "Watchlist");
  await sleep(1500);
  await clickText(page, "button", "Bolingbroke Grove");
  await clickText(page, "button", "See times");
  await scrollToText(page, "£1,150,000", 40);
  await shot(page, "02_book_viewing");

  await page.goto(BASE + "/", { waitUntil: "networkidle2" });
  await sleep(2000);
  await clickText(page, "nav button, nav a", "Watchlist");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "03_watchlist");

  await clickText(page, "nav button, nav a", "Calendar");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "04_calendar");

  await clickText(page, "nav button, nav a", "Dashboard");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "05_dashboard");

  await clickText(page, "nav button, nav a", "Settings");
  await clickText(page, "button", "What you're looking for");
  await page.evaluate(() => {
    const cards = [...document.querySelectorAll("*")].filter(
      (e) => e.children.length < 40 && e.textContent.includes("Between the commons") && e.querySelector("button")
    );
    [...cards[cards.length - 1].querySelectorAll("button")].find((b) => b.textContent.trim() === "Edit").click();
  });
  await sleep(3500);
  // The search form's area picker (not the "Where you are" card above it).
  await scrollToText(page, "Tap the map", 260);
  await sleep(2500);
  await shot(page, "06_search_map");

  await page.evaluate(() => window.scrollTo(0, 0));
  await clickText(page, "button", "Cancel");
  await clickText(page, "button", "What you're looking for");
  await clickText(page, "button", "Your Buying Position");
  await scrollToText(page, "Your Buying Position", 40);
  await shot(page, "07_buying_position");

  // Where you are + which agents can see you (migrations 029, 030).
  await page.evaluate(() => window.scrollTo(0, 0));
  await clickText(page, "button", "Your Buying Position");
  await clickText(page, "button", "Where you are");
  await clickText(page, "button", "Which agents can see");
  await scrollToText(page, "Where you are", 40);
  await shot(page, "10_tell_agents");
}

async function agent(page) {
  await login(page, "agent", "/agent");
  await page.evaluate(() => window.scrollTo(0, 0));
  await clickText(page, "button", "saved in");
  await page.evaluate(() => window.scrollTo(0, 0));
  await shot(page, "08_agent_day");
  // Listings have their own tab now (bottom bar).
  await clickText(page, "nav button, .tab-bar button, button", "Listings");
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
  await shot(page, "09_agent_listing");
}

try {
  for (const fn of [buyer, agent]) {
    const page = await newPage();
    await fn(page);
    await page.close();
  }
} finally {
  await browser.close();
}
