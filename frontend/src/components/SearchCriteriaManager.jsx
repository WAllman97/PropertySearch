import { useEffect, useState } from "react";
import SearchCriteriaForm from "./SearchCriteriaForm";

import {
  getSearchCriteria,
  createSearchCriteria,
  updateSearchCriteria,
  deleteSearchCriteria,
} from "../services/searchCriteriaService";

function SearchCriteriaManager({ user }) {
  const [criteria, setCriteria] = useState([]);
  const [editingCriteria, setEditingCriteria] = useState(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");

  useEffect(() => {
    loadCriteria();
  }, []);

  async function loadCriteria() {
    setLoading(true);
    setMessage("");

    try {
      const data = await getSearchCriteria(user.id);
      setCriteria(data);
    } catch (error) {
      setMessage(error.message);
    }

    setLoading(false);
  }

  async function handleCreate(formData) {
    setMessage("");

    try {
      await createSearchCriteria({
        ...formData,
        user_id: user.id,
      });

      setMessage("Search saved.");
      loadCriteria();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleUpdate(formData) {
    setMessage("");

    try {
      await updateSearchCriteria(editingCriteria.id, formData);

      setEditingCriteria(null);
      setMessage("Search updated.");
      loadCriteria();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleToggleActive(item) {
    setMessage("");

    try {
      await updateSearchCriteria(item.id, {
        is_active: !item.is_active,
      });

      loadCriteria();
    } catch (error) {
      setMessage(error.message);
    }
  }

  async function handleDelete(item) {
    const confirmed = window.confirm(
      `Delete "${item.name}"? This cannot be undone.`
    );

    if (!confirmed) return;

    setMessage("");

    try {
      await deleteSearchCriteria(item.id);

      if (editingCriteria?.id === item.id) {
        setEditingCriteria(null);
      }

      setMessage("Search deleted.");
      loadCriteria();
    } catch (error) {
      setMessage(error.message);
    }
  }

  return (
    <div className="search-criteria-manager">
      <SearchCriteriaForm
        initialValues={editingCriteria}
        onSubmit={editingCriteria ? handleUpdate : handleCreate}
        onCancel={() => setEditingCriteria(null)}
      />

      {message && <p className="form-message">{message}</p>}

      <div className="section-header compact">
        <h3>Saved Searches</h3>
        <p>
          These searches will later feed the automated property ingestion
          workflow.
        </p>
      </div>

      {loading ? (
        <p>Loading searches...</p>
      ) : criteria.length === 0 ? (
        <p>No saved searches yet.</p>
      ) : (
        <div className="search-criteria-list">
          {criteria.map((item) => (
            <div key={item.id} className="search-criteria-card">
              <div>
                <h4>{item.name}</h4>
                <p className="muted">{item.source}</p>

                <p>
                  {item.max_price
                    ? `£${item.max_price.toLocaleString()}`
                    : "No max price"}
                  {" · "}
                  {item.min_bedrooms
                    ? `${item.min_bedrooms}+ beds`
                    : "Any bedrooms"}
                </p>

                <p>
                  {item.must_have_garden ? "Garden required" : "Garden optional"}
                  {" · "}
                  {item.exclude_flats ? "Flats excluded" : "Flats included"}
                </p>

                <a
                  href={item.search_url}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open search
                </a>
              </div>

              <div className="search-card-actions">
                <label>
                  <input
                    type="checkbox"
                    checked={item.is_active}
                    onChange={() => handleToggleActive(item)}
                  />
                  Active
                </label>

                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => setEditingCriteria(item)}
                >
                  Edit
                </button>

                <button
                  type="button"
                  className="danger-button"
                  onClick={() => handleDelete(item)}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default SearchCriteriaManager;