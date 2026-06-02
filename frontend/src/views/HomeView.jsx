function HomeView({ recordsCount, onAddRecord }) {
  return (
    <section className="card">
      <div className="section-header">
        <h2>Welcome to the Web App Template</h2>
        <p>This starter provides a lightweight app structure that is easy to customize.</p>
      </div>

      <div className="home-grid">
        <div className="home-card">
          <h3>What this template includes</h3>
          <ul>
            <li>Navigation layout with dashboard, history, and settings.</li>
            <li>Reusable data service and hook layer.</li>
            <li>Placeholder views and theme-ready CSS.</li>
          </ul>
        </div>

        <div className="home-card">
          <h3>Quick start</h3>
          <p>{recordsCount} records are currently available in the demo store.</p>
          <button onClick={onAddRecord}>Add sample record</button>
        </div>
      </div>
    </section>
  )
}

export default HomeView
