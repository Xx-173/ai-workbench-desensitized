/**
 * Browser entry for the Craft shell.
 *
 * Team mode authenticates at the HTTP boundary first. After that the same
 * Craft conversation, workspace and workbench navigation used by the desktop
 * renderer is mounted in the browser. The workbench determines administration
 * controls from the signed server identity.
 */

import React, { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { useTranslation } from 'react-i18next'
import { createWebApi } from './adapter/web-api'
import type { WsRpcClient } from '../../electron/src/transport/client'

const ElectronApp = lazy(() => import('@/App'))
type Phase = 'loading' | 'error' | 'ready'

function LoadingScreen() {
  const { t } = useTranslation()
  return <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3"><div className="animate-spin w-6 h-6 border-2 border-current border-t-transparent rounded-full" /><p className="text-[13px]">{t('webui.connectingToServer')}</p></div>
}

function ErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { t } = useTranslation()
  return <div className="flex flex-col items-center justify-center h-screen font-sans text-foreground/50 gap-3"><p className="text-base font-medium text-destructive">{t('webui.connectionFailed')}</p><p className="text-[13px] max-w-md text-center">{message}</p><div className="flex gap-2 mt-2"><button onClick={onRetry} className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer">{t('common.retry')}</button><button onClick={() => { fetch('/api/auth/logout', { method: 'POST' }).then(() => { window.location.href = '/login' }) }} className="px-4 py-1.5 rounded-md bg-background shadow-minimal text-[13px] text-foreground/70 cursor-pointer">{t('webui.logOut')}</button></div></div>
}

export default function App() {
  const [phase, setPhase] = useState<Phase>('loading')
  const [error, setError] = useState('')
  const clientRef = useRef<WsRpcClient | null>(null)
  const initRef = useRef(false)

  const initialize = async () => {
    setPhase('loading'); setError('')
    try {
      const configRes = await fetch('/api/config', { credentials: 'same-origin' })
      if (!configRes.ok) {
        if (configRes.status === 401) { window.location.href = '/login'; return }
        throw new Error(`Failed to fetch config: ${configRes.status}`)
      }
      const { wsUrl } = await configRes.json() as { wsUrl: string }
      if (!wsUrl) throw new Error('Server did not return a WebSocket URL')
      // This authenticated endpoint exists only in organization mode. The
      // shared Craft renderer uses the marker to skip personal-provider setup.
      const teamRes = await fetch('/api/workbench/bootstrap', { credentials: 'same-origin' })
      if (teamRes.ok) (window as any).__CRAFT_TEAM_MODE__ = true
      const params = new URLSearchParams(window.location.search)
      let workspaceId = params.get('workspace') ?? undefined
      if (!workspaceId) {
        try {
          const workspaceRes = await fetch('/api/config/workspaces', { credentials: 'same-origin' })
          if (workspaceRes.ok) {
            const { defaultWorkspaceId } = await workspaceRes.json() as { defaultWorkspaceId?: string }
            if (defaultWorkspaceId) workspaceId = defaultWorkspaceId
          }
        } catch { /* Workspace selection can still happen within Craft. */ }
      }
      clientRef.current?.destroy()
      const { api, client } = createWebApi({ serverUrl: wsUrl, workspaceId })
      clientRef.current = client
      ;(window as any).electronAPI = api
      client.connect()
      setPhase('ready')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause)); setPhase('error')
    }
  }

  useEffect(() => {
    if (!initRef.current) { initRef.current = true; void initialize() }
    return () => clientRef.current?.destroy()
  }, [])

  if (phase === 'loading') return <LoadingScreen />
  if (phase === 'error') return <ErrorScreen message={error} onRetry={() => void initialize()} />
  return <Suspense fallback={<LoadingScreen />}><ElectronApp /></Suspense>
}
