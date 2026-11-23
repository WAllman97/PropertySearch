import { useEffect, useState } from "react";
import { supabase } from "../lib/supabaseClient";

// The agents this household deals with, and what each one may do (migration
// 030). Your details are never shared with agents you haven't dealt with;
// here you can stop any one of them seeing your buying position and status,
// or sending you homes. Your bookings and offers with them still work.

function contactLine(agent) {
  const parts = [];
  if (agent.homes_sent) parts.push(`${agent.homes_sent} home${agent.homes_sent === 1 ? "" : "s"} sent`);
  if (agent.viewings) parts.push(`${agent.viewings} viewing${agent.viewings === 1 ? "" : "s"}`);
  if (agent.offers) parts.push(`${agent.offers} offer${agent.offers === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function AgentControls({ householdId }) {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    supabase.rpc("my_agents").then(({ data, error: loadError }) => {
      if (loadError) {
        setError("Agent controls aren't switched on yet (database migration 030).");
        return;
      }
      setAgents(data || []);
    });
  }, []);

  async function toggle(agent, key) {
    const next = { share_info: agent.share_info, send_homes: agent.send_homes, [key]: !agent[key] };
    const update = (values) =>
      setAgents((list) => list.map((a) => (a.agent_id === agent.agent_id ? { ...a, ...values } : a)));
    update(next);
    const { error: saveError } = await supabase.from("buyer_agent_prefs").upsert(
      { household_id: householdId, agent_id: agent.agent_id, ...next, updated_at: new Date().toISOString() },
      { onConflict: "household_id,agent_id" }
    );
    if (saveError) {
      update({ share_info: agent.share_info, send_homes: agent.send_homes });
      setError("Couldn't save that. Please try again.");
    }
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

  return (
    <div className="agent-controls">
      {error && <p className="booking-error">{error}</p>}
      <ul>
        {agents.map((agent) => (
          <li key={agent.agent_id}>
            <div>
              <strong>{agent.name}</strong>
              <span className="muted"> · {[agent.agency, agent.branch].filter(Boolean).join(", ")}</span>
              <p className="muted small">{contactLine(agent)}</p>
            </div>
            <label className="agent-auto">
              <input type="checkbox" checked={agent.share_info} onChange={() => toggle(agent, "share_info")} />
              Can see my buying position and search status
            </label>
            <label className="agent-auto">
              <input type="checkbox" checked={agent.send_homes} onChange={() => toggle(agent, "send_homes")} />
              Can send me new homes
            </label>
          </li>
        ))}
      </ul>
      <p className="muted small">
        Agents only see you once you've dealt with them, and never see what you do with other agents. Turning these
        off doesn't cancel your viewings or offers.
      </p>
    </div>
  );
}

export default AgentControls;
