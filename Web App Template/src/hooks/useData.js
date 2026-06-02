import { useState, useEffect } from 'react'
import { fetchRecords, saveRecord, deleteRecord, clearRecords } from '../services/recordsService'

export function useData() {
  const [records, setRecords] = useState([])

  useEffect(() => {
    async function load() {
      try {
        const data = await fetchRecords()
        setRecords(data)
      } catch (e) {
        console.error('load error', e)
      }
    }

    load()
  }, [])

  const addRecord = async (payload) => {
    const item = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), ...payload }
    await saveRecord(item)
    setRecords((r) => [item, ...r])
  }

  const removeRecord = async (id) => {
    await deleteRecord(id)
    setRecords((r) => r.filter((x) => x.id !== id))
  }

  const clearAll = async () => {
    await clearRecords()
    setRecords([])
  }

  return { records, addRecord, removeRecord, clearAll }
}
