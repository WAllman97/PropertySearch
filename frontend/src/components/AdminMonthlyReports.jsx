import { useCallback, useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";
import { postAuthed } from "../lib/api";
import { londonParts } from "../../api/_lib/time.js";
import { hoursAndMinutes } from "../../api/_lib/report-rows.js";

// /admin -> Monthly reports (migration 040): who got last month's "what
// ViewPal did for you" email, which branches had nothing to report (churn
// risk: no email went), a preview of any branch's email, and a test send to
// yourself. The emails go on the 1st (workflow monthly-value-report.yml).

const STATUS = {
  sent: "Sent",
  no_activity: "No activity",
  no_recipients: "Nobody to email",
  failed: "Failed (retried next run)",
  claimed: "Sending",
};

function lastMonth() {
  const { year, month } = londonParts(new Date());
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

async function api(body) {
  const response = await postAuthed("/api/agent-signup", body);
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error || "Something went wrong");
  return result;
}

export default function AdminMonthlyReports() {
  const [month, setMonth] = useState(lastMonth);
  const [rows, setRows] = useState(null);
  const [rowsError, setRowsError] = useState("");
  const [preview, setPreview] = useState(null);
  const [branchKey, setBranchKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const loadRows = useCallback(async () => {
    setRowsError("");
    const { data, error } = await supabase.rpc("admin_branch_reports", { p_month: `${month}-01` });
    if (error) {
      setRows([]);
      setRowsError("Couldn't load reports. Has migration 040 been run?");
    } else setRows(data || []);
  }, [month]);

  const loadPreview = useCallback(async () => {
    setMessage("");
    try {
      const result = await api({ action: "monthly_report_preview", month, branchKey: branchKey || undefined });
      setPreview(result);
      if (result.branchKey && result.branchKey !== branchKey) setBranchKey(result.branchKey);
    } catch (error) {
      setPreview({ error: error.message });
    }
  }, [month, branchKey]);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  useEffect(() => {
    loadPreview();
  }, [loadPreview]);

  async function sendTest() {
    setBusy(true);
    setMessage("");
    try {
      const { to } = await api({ action: "monthly_report_test", month, branchKey });
      setMessage(`Test sent to ${to}.`);
    } catch (error) {
      setMessage(error.message);
    }
    setBusy(false);
  }

  const quiet = (rows || []).filter((r) => r.status === "no_activity");
  const sent = (rows || []).filter((r) => r.status === "sent");

  return (
    <section className="card admin-reports">
      <div className="section-header">
        <div>
          <h2>Monthly reports</h2>
          <p>
            Each branch gets a "what ViewPal did for you" email on the 1st for the month before.
            Branches with nothing to report get no email and show here as a churn risk.
          </p>
        </div>
        <label className="admin-reports-month">
          Month
          <input type="month" value={month} onChange={(event) => event.target.value && setMonth(event.target.value)} />
        </label>
      </div>

      {rowsError && <p className="booking-error">{rowsError}</p>}
      {rows && !rowsError && !rows.length && (
        <p className="muted">Nothing sent for this month yet. The emails go out on the 1st.</p>
      )}
      {rows && rows.length > 0 && (
        <>
          <p>
            {sent.length} branch{sent.length === 1 ? "" : "es"} emailed.{" "}
            {quiet.length ? (
              <span className="admin-flag">
                {quiet.length} with no activity: worth a call.
              </span>
            ) : (
              "Every branch had activity."
            )}
          </p>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>Branch</th>
                  <th>Report</th>
                  <th className="num">Viewings booked</th>
                  <th className="num">Homes sent</th>
                  <th className="num">Saved</th>
                  <th className="num">Emails</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.branch_key} className={r.status === "no_activity" ? "admin-row-risk" : ""}>
                    <td>{[r.agency, r.branch].filter(Boolean).join(" · ") || r.branch_key}</td>
                    <td>{r.status === "no_activity" ? <span className="admin-flag">Churn risk</span> : STATUS[r.status] || r.status}</td>
                    <td className="num">{r.figures?.bookings ?? "–"}</td>
                    <td className="num">{r.figures?.homes_sent ?? "–"}</td>
                    <td className="num">{r.figures?.minutes_saved ? hoursAndMinutes(r.figures.minutes_saved) : "–"}</td>
                    <td className="num">{r.recipients || "–"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="admin-reports-preview-title">Preview</h3>
      {preview?.error && <p className="booking-error">{preview.error}</p>}
      {preview && !preview.error && !preview.branches?.length && <p className="muted">No branches yet.</p>}
      {preview?.branches?.length > 0 && (
        <>
          <div className="admin-reports-controls">
            <select value={branchKey} onChange={(event) => setBranchKey(event.target.value)} aria-label="Branch">
              {preview.branches.map((b) => (
                <option key={b.key} value={b.key}>
                  {b.label}
                </option>
              ))}
            </select>
            <button type="button" className="secondary-button" onClick={sendTest} disabled={busy || !preview.html}>
              {busy ? "Sending..." : "Send test to me"}
            </button>
            {preview.figures && !preview.figures.active && (
              <span className="admin-flag">No activity this month: this branch wouldn't be emailed.</span>
            )}
          </div>
          {message && <p role="status">{message}</p>}
          {preview.html && (
            <>
              <p className="muted">Subject: {preview.subject}</p>
              <iframe className="admin-reports-frame" title="Email preview" srcDoc={preview.html} sandbox="" />
            </>
          )}
        </>
      )}
    </section>
  );
}
