function DashboardView({ records, onAddRecord }) {
  return (
    <div className="dashboard-view">
      <section className="card">
        <div className="section-header">
          <h2>Dashboard</h2>
          <p>Use this section to display the most important metrics for your app.</p>
        </div>

        <div className="dashboard-grid">
          <div className="summary-card">
            <h3>Record count</h3>
            <strong>{records.length}</strong>
            <p>Track totals for the items that matter to your app.</p>
          </div>

          <div className="summary-card">
            <h3>Recent activity</h3>
            <p>{records.length === 0 ? 'No recent items yet.' : 'See your latest changes in History.'}</p>
          </div>

          <div className="summary-card">
            <h3>Next action</h3>
            <button onClick={onAddRecord}>Add demo record</button>
          </div>
        </div>
      </section>
    </div>
  )
}

export default DashboardView
