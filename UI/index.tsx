import React from 'react'
import ReactDOM from 'react-dom/client'
import { ThemeProvider, CssBaseline } from '@mui/material'
import App from './App'
import theme from './theme'
import './index.css'

const rootElement = document.getElementById('root')
if (!rootElement) {
  throw new Error('Could not find root element to mount to')
}

const root = ReactDOM.createRoot(rootElement)
root.render(
  <React.StrictMode>
    <ThemeProvider theme={theme} defaultMode="dark" noSsr>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </React.StrictMode>,
)
