import { useState } from "react";
import SearchCriteriaManager from "../components/SearchCriteriaManager";
import BuyerProfileSettings from "../components/BuyerProfileSettings";

function SettingsView({ user }) {
  const [refreshingCommutes, setRefreshingCommutes] = useState(false);
  const [refreshMessage, setRefreshMessage] = useState("");

  async function refreshAllCommutes() {
    setRefreshingCommutes(true);
    setRefreshMessage("");

    try {
      const response = await fetch("/api/refresh_commutes", {
        method: "POST",
      });

      const text = await response.text();

      let result = {};
      if (text) {
        result = JSON.parse(text);
      }

      if (!response.ok || result.success === false) {
        throw new Error(result.error || `Request failed with status ${response.status}`);
      }

      setRefreshMessage("Commute refresh complete. Reload the page to see updated commute times.");
    } catch (error) {
      console.error("Error refreshing commutes:", error);
      setRefreshMessage(error.message || "Could not refresh commutes.");
    }

    setRefreshingCommutes(false);
  }

  if (!user) {
    return (
      <section className="card">
        <div className="section-header">
          <h2>Settings</h2>
          <p>Please log in to manage your saved searches.</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="card">
        <div className="section-header">
          <h2>Saved Searches</h2>
          <p>Manage your saved property searches and alert sources.</p>
        </div>

        <SearchCriteriaManager user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Buyer Profile & Alerts</h2>
          <p>
            Add commute locations, choose your commute method, and manage email
            alerts for newly found properties.
          </p>
        </div>

        <BuyerProfileSettings user={user} />
      </section>

      <section className="card">
        <div className="section-header">
          <h2>Commute Data</h2>
          <p>
            Recalculate commute times for all saved properties after changing
            your work locations or travel preferences.
          </p>
        </div>

        <button
          type="button"
          className="primary-button"
          onClick={refreshAllCommutes}
          disabled={refreshingCommutes}
        >
          {refreshingCommutes ? "Refreshing Commutes..." : "Refresh All Commutes"}
        </button>

        {refreshMessage && <p className="form-message">{refreshMessage}</p>}
      </section>
    </>
  );
}

export default SettingsView;