import { MARKET_FILTERS, MARKET_SORTS } from "../utils/market";
import "./MarketSignals.css";

// Filter chips (with counts) + sort for a list of properties.
function MarketToolbar({ properties, filter, sort, onFilter, onSort }) {
  return (
    <div className="market-toolbar">
      {MARKET_FILTERS.map((item) => {
        const count = item.test ? properties.filter(item.test).length : properties.length;
        return (
          <button
            key={item.key}
            type="button"
            className={`market-chip${filter === item.key ? " active" : ""}`}
            onClick={() => onFilter(item.key)}
          >
            {item.label}
            <small>{count}</small>
          </button>
        );
      })}

      <label className="market-sort">
        Sort
        <select value={sort} onChange={(event) => onSort(event.target.value)}>
          {MARKET_SORTS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export default MarketToolbar;
