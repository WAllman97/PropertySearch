import { useState } from 'react'
import { useData } from './hooks/useData'
import NavigationTabs from './components/NavigationTabs'
import HomeView from './views/HomeView'
import DashboardView from './views/DashboardView'
import HistoryView from './views/HistoryView'
import SettingsView from './views/SettingsView'
import Onboarding from './views/Onboarding'

import './App.css'

export default function App() {
  const [activeTab, setActiveTab] = useState('home')
  const [showOnboarding, setShowOnboarding] = useState(true)
  const [filterDays, setFilterDays] = useState(7)

  const {
    records,
    addRecord,
    removeRecord,
    clearAll,
  } = useData()

  if (showOnboarding) {
    return <Onboarding onComplete={() => setShowOnboarding(false)} />
  }

  return (
    <div className="app">
      <header className="hero">
        <div>
          <h1>Web App Template</h1>
          <p>A reusable React + Vite starter for new web app ideas.</p>
        </div>

        <NavigationTabs activeTab={activeTab} setActiveTab={setActiveTab} />
      </header>

      <main className="container">
        {activeTab === 'home' && (
          <HomeView recordsCount={records.length} onAddRecord={() => addRecord({ title: 'Sample item', details: 'This is a placeholder record.' })} />
        )}

        {activeTab === 'dashboard' && (
          <DashboardView records={records} onAddRecord={() => addRecord({ title: `Record ${records.length + 1}`, details: 'Demo data' })} />
        )}

        {activeTab === 'history' && (
          <HistoryView
            records={records}
            filterDays={filterDays}
            setFilterDays={setFilterDays}
            onDeleteRecord={removeRecord}
            onClearAll={clearAll}
          />
        )}

        {activeTab === 'settings' && <SettingsView />}
      </main>
    </div>
  )
}
