import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// First-run checklist for a new household, at the top of Properties. Each
// step ticks itself off from what's actually saved, and disappears when
// everything's done or the buyer hides it (remembered per household on this
// device).

const STEPS = [
  {
    id: "home",
    title: "Save your first home",
    text: "Paste a link from Rightmove, Zoopla or OnTheMarket. We fill in the details for you to check.",
    action: "Add a home",
  },
  {
    id: "search",
    title: "Tell us what you're looking for",
    text: "Postcodes, a distance from somewhere, or an area you draw. Agents' new listings that fit are sent to you.",
    action: "Set up a search",
    section: "searches",
  },
  {
    id: "commute",
    title: "Add the places you travel to",
    text: "Work or school, so every home shows the journey time.",
    action: "Add places",
    section: "commute",
  },
  {
    id: "position",
    title: "Share your buying position",
    text: "Mortgage agreed, nothing to sell? Agents take proceedable buyers more seriously.",
    action: "Add it",
    section: "position",
  },
  {
    id: "partner",
    title: "Invite your partner",
    text: "Optional. You'll share one list of homes, notes and calendar.",
    action: "Get the invite link",
    section: "household",
    optional: true,
  },
];

const hiddenKey = (householdId) => `gettingStartedHidden:${householdId}`;

function readHidden(householdId) {
  try {
    return localStorage.getItem(hiddenKey(householdId)) === "1";
  } catch {
    return false;
  }
}

async function loadProgress() {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const [household, homes, searches, profile, position] = await Promise.all([
    supabase.rpc("my_household"),
    supabase.from("properties").select("id", { count: "exact", head: true }),
    supabase.from("buyer_searches").select("id", { count: "exact", head: true }).eq("user_id", user.id),
    supabase.from("buyer_profiles").select("user_work_address, partner_work_address").maybeSingle(),
    supabase.from("buyer_positions").select("household_id").maybeSingle(),
  ]);
  if (household.error || !household.data) return null;

  return {
    householdId: household.data.id,
    isOriginal: household.data.is_original,
    done: {
      home: (homes.count || 0) > 0,
      search: (searches.count || 0) > 0,
      commute: Boolean(profile.data?.user_work_address || profile.data?.partner_work_address),
      position: Boolean(position.data),
      partner: (household.data.members || []).length > 1,
    },
  };
}

function GettingStarted({ refreshKey, onAddHome, onOpenSettings }) {
  const [progress, setProgress] = useState(null);
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    let cancelled = false;
    loadProgress()
      .then((result) => {
        if (cancelled || !result) return;
        setProgress(result);
        setHidden(readHidden(result.householdId));
      })
      .catch((error) => console.error("Could not load getting-started progress:", error));
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  if (!progress || hidden || progress.isOriginal) return null;

  const required = STEPS.filter((s) => !s.optional);
  const doneCount = required.filter((s) => progress.done[s.id]).length;
  if (doneCount === required.length) return null;

  function hide() {
    try {
      localStorage.setItem(hiddenKey(progress.householdId), "1");
    } catch {
      // Private browsing: it just shows again next time.
    }
    setHidden(true);
  }

  return (
    <section className="card getting-started" aria-labelledby="getting-started-title">
      <div className="section-header">
        <div>
          <h2 id="getting-started-title">Getting started</h2>
          <p>
            {doneCount} of {required.length} done. A few minutes now and the app does the
            watching for you.
          </p>
        </div>
        <button type="button" className="link-button" onClick={hide}>
          Hide
        </button>
      </div>

      <div className="getting-started-bar" aria-hidden="true">
        <span style={{ width: `${(doneCount / required.length) * 100}%` }} />
      </div>

      <ol className="getting-started-steps">
        {STEPS.map((step) => {
          const done = progress.done[step.id];
          return (
            <li key={step.id} className={done ? "done" : ""}>
              <span className="step-tick" aria-hidden="true">
                {done ? "✓" : ""}
              </span>
              <div className="step-text">
                <strong>
                  {step.title}
                  {done && <span className="visually-hidden"> (done)</span>}
                </strong>
                {!done && <p>{step.text}</p>}
              </div>
              {!done && (
                <button
                  type="button"
                  className={step.id === "home" ? "primary-button" : "secondary-button"}
                  onClick={() => (step.section ? onOpenSettings(step.section) : onAddHome())}
                >
                  {step.action}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export default GettingStarted;
