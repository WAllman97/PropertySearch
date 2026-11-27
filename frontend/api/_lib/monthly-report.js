// Monthly "what ViewPal did for you" email per branch (migration 040).
// Actions on /api/agent-signup (Vercel allows 12 routes and we're at 12):
//
//   GitHub workflow monthly-value-report.yml, on the 1st (and the 2nd and
//   3rd to catch up), with GitHub's own signed token for that workflow
//   (_lib/github-oidc.js; no shared secret):
//     { action: "monthly_report_run", month? }  -> { month, done, remaining }
//        works through last month's branches for a few seconds at a time;
//        the workflow calls again until remaining is 0
//   admin (signed in, app_admins):
//     { action: "monthly_report_preview", month?, branchKey? }
//        -> { month, branches, branchKey, subject, html, figures }
//     { action: "monthly_report_test", month?, branchKey }
//        sends that branch's email to the admin's own address
//
// Each branch is claimed in branch_monthly_reports before anything is sent,
// so a retry never sends a second copy. Branches with nothing to report get
// 'no_activity' instead of an email; /admin lists them as a churn risk.
import { requireUser, supabaseAdmin } from "./household.js";
import { appBaseUrl } from "./booking.js";
import { emailLayout, escapeHtml, sendEmail } from "./email.js";
import { unsubscribeFooter, unsubscribeLinks } from "./email-prefs.js";
import { londonParts, londonToUtc } from "./time.js";
import { ESTIMATES, hoursAndMinutes, reportRows } from "./report-rows.js";
import { verifyGithubWorkflow } from "./github-oidc.js";

const CONTACT_EMAIL = "hello@viewpal.app";
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
// Stop starting new branches after this long, so one call stays inside
// Vercel's time limit. The workflow calls again for the rest.
const TIME_BUDGET_MS = 7000;
// A claim this old was left by a run that died mid-send: take it over.
const STALE_CLAIM_MS = 30 * 60000;

const button = (href, label) =>
  `<a href="${escapeHtml(href)}" style="display:inline-block;background:#223a33;color:#ffffff;text-decoration:none;font-weight:bold;font-size:15px;padding:12px 22px;border-radius:10px;">${escapeHtml(label)}</a>`;

// "YYYY-MM" of last month in London, or the month asked for.
export function monthKey(asked, now = new Date()) {
  if (typeof asked === "string" && MONTH_RE.test(asked)) return asked;
  const { year, month } = londonParts(now);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${y}-${String(m).padStart(2, "0")}`;
}

// London midnight on the 1st of the month to London midnight on the 1st of
// the next, as instants.
export function monthRange(key) {
  const [y, m] = key.split("-").map(Number);
  const from = londonToUtc(y, m, 1, 0, 0);
  const to = m === 12 ? londonToUtc(y + 1, 1, 1, 0, 0) : londonToUtc(y, m + 1, 1, 0, 0);
  return { from, to, date: `${key}-01`, name: new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }) };
}


// Every agent, grouped into branches: { key, label, agents[] }. A branch is
// a sign-up code, or one agent without a code. Cancelled branches, and
// trial agents whose trial ended before the month began, are left out.
async function loadBranches(range) {
  const agents = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabaseAdmin
      .from("agents")
      .select("user_id, name, email, agency, branch, signup_code, trial_ends_at")
      .order("user_id")
      .range(from, from + 999);
    if (error) throw error;
    agents.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const [{ data: codes }, { data: billing }] = await Promise.all([
    supabaseAdmin.from("agent_invite_codes").select("code, agency, branch"),
    supabaseAdmin.from("branch_billing").select("branch_key, plan"),
  ]);
  const codeOf = new Map((codes || []).map((c) => [c.code, c]));
  const planOf = new Map((billing || []).map((b) => [b.branch_key, b.plan]));

  const branches = new Map();
  for (const agent of agents) {
    if (!agent.signup_code && agent.trial_ends_at && new Date(agent.trial_ends_at) < range.from) continue;
    const key = agent.signup_code || `agent:${agent.user_id}`;
    if (planOf.get(key) === "cancelled") continue;
    if (!branches.has(key)) {
      const code = codeOf.get(agent.signup_code);
      const agency = code?.agency || agent.agency || "";
      const branch = code?.branch || agent.branch || "";
      branches.set(key, { key, label: [agency, branch].filter(Boolean).join(" · ") || agent.name, agents: [] });
    }
    branches.get(key).agents.push(agent);
  }
  return [...branches.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function figuresFor(key, range) {
  const { data, error } = await supabaseAdmin.rpc("branch_report", {
    p_branch: key,
    p_from: range.from.toISOString(),
    p_to: range.to.toISOString(),
  });
  if (error) throw error;
  return data;
}

// Who at the branch gets it, with their unsubscribe token. Creates the
// preferences row (everything on) for anyone who hasn't got one.
async function recipientsOf(agents) {
  const withEmail = agents.filter((a) => a.email);
  if (!withEmail.length) return [];
  const ids = withEmail.map((a) => a.user_id);
  await supabaseAdmin
    .from("email_preferences")
    .upsert(ids.map((id) => ({ user_id: id })), { onConflict: "user_id", ignoreDuplicates: true });
  const { data, error } = await supabaseAdmin
    .from("email_preferences")
    .select("user_id, unsubscribe_token, monthly_report")
    .in("user_id", ids);
  if (error) throw error;
  const prefOf = new Map((data || []).map((p) => [p.user_id, p]));
  return withEmail
    .filter((a) => prefOf.get(a.user_id)?.monthly_report !== false)
    .map((a) => ({ ...a, token: prefOf.get(a.user_id)?.unsubscribe_token || null }));
}

export function buildReportEmail({ branch, figures, range, base, unsubscribe, recipientName }) {
  const first = String(recipientName || "").trim().split(/\s+/)[0];
  const saved = figures.minutes_saved || 0;
  const headline = saved ? `About ${hoursAndMinutes(saved)} saved in ${range.name.split(" ")[0]}` : `Your ${range.name.split(" ")[0]} on ViewPal`;
  const rows = reportRows(figures)
    .map(
      (r) => `<tr>
        <td style="padding:8px 12px 8px 0;font-size:22px;font-weight:bold;color:#223a33;text-align:right;vertical-align:top;white-space:nowrap;">${r.n.toLocaleString("en-GB")}</td>
        <td style="padding:8px 0;font-size:15px;color:#374151;vertical-align:top;">${escapeHtml(r.label)}</td>
      </tr>`
    )
    .join("");
  const team = figures.agents > 1 ? ` across ${figures.agents} of you` : "";
  const html = emailLayout(
    headline,
    `<p style="margin:0 0 12px;font-size:15px;">${first ? `Hi ${escapeHtml(first)},` : "Hi,"}</p>
     <p style="margin:0 0 16px;font-size:15px;">Here's what ViewPal did for ${escapeHtml(branch.label)} in ${escapeHtml(range.name)}${team}.</p>
     <table role="presentation" style="border-collapse:collapse;margin:0 0 20px;">${rows}</table>
     <p style="margin:0 0 20px;">${button(`${base}/agent`, "Open your dashboard")}</p>
     <p style="margin:0 0 8px;font-size:14px;color:#4b5563;">Questions, or something you'd like it to do? Just reply.</p>
     <p style="margin:16px 0 0;font-size:12px;color:#9a9186;">${escapeHtml(ESTIMATES)}</p>
     ${unsubscribeFooter(unsubscribe, "monthly_report")}`
  );
  return { subject: `Your ViewPal month: ${range.name}`, html };
}

// --- Monthly run -------------------------------------------------------------------

// Only the monthly-value-report.yml workflow on main, proved by GitHub's
// signed token. The audience must match the workflow's request.
export const REPORT_AUDIENCE = "viewpal-monthly-report";
const fromOurWorkflow = (req) =>
  verifyGithubWorkflow(req, { workflow: "monthly-value-report.yml", audience: REPORT_AUDIENCE });

// Take a branch for this month: a new row, or a failed one, or a claim a
// dead run left behind. -> true if this call should do it.
async function claim(key, date, existing) {
  const now = new Date().toISOString();
  if (!existing) {
    const { error } = await supabaseAdmin
      .from("branch_monthly_reports")
      .insert({ branch_key: key, month: date, status: "claimed", updated_at: now });
    if (!error) return true;
    if (error.code === "23505") return false; // another run took it
    throw error;
  }
  const stale = existing.status === "claimed" && Date.now() - new Date(existing.updated_at).getTime() > STALE_CLAIM_MS;
  if (existing.status !== "failed" && !stale) return false;
  const { data, error } = await supabaseAdmin
    .from("branch_monthly_reports")
    .update({ status: "claimed", updated_at: now })
    .eq("branch_key", key)
    .eq("month", date)
    .eq("updated_at", existing.updated_at)
    .select("branch_key");
  if (error) throw error;
  return Boolean(data?.length);
}

async function finish(key, date, status, figures, recipients = 0) {
  const { error } = await supabaseAdmin
    .from("branch_monthly_reports")
    .update({ status, figures, recipients, updated_at: new Date().toISOString() })
    .eq("branch_key", key)
    .eq("month", date);
  if (error) console.error(`monthly report: could not record ${key} as ${status}:`, error);
}

async function sendBranch(branch, range, base) {
  const figures = await figuresFor(branch.key, range);
  if (!figures?.active) return finish(branch.key, range.date, "no_activity", figures);
  const recipients = await recipientsOf(branch.agents);
  if (!recipients.length) return finish(branch.key, range.date, "no_recipients", figures);

  let sent = 0;
  for (const person of recipients) {
    const unsubscribe = unsubscribeLinks(base, person.token, "monthly_report");
    const { subject, html } = buildReportEmail({ branch, figures, range, base, unsubscribe, recipientName: person.name });
    const result = await sendEmail({ to: person.email, subject, html, replyTo: CONTACT_EMAIL, unsubscribe }).catch((error) => {
      console.error(`monthly report to ${branch.key} failed:`, error);
      return { sent: false };
    });
    if (result.sent) sent++;
  }
  // Anyone sent: done (a retry would send the others a second copy).
  return finish(branch.key, range.date, sent ? "sent" : "failed", figures, sent);
}

export async function handleMonthlyReportRun(req, res, body) {
  if (!(await fromOurWorkflow(req))) return res.status(404).json({ error: "Not found" });
  const started = Date.now();
  const key = monthKey(body.month);
  const range = monthRange(key);
  const base = appBaseUrl(req);

  try {
    const branches = await loadBranches(range);
    const { data: rows, error } = await supabaseAdmin
      .from("branch_monthly_reports")
      .select("branch_key, status, updated_at")
      .eq("month", range.date);
    if (error) throw error;
    const existing = new Map((rows || []).map((r) => [r.branch_key, r]));

    let done = 0;
    let remaining = 0;
    for (const branch of branches) {
      const row = existing.get(branch.key);
      if (row && row.status !== "failed" && row.status !== "claimed") continue;
      if (Date.now() - started > TIME_BUDGET_MS) {
        remaining++;
        continue;
      }
      if (!(await claim(branch.key, range.date, row))) {
        // Someone else has it (or a fresh claim): only count it if it may
        // still need doing.
        if (row?.status === "claimed") remaining++;
        continue;
      }
      try {
        await sendBranch(branch, range, base);
      } catch (error) {
        console.error(`monthly report for ${branch.key} failed:`, error);
        await finish(branch.key, range.date, "failed", null);
      }
      done++;
    }
    return res.status(200).json({ month: key, branches: branches.length, done, remaining });
  } catch (error) {
    console.error("monthly report run failed:", error);
    return res.status(500).json({ error: "Monthly report run failed" });
  }
}

// --- Admin preview and test ----------------------------------------------------------

async function requireAdmin(req, res) {
  const user = await requireUser(req, res);
  if (!user) return null;
  const { data: admin } = await supabaseAdmin.from("app_admins").select("user_id").eq("user_id", user.id).maybeSingle();
  if (!admin) {
    res.status(404).json({ error: "Not found" });
    return null;
  }
  return user;
}

async function previewFor(req, body) {
  const key = monthKey(body.month);
  const range = monthRange(key);
  const branches = await loadBranches(range);
  const branch = branches.find((b) => b.key === body.branchKey) || branches[0];
  const list = branches.map((b) => ({ key: b.key, label: b.label }));
  if (!branch) return { month: key, branches: list };
  const figures = await figuresFor(branch.key, range);
  const base = appBaseUrl(req);
  const email = buildReportEmail({
    branch,
    figures,
    range,
    base,
    // A sample link, so the footer shows as it will for agents.
    unsubscribe: unsubscribeLinks(base, "00000000-0000-0000-0000-000000000000", "monthly_report"),
    recipientName: branch.agents[0]?.name,
  });
  return { month: key, branches: list, branchKey: branch.key, branch, figures, ...email };
}

export async function handleMonthlyReportPreview(req, res, body) {
  if (!(await requireAdmin(req, res))) return;
  try {
    const { branch: _branch, ...preview } = await previewFor(req, body);
    return res.status(200).json(preview);
  } catch (error) {
    console.error("monthly report preview failed:", error);
    return res.status(500).json({ error: "Couldn't build the preview. Has migration 040 been run?" });
  }
}

export async function handleMonthlyReportTest(req, res, body) {
  const user = await requireAdmin(req, res);
  if (!user) return;
  if (!user.email) return res.status(400).json({ error: "Your login has no email address." });
  try {
    const preview = await previewFor(req, body);
    if (!preview.html) return res.status(404).json({ error: "No branches yet." });
    const { sent } = await sendEmail({ to: user.email, subject: `[Test] ${preview.subject}`, html: preview.html });
    if (!sent) return res.status(502).json({ error: "The email didn't send. Check the Resend key." });
    return res.status(200).json({ success: true, to: user.email });
  } catch (error) {
    console.error("monthly report test failed:", error);
    return res.status(500).json({ error: "Couldn't send the test. Has migration 040 been run?" });
  }
}
