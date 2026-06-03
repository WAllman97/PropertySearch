import { useEffect, useState } from "react";

const emptyForm = {
  name: "",
  source: "rightmove",
  search_url: "",
  max_price: "",
  min_bedrooms: "",
  must_have_garden: false,
  exclude_flats: false,
  is_active: true,
};

function SearchCriteriaForm({ onSubmit, initialValues, onCancel }) {
  const [formData, setFormData] = useState(emptyForm);

  useEffect(() => {
    if (initialValues) {
      setFormData({
        name: initialValues.name || "",
        source: initialValues.source || "rightmove",
        search_url: initialValues.search_url || "",
        max_price: initialValues.max_price || "",
        min_bedrooms: initialValues.min_bedrooms || "",
        must_have_garden: initialValues.must_have_garden || false,
        exclude_flats: initialValues.exclude_flats || false,
        is_active: initialValues.is_active ?? true,
      });
    } else {
      setFormData(emptyForm);
    }
  }, [initialValues]);

  function handleChange(event) {
    const { name, value, type, checked } = event.target;

    setFormData((current) => ({
      ...current,
      [name]: type === "checkbox" ? checked : value,
    }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    await onSubmit({
      ...formData,
      max_price: formData.max_price ? Number(formData.max_price) : null,
      min_bedrooms: formData.min_bedrooms
        ? Number(formData.min_bedrooms)
        : null,
    });

    if (!initialValues) {
      setFormData(emptyForm);
    }
  }

  return (
    <form className="search-criteria-form" onSubmit={handleSubmit}>
      <h3>{initialValues ? "Edit Search" : "Add New Search"}</h3>

      <div className="form-group">
        <label htmlFor="name">Search name</label>
        <input
          id="name"
          name="name"
          type="text"
          value={formData.name}
          onChange={handleChange}
          placeholder="e.g. Battersea houses"
          required
        />
      </div>

      <div className="form-group">
        <label htmlFor="source">Source</label>
        <select
          id="source"
          name="source"
          value={formData.source}
          onChange={handleChange}
        >
          <option value="rightmove">Rightmove</option>
          <option value="zoopla">Zoopla</option>
          <option value="onthemarket">OnTheMarket</option>
        </select>
      </div>

      <div className="form-group">
        <label htmlFor="search_url">Search URL</label>
        <input
          id="search_url"
          name="search_url"
          type="url"
          value={formData.search_url}
          onChange={handleChange}
          placeholder="Paste your Rightmove search URL"
          required
        />
      </div>

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="max_price">Max price</label>
          <input
            id="max_price"
            name="max_price"
            type="number"
            value={formData.max_price}
            onChange={handleChange}
            placeholder="850000"
            min="0"
          />
        </div>

        <div className="form-group">
          <label htmlFor="min_bedrooms">Minimum bedrooms</label>
          <input
            id="min_bedrooms"
            name="min_bedrooms"
            type="number"
            value={formData.min_bedrooms}
            onChange={handleChange}
            placeholder="3"
            min="0"
          />
        </div>
      </div>

      <div className="checkbox-group">
        <label>
          <input
            name="must_have_garden"
            type="checkbox"
            checked={formData.must_have_garden}
            onChange={handleChange}
          />
          Must have garden
        </label>

        <label>
          <input
            name="exclude_flats"
            type="checkbox"
            checked={formData.exclude_flats}
            onChange={handleChange}
          />
          Exclude flats
        </label>

        <label>
          <input
            name="is_active"
            type="checkbox"
            checked={formData.is_active}
            onChange={handleChange}
          />
          Active search
        </label>
      </div>

      <div className="button-row">
        <button type="submit" className="primary-button">
          {initialValues ? "Save Changes" : "Save Search"}
        </button>

        {initialValues && (
          <button type="button" className="secondary-button" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

export default SearchCriteriaForm;