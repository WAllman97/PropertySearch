import { useState } from 'react'

function SettingsView() {
  const [notifications, setNotifications] = useState(true)
  const [theme, setTheme] = useState('light')

  return (
    <section className="card settings-view">
      <div className="section-header">
        <h2>Settings</h2>
        <p>Use this page to configure app behavior and preferences.</p>
      </div>

      <form className="settings-form">
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={notifications}
            onChange={(event) => setNotifications(event.target.checked)}
          />
          Enable notifications
        </label>

        <label>
          Theme
          <select value={theme} onChange={(event) => setTheme(event.target.value)}>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>

        <button type="button" className="primary-button">
          Save settings
        </button>
      </form>
    </section>
  )
}

export default SettingsView
