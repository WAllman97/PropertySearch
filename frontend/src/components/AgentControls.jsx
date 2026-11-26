import { useEffect, useMemo, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// The agents this household deals with, and what each one may do (migration
// 030). Your details are never shared with agents you haven't dealt with;
// here you can stop any one of them seeing your buying position and status,
// or sending you homes. Your bookings and offers with them still work.
//
// Laid out as a table (one row per agent, a switch per column) so it stays
// readable with lots of agents: newest first, the latest few shown, a search
// box once the list is long, and "all agents" switches at the bottom.

const SHOW_FIRST = 6;
const SEARCH_FROM = 8;
const COLUMNS = [
  { key: "share_info", label: "Sees my position", long: "Can see my buying position and search status" },
  { key: "send_homes", label: "Sends me homes", long: "Can send me new homes" },
];

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function contactLine(agent) {
  const parts = [];
  if (agent.homes_sent) parts.push(plural(agent.homes_sent, "home") + " sent");
  if (agent.viewings) parts.push(plural(agent.viewings, "viewing"));
  if (agent.offers) parts.push(plural(agent.offers, "offer"));
  return parts.join(" · ");
}

function sinceLabel(iso) {
  if (!iso) return "";
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  if (days < 35) return plural(Math.round(days / 7), "week") + " ago";
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

function Switch({ on, onChange, label, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      className={`agent-switch${on ? " on" : ""}`}
      onClick={onChange}
      disabled={disabled}
    >
      <span className="agent-switch-knob" />
    </button>
  );
}

function AgentControls({ householdId }) {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    supabase.rpc("my_agents").then(({ data, error: loadError }) => {
      if (loadError) {
        setError("Agent controls aren't switched on yet (database migration 030).");
        return;
      }
      setAgents(data || []);
    });
  }, []);

  const filtered = useMemo(() => {
    if (!agents) return [];
    const q = query.trim().toLowerCase();
    if (!q) return agents;
    return agents.filter((a) => [a.name, a.agency, a.branch].some((v) => v && v.toLowerCase().includes(q)));
  }, [agents, query]);

  // Save new settings for some agents; put the old ones back if it fails.
  async function save(changes) {
    const before = agents;
    const byId = new Map(changes.map((c) => [c.agent_id, c]));
    setAgents((list) => list.map((a) => (byId.has(a.agent_id) ? { ...a, ...byId.get(a.agent_id) } : a)));
    setError("");
    const now = new Date().toISOString();
    const { error: saveError } = await supabase.from("buyer_agent_prefs").upsert(
      changes.map((c) => ({ household_id: householdId, ...c, updated_at: now })),
      { onConflict: "household_id,agent_id" }
    );
    if (saveError) {
      setAgents(before);
      setError("Couldn't save that. Please try again.");
    }
  }

  function toggle(agent, key) {
    save([{ agent_id: agent.agent_id, share_info: agent.share_info, send_homes: agent.send_homes, [key]: !agent[key] }]);
  }

  async function setAll(key, value) {
    setBusy(true);
    await save(
      agents
        .filter((a) => a[key] !== value)
        .map((a) => ({ agent_id: a.agent_id, share_info: a.share_info, send_homes: a.send_homes, [key]: value }))
    );
    setBusy(false);
  }

  if (error && !agents) return <p className="muted">{error}</p>;
  if (!agents) return <p className="muted">Loading...</p>;
  if (!agents.length) {
    return (
      <p className="muted">
        No agents yet. When an agent sends you a home, or you book a viewing or make an offer, they'll appear here.
      </p>
    );
  }

  const searching = query.trim() !== "";
  const visible = showAll || searching ? filtered : filtered.slice(0, SHOW_FIRST);
  const hidden = filtered.length - visible.length;

  return (
    <div className="agent-controls">
      {error && <p className="booking-error">{error}</p>}

      {agents.length >= SEARCH_FROM && (
        <input
          id="agent-controls-search"
          type="search"
          className="agent-controls-search"
          placeholder="Find an agent or agency"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find an agent or agency"
        />
      )}

      <div className="agent-table" role="table" aria-label="What each agent can do">
        <div className="agent-row agent-head" role="row">
          <span role="columnheader">Agent</span>
          {COLUMNS.map((c) => (
            <span role="columnheader" key={c.key} title={c.long}>
              {c.label}
            </span>
          ))}
        </div>

        {visible.map((agent) => (
          <div className="agent-row" role="row" key={agent.agent_id}>
            <div className="agent-who" role="cell">
              <strong>{agent.name}</strong>
              <span className="muted">{[agent.agency, agent.branch].filter(Boolean).join(", ")}</span>
              <span className="muted small">
                {[contactLine(agent), sinceLabel(agent.last_contact)].filter(Boolean).join(" · ")}
              </span>
            </div>
            {COLUMNS.map((c) => (
              <div role="cell" key={c.key}>
                <Switch on={agent[c.key]} onChange={() => toggle(agent, c.key)} label={`${agent.name}: ${c.long}`} />
              </div>
            ))}
          </div>
        ))}

        {searching && !filtered.length && <p className="muted agent-empty">No agents match "{query.trim()}".</p>}

        {agents.length > 1 && !searching && (
          <div className="agent-row agent-all" role="row">
            <span role="cell">All agents</span>
            {COLUMNS.map((c) => {
              const anyOn = agents.some((a) => a[c.key]);
              return (
                <div role="cell" key={c.key}>
                  <button
                    type="button"
                    className="link-button"
                    disabled={busy}
                    onClick={() => setAll(c.key, !anyOn)}
                    title={`${anyOn ? "Turn off" : "Turn on"} for every agent: ${c.long.toLowerCase()}`}
                  >
                    {anyOn ? "Turn off" : "Turn on"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {hidden > 0 && (
        <button type="button" className="link-button" onClick={() => setShowAll(true)}>
          Show all {agents.length} agents
        </button>
      )}
      {showAll && !searching && agents.length > SHOW_FIRST && (
        <button type="button" className="link-button" onClick={() => setShowAll(false)}>
          Show fewer
        </button>
      )}

      <p className="muted small">
        Agents only see you once you've dealt with them, and never see what you do with other agents. Turning these
        off doesn't cancel your viewings or offers.
      </p>
    </div>
  );
}

export default AgentControls;
