import { useEffect } from 'react'
import { AppShell } from './components/layout/app-shell'
import { ToastHost } from './components/toast-host'
import { connectEngine } from './store/app-store'

export default function App() {
  useEffect(() => {
    connectEngine()
  }, [])

  return (
    <>
      <AppShell />
      <ToastHost />
    </>
  )
}
