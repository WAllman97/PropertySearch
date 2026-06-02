function HistoryView({ records, filterDays, setFilterDays, onDeleteRecord, onClearAll }) {
  const cutoffDate = new Date()
  if (filterDays !== 365) {
    cutoffDate.setDate(cutoffDate.getDate() - filterDays)
  } else {
    cutoffDate.setFullYear(cutoffDate.getFullYear() - 100)
  }

  const filteredRecords = records.filter((record) => {
    if (!record.createdAt) return true
    return new Date(record.createdAt) >= cutoffDate
  })

  return (
    <div className="history-view">
      <section className="card">
        <div className="section-header">
          <h2>History</h2>
          <p>Review your stored items and manage the data from here.</p>
        </div>

        <div className="history-controls">
          <label htmlFor="filterDays">Show last:</label>
          <select id="filterDays" value={filterDays} onChange={(e) => setFilterDays(Number(e.target.value))}>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={365}>All</option>
          </select>
        </div>

        <div className="record-list">
          {filteredRecords.length === 0 ? (
            <p className="muted-text">No records match this range. Add a record to begin.</p>
          ) : (
            filteredRecords.map((record) => (
              <div key={record.id} className="record-item">
                <div>
                  <strong>{record.title || 'Untitled record'}</strong>
                  <p>{record.details || 'No details provided.'}</p>
                </div>
                <button className="delete-button" onClick={() => onDeleteRecord(record.id)}>
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </section>

      <section className="card settings-card">
        <h3>Data management</h3>
        <button onClick={onClearAll} className="btn-danger">
          Clear all records
        </button>
      </section>
    </div>
  )
}

export default HistoryView
