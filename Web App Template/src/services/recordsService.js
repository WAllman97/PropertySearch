// Simple localStorage-backed service with optional Supabase example
const STORAGE_KEY = 'webapp_template_records'

export async function fetchRecords() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return []
  try { return JSON.parse(raw) } catch { return [] }
}

export async function saveRecord(record) {
  const list = await fetchRecords()
  const updated = [record, ...list.filter((r) => r.id !== record.id)]
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
  return record
}

export async function deleteRecord(id) {
  const list = await fetchRecords()
  const updated = list.filter((r) => r.id !== id)
  localStorage.setItem(STORAGE_KEY, JSON.stringify(updated))
}

export async function clearRecords() {
  localStorage.removeItem(STORAGE_KEY)
}

// Optional: to use Supabase uncomment and adapt
// import { supabase } from '../lib/supabaseClient'
// export async function fetchRecords() { ... }
