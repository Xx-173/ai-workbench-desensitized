/** Native Craft panel for the authenticated multi-Agent workbench. */

import { useEffect, useMemo, useState } from 'react'
import { Bot, Building2, ChevronDown, KeyRound, LogOut, Play, Plus, RefreshCw, ShieldCheck, Users } from 'lucide-react'

type Identity = { userId: string; username: string; displayName: string; departmentId: string; role: 'admin' | 'member' }
type AgentField = { type: string; description: string; enum?: string[] }
type Agent = { id: string; toolName: string; description: string; kind: string; credentialMode?: 'managed' | 'external' | 'none'; enabled?: boolean; inputSchema: { properties: Record<string, AgentField>; required?: string[] }; health: { status: string; missingReferences: string[]; requiredReferences?: string[] } }
type Department = { id: string; name: string }
type User = { id: string; username: string; displayName: string; departmentId: string; role: string; status: 'active' | 'disabled' }
type Usage = { calls: number; successes: number; failures: number; durationMs: number; inputTokens: number; outputTokens: number }
type UsageRow = Usage & { id: string; name: string }
type TeamUsage = { total: Usage; byDepartment: UsageRow[]; byUser: UsageRow[]; byAgent: UsageRow[] }
type Bootstrap = { identity: Identity; agents: Agent[]; ownUsage: Usage & { byAgent?: UsageRow[] }; departments?: Department[]; users?: User[]; teamUsage?: TeamUsage }
type WorkbenchConfig = { includeBuiltinAgents?: boolean; agents: Array<Record<string, unknown>> }
type AgentKindPreset = 'dify' | 'http' | 'python' | 'mcp'

type Tab = 'run' | 'usage' | 'team' | 'config'

async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers ?? {}) },
    ...options,
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error ?? `Request failed (${response.status})`)
  return payload as T
}

function usageCards(usage: Usage): ReadonlyArray<readonly [string, string | number]> {
  return [
    ['调用次数', usage.calls], ['成功 / 失败', `${usage.successes} / ${usage.failures}`],
    ['累计耗时', `${Math.round(usage.durationMs / 1000)}s`], ['Token', usage.inputTokens + usage.outputTokens],
  ]
}

function initialFormValues(agent: Agent | undefined): Record<string, string> {
  if (!agent) return {}
  return Object.fromEntries(Object.entries(agent.inputSchema.properties).map(([key, value]) => [key, value.type === 'boolean' ? 'false' : '']))
}

function toAgentInput(agent: Agent, values: Record<string, string>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(agent.inputSchema.properties).map(([key, field]) => {
    const value = values[key] ?? ''
    if (field.type === 'number' || field.type === 'integer') return [key, Number(value)]
    if (field.type === 'boolean') return [key, value === 'true']
    if (field.type === 'array' || field.type === 'object') {
      try { return [key, JSON.parse(value || (field.type === 'array' ? '[]' : '{}'))] }
      catch { throw new Error(`${field.description || key} 需要填写有效 JSON`) }
    }
    return [key, value]
  }))
}

function fieldLabel(name: string, field: AgentField): string {
  return field.description || name.replace(/([A-Z])/g, ' $1').replace(/^./, (letter) => letter.toUpperCase())
}

function agentName(agent: Agent): string {
  const names: Record<string, string> = {
    'video-analysis': '视频解析',
    'fish-voice': '音色生成',
    'script-cleaner': '话术清洗',
    'copywriter-dify': '文案生成',
    'script-qc-coze': '话术质检',
    'external-mcp-agent': '外部 Agent 调用',
  }
  return names[agent.id] ?? agent.id.replace(/[-_]/g, ' ')
}

function makeAgentId(value: string): string {
  const result = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
  return result || `agent-${Date.now()}`
}

function credentialPrefix(id: string): string {
  return id.toUpperCase().replace(/-/g, '_').replace(/[^A-Z0-9_]/g, '')
}

function UsageRows({ rows, empty }: { rows: UsageRow[] | undefined; empty: string }) {
  if (!rows?.length) return <p className="mt-3 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{empty}</p>
  return <div className="mt-3 overflow-auto"><table className="w-full min-w-[670px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="p-2">对象</th><th className="p-2">调用</th><th className="p-2">成功 / 失败</th><th className="p-2">输入 Token</th><th className="p-2">输出 Token</th><th className="p-2">耗时</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border/50"><td className="p-2 font-medium">{row.name}</td><td className="p-2">{row.calls}</td><td className="p-2">{row.successes} / {row.failures}</td><td className="p-2">{row.inputTokens}</td><td className="p-2">{row.outputTokens}</td><td className="p-2">{Math.round(row.durationMs / 1000)}s</td></tr>)}</tbody></table></div>
}

export default function AgentWorkbenchPage() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [tab, setTab] = useState<Tab>('run')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [formValues, setFormValues] = useState<Record<string, string>>({})
  const [selectedFiles, setSelectedFiles] = useState<Record<string, File | undefined>>({})
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [config, setConfig] = useState('')
  const [departmentName, setDepartmentName] = useState('')
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', departmentId: '', role: 'member' })
  const [newSecret, setNewSecret] = useState({ name: '', value: '' })
  const [chatConnection, setChatConnection] = useState({ provider: 'openai-compatible', endpoint: '', apiKey: '', model: '' })
  const [quickAgent, setQuickAgent] = useState({ name: '', description: '', kind: 'dify' as AgentKindPreset, credentialMode: 'managed' as 'managed' | 'external' | 'none', endpoint: '', apiKey: '', credentialRefs: '', scriptOrCommand: '' })
  const [filteredTeamUsage, setFilteredTeamUsage] = useState<TeamUsage | undefined>()
  const [usageWindow, setUsageWindow] = useState({ from: '', to: '' })
  const [advancedOpen, setAdvancedOpen] = useState(false)

  const selectedAgent = useMemo(() => data?.agents.find((agent) => agent.id === selectedAgentId), [data, selectedAgentId])

  const load = async () => {
    setError('')
    try {
      const next = await api<Bootstrap>('/api/workbench/bootstrap')
      setData(next)
      setFilteredTeamUsage(undefined)
      setSelectedAgentId((current) => current || next.agents[0]?.id || '')
      if (!newUser.departmentId && next.departments?.[0]) setNewUser((current) => ({ ...current, departmentId: next.departments![0]!.id }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => { setFormValues(initialFormValues(selectedAgent)); setSelectedFiles({}) }, [selectedAgentId])

  const isFileField = (name: string, field: AgentField) => /file|video|audio|image|document|文件|视频|音频|图片/i.test(`${name} ${field.description}`)

  const uploadTaskFiles = async (taskId: string): Promise<Record<string, string>> => {
    const uploaded: Record<string, string> = {}
    for (const [fieldName, file] of Object.entries(selectedFiles)) {
      if (!file) continue
      // Production OSS mode uses a pre-signed URL so large videos do not
      // occupy Craft Server memory. Local preview falls back to multipart.
      const presignResponse = await fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}/artifacts/presign`, {
        method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filename: file.name, mimeType: file.type || 'application/octet-stream', area: 'inputs' }),
      })
      const presignPayload = await presignResponse.json().catch(() => ({})) as { uploadUrl?: string; artifact?: { relativePath?: string }; error?: string }
      if (presignResponse.ok && presignPayload.uploadUrl && presignPayload.artifact?.relativePath) {
        const uploadResponse = await fetch(presignPayload.uploadUrl, { method: 'PUT', headers: { 'content-type': file.type || 'application/octet-stream' }, body: file })
        if (!uploadResponse.ok) throw new Error(`上传 ${file.name} 到对象存储失败`)
        uploaded[fieldName] = presignPayload.artifact.relativePath
        continue
      }
      if (presignResponse.status !== 400 || !/Direct OSS upload is not configured/i.test(presignPayload.error ?? '')) {
        throw new Error(presignPayload.error ?? `获取 ${file.name} 上传地址失败`)
      }
      const form = new FormData()
      form.set('file', file)
      form.set('area', 'inputs')
      const response = await fetch(`/api/workbench/tasks/${encodeURIComponent(taskId)}/artifacts`, { method: 'POST', body: form, credentials: 'same-origin' })
      const payload = await response.json().catch(() => ({})) as { artifact?: { relativePath?: string }; error?: string }
      if (!response.ok || !payload.artifact?.relativePath) throw new Error(payload.error ?? `上传 ${file.name} 失败`)
      uploaded[fieldName] = payload.artifact.relativePath
    }
    return uploaded
  }

  const runAgent = async () => {
    if (!selectedAgentId) return
    if (!selectedAgent) return
    const missingRequired = (selectedAgent.inputSchema.required ?? []).find((name) => !formValues[name]?.trim() && !selectedFiles[name])
    if (missingRequired) {
      setError(`请填写：${fieldLabel(missingRequired, selectedAgent.inputSchema.properties[missingRequired] ?? { type: 'string', description: missingRequired })}`)
      return
    }
    setBusy(true); setError(''); setResult(null)
    try {
      const task = await api<{ taskId: string }>('/api/workbench/tasks', { method: 'POST', body: '{}' })
      const uploaded = await uploadTaskFiles(task.taskId)
      const inputValues = { ...formValues, ...uploaded }
      const invocation = await api<{ status?: string; taskId?: string; result?: unknown; error?: string }>('/api/workbench/invoke', { method: 'POST', body: JSON.stringify({ taskId: task.taskId, agentId: selectedAgentId, input: toAgentInput(selectedAgent, inputValues) }) })
      if (invocation.status !== 'queued') {
        setResult(invocation)
      } else {
        let completed: unknown = invocation
        for (let attempt = 0; attempt < 720; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 5000))
          const status = await api<{ status: string; result?: unknown; error?: string }>(`/api/workbench/tasks/${encodeURIComponent(task.taskId)}/status`)
          if (status.status === 'succeeded') { completed = status.result ?? status; break }
          if (status.status === 'failed') throw new Error(status.error ?? '异步任务执行失败')
        }
        setResult(completed)
      }
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally { setBusy(false) }
  }

  const addDepartment = async () => {
    try {
      await api('/api/workbench/departments', { method: 'POST', body: JSON.stringify({ name: departmentName }) })
      setDepartmentName(''); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const addUser = async () => {
    try {
      await api('/api/workbench/users', { method: 'POST', body: JSON.stringify(newUser) })
      setNewUser((current) => ({ ...current, username: '', displayName: '', password: '' })); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const toggleUser = async (user: User) => {
    try {
      await api(`/api/workbench/users/${user.id}`, { method: 'PATCH', body: JSON.stringify({ status: user.status === 'active' ? 'disabled' : 'active' }) })
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const loadConfig = async () => {
    try { setConfig(JSON.stringify(await api('/api/workbench/config'), null, 2)); setTab('config') }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const saveConfig = async () => {
    try { await api('/api/workbench/config', { method: 'PUT', body: config }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const saveSecret = async () => {
    try {
      await api('/api/workbench/secrets', { method: 'POST', body: JSON.stringify(newSecret) })
      setNewSecret({ name: '', value: '' }); await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const refreshTeamUsage = async () => {
    const params = new URLSearchParams()
    if (usageWindow.from) params.set('from', usageWindow.from)
    if (usageWindow.to) params.set('to', usageWindow.to)
    try { setFilteredTeamUsage(await api<TeamUsage>(`/api/workbench/usage/team${params.toString() ? `?${params.toString()}` : ''}`)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const testAgent = async (agent: Agent) => {
    setBusy(true); setError(''); setResult(null)
    try {
      const input = Object.fromEntries(Object.entries(agent.inputSchema.properties).map(([name, field]) => [name, field.type === 'number' ? 1 : field.type === 'boolean' ? false : field.type === 'array' ? [] : `connection-test:${name}`]))
      setResult(await api(`/api/workbench/agents/${agent.id}/test`, { method: 'POST', body: JSON.stringify(input) }))
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const toggleAgent = async (agent: Agent) => {
    try { await api(`/api/workbench/agents/${agent.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: agent.enabled === false }) }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const deleteAgent = async (agent: Agent) => {
    if (!window.confirm(`确认删除 Agent「${agentName(agent)}」？关联且未被其他 Agent 使用的凭证引用也会删除。`)) return
    try { await api(`/api/workbench/agents/${agent.id}`, { method: 'DELETE' }); await load() }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  const saveCompanyChatModel = async () => {
    const apiKey = chatConnection.apiKey.trim()
    const endpoint = chatConnection.endpoint.trim().replace(/\/$/, '')
    const model = chatConnection.model.trim()
    if (!apiKey || !model) {
      setError('请填写公司聊天模型的 API Key 和默认模型。')
      return
    }
    if (!window.electronAPI) {
      setError('当前浏览器连接未就绪，请刷新后重试。')
      return
    }
    setBusy(true); setError('')
    try {
      const isAnthropic = chatConnection.provider === 'anthropic'
      const result = await window.electronAPI.setupLlmConnection({
        slug: 'team-default', credential: apiKey, defaultModel: model, models: [model],
        ...(endpoint ? { baseUrl: endpoint } : {}),
        ...(isAnthropic ? { piAuthProvider: 'anthropic' } : { piAuthProvider: 'openai', customEndpoint: { api: 'openai-completions' } }),
      })
      if (!result.success) throw new Error(result.error ?? '公司聊天模型保存失败')
      const defaultResult = await window.electronAPI.setDefaultLlmConnection('team-default')
      if (!defaultResult.success) throw new Error(defaultResult.error ?? '默认模型设置失败')
      setChatConnection((current) => ({ ...current, apiKey: '' }))
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }

  const addQuickAgent = async () => {
    const name = quickAgent.name.trim()
    const endpoint = quickAgent.endpoint.trim().replace(/\/$/, '')
    if (!name) { setError('请填写 Agent 名称。'); return }
    if ((quickAgent.kind === 'dify' || quickAgent.kind === 'http') && !endpoint) { setError('请填写 Agent 服务地址。'); return }
    if ((quickAgent.kind === 'python' || quickAgent.kind === 'mcp') && !quickAgent.scriptOrCommand.trim()) { setError('请填写脚本或 MCP 启动命令。'); return }
    if ((quickAgent.kind === 'dify' || quickAgent.kind === 'http') && quickAgent.credentialMode === 'managed' && !quickAgent.apiKey.trim()) { setError('托管凭证模式必须填写 Agent API Key。'); return }
    try {
      // Always read the server copy before appending. The textarea is optional
      // (admins should not have to open the advanced editor first), and using a
      // stale/empty local value here could accidentally replace existing Agents.
      const current = await api<WorkbenchConfig>('/api/workbench/config')
      const id = makeAgentId(name)
      if (current.agents.some((agent) => agent.id === id)) throw new Error(`已存在同名 Agent：${id}`)
      const prefix = credentialPrefix(id)
      const credentialRefs = quickAgent.credentialRefs.split(',').map((value) => value.trim()).filter(Boolean).map((name) => ({ name, source: name }))
      const common = {
        id, toolName: `run_${id.replace(/-/g, '_')}`, description: quickAgent.description.trim() || `${name} 业务 Agent`, enabled: true,
        inputSchema: { type: 'object', properties: { task: { type: 'string', description: '任务描述或待处理内容' } }, required: ['task'] },
      }
      const agent = quickAgent.kind === 'dify'
        ? { ...common, credentialMode: quickAgent.credentialMode, kind: 'http', config: { baseUrlEnv: `${prefix}_BASE_URL`, ...(quickAgent.credentialMode === 'managed' ? { tokenEnv: `${prefix}_API_KEY` } : {}), path: '/v1/workflows/run', payloadMode: 'dify-workflow' } }
        : quickAgent.kind === 'http'
          ? { ...common, credentialMode: quickAgent.credentialMode, kind: 'http', config: { baseUrlEnv: `${prefix}_BASE_URL`, ...(quickAgent.credentialMode === 'managed' ? { tokenEnv: `${prefix}_API_KEY` } : {}), path: '/v1/run', payloadMode: 'input' } }
          : quickAgent.kind === 'python'
            ? { ...common, credentialMode: credentialRefs.length ? 'managed' : 'none', ...(credentialRefs.length ? { credentials: credentialRefs } : {}), kind: 'python', config: { command: quickAgent.scriptOrCommand.trim().split(/\s+/)[0], args: quickAgent.scriptOrCommand.trim().split(/\s+/).slice(1) } }
            : { ...common, credentialMode: credentialRefs.length ? 'managed' : 'none', ...(credentialRefs.length ? { credentials: credentialRefs } : {}), kind: 'mcp', config: { command: quickAgent.scriptOrCommand.trim().split(/\s+/)[0], args: quickAgent.scriptOrCommand.trim().split(/\s+/).slice(1), toolName: 'run_task' } }
      const next = { ...current, agents: [...current.agents, agent] }
      await api('/api/workbench/config', { method: 'PUT', body: JSON.stringify(next) })
      if (endpoint) await api('/api/workbench/secrets', { method: 'POST', body: JSON.stringify({ name: `${prefix}_BASE_URL`, value: endpoint }) })
      if (quickAgent.apiKey.trim()) await api('/api/workbench/secrets', { method: 'POST', body: JSON.stringify({ name: `${prefix}_API_KEY`, value: quickAgent.apiKey.trim() }) })
      setConfig(JSON.stringify(next, null, 2))
      setQuickAgent({ name: '', description: '', kind: 'dify', credentialMode: 'managed', endpoint: '', apiKey: '', credentialRefs: '', scriptOrCommand: '' })
      await load()
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }

  if (!data && !error) return <div className="h-full grid place-items-center text-sm text-muted-foreground">正在连接 AI 工作台…</div>
  if (!data) return <div className="h-full grid place-items-center p-8 text-center"><div><p className="font-medium">AI 工作台未启用</p><p className="mt-2 max-w-lg text-sm text-muted-foreground">{error}。请由服务器管理员启用 CRAFT_TEAM_MODE，并用浏览器打开 Craft WebUI。</p><button className="mt-4 rounded-md border px-3 py-1.5 text-sm" onClick={() => void load()}>重试</button></div></div>

  const isAdmin = data.identity.role === 'admin'
  const usage = filteredTeamUsage ?? data.teamUsage
  return (
    <div className="h-full overflow-auto bg-background p-5 @container">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><Bot className="h-5 w-5" /><h1 className="text-lg font-semibold">AI 工作台</h1></div><p className="mt-1 text-sm text-muted-foreground">在 Craft 内运行已审批 Agent；密钥不下发给成员，调用按账号和部门归集。</p></div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>{data.identity.displayName} · {data.identity.role === 'admin' ? '管理员' : '成员'}</span><button className="rounded-md border p-2" title="刷新" onClick={() => void load()}><RefreshCw className="h-4 w-4" /></button><button className="inline-flex items-center gap-1 rounded-md border px-2 py-1.5 text-xs" title="退出账号" onClick={() => { void fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' }).finally(() => { window.location.href = '/login' }) }}><LogOut className="h-3.5 w-3.5" />退出账号</button></div>
      </header>
      <div className="mb-5 flex gap-2 border-b pb-3">
        <button onClick={() => setTab('run')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'run' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><Play className="mr-1 inline h-3.5 w-3.5" />运行 Agent</button>
        <button onClick={() => setTab('usage')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'usage' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>我的用量</button>
        {isAdmin && <button onClick={() => setTab('team')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'team' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><Users className="mr-1 inline h-3.5 w-3.5" />团队与用量</button>}
        {isAdmin && <button onClick={() => { void loadConfig() }} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'config' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><KeyRound className="mr-1 inline h-3.5 w-3.5" />管理设置</button>}
      </div>
      {error && <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {tab === 'run' && <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-2">{data.agents.length === 0 ? <p className="rounded-lg border p-4 text-sm text-muted-foreground">管理员尚未配置可用 Agent。</p> : data.agents.map((agent) => <button key={agent.id} onClick={() => setSelectedAgentId(agent.id)} className={`w-full rounded-lg border p-3 text-left ${selectedAgentId === agent.id ? 'border-foreground bg-muted/60' : 'hover:bg-muted/40'} ${agent.enabled === false ? 'opacity-60' : ''}`}><div className="flex justify-between gap-2"><strong className="text-sm">{agentName(agent)}</strong><span className="text-xs text-muted-foreground">{agent.enabled === false ? '已禁用' : agent.kind}</span></div><p className="mt-1 text-xs text-muted-foreground">{agent.description}</p><p className={`mt-2 text-xs ${agent.enabled === false ? 'text-muted-foreground' : agent.health.status === 'configured' ? 'text-emerald-600' : 'text-amber-600'}`}>{agent.enabled === false ? '管理员已禁用' : agent.health.status === 'configured' ? '可运行' : `等待管理员配置：${agent.health.missingReferences.join('、')}`}</p></button>)}</aside>
        <div className="space-y-4"><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">{selectedAgent?.description ?? '选择一个 Agent'}</h2><p className="mt-1 text-xs text-muted-foreground">已发布的业务 Agent 会使用管理员配置的服务和密钥；成员只需提交业务输入。文件会自动保存到当前 Workspace 的任务目录。</p><div className="mt-4 grid gap-3 sm:grid-cols-2">{Object.entries(selectedAgent?.inputSchema.properties ?? {}).map(([name, field]) => <label key={name} className="block text-sm font-medium"><span>{fieldLabel(name, field)}{selectedAgent?.inputSchema.required?.includes(name) ? <span className="ml-1 text-destructive">*</span> : null}</span>{isFileField(name, field) ? <><input type="file" onChange={(event) => setSelectedFiles((current) => ({ ...current, [name]: event.target.files?.[0] }))} className="mt-1.5 block w-full rounded-md border bg-background px-3 py-2 text-sm" />{selectedFiles[name] ? <span className="mt-1 block text-xs text-muted-foreground">已选择：{selectedFiles[name]!.name}</span> : null}</> : field.type === 'boolean' ? <select value={formValues[name] ?? 'false'} onChange={(event) => setFormValues((current) => ({ ...current, [name]: event.target.value }))} className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"><option value="false">否</option><option value="true">是</option></select> : field.enum?.length ? <select value={formValues[name] ?? ''} onChange={(event) => setFormValues((current) => ({ ...current, [name]: event.target.value }))} className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"><option value="">请选择</option>{field.enum.map((option) => <option key={option} value={option}>{option}</option>)}</select> : <textarea value={formValues[name] ?? ''} onChange={(event) => setFormValues((current) => ({ ...current, [name]: event.target.value }))} placeholder={field.type === 'array' || field.type === 'object' ? '请输入结构化内容' : `请输入${fieldLabel(name, field)}`} className="mt-1.5 min-h-20 w-full rounded-md border bg-background p-3 text-sm outline-none focus:ring-2 focus:ring-ring" />}</label>)}</div>{selectedAgent && selectedAgent.enabled === false && <p className="mt-4 rounded-md bg-muted p-3 text-sm text-muted-foreground">此 Agent 已被管理员禁用。</p>}{selectedAgent && selectedAgent.enabled !== false && selectedAgent.health.status !== 'configured' && <p className="mt-4 rounded-md bg-amber-500/10 p-3 text-sm text-amber-700">此 Agent 尚未可用：管理员还需配置 {selectedAgent.health.missingReferences.join('、')}。</p>}<button disabled={!selectedAgent || selectedAgent.enabled === false || busy || selectedAgent.health.status !== 'configured'} onClick={() => void runAgent()} className="mt-4 inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"><Play className="h-4 w-4" />{busy ? '执行中…' : '提交任务并记录用量'}</button></section>
        {result !== null && <section className="rounded-xl border bg-card p-4"><h2 className="font-medium">映射后的执行结果</h2>{(() => { const value = result as { taskId?: string; artifacts?: string[] }; return value.taskId && value.artifacts?.length ? <div className="mt-3 space-y-1 text-sm"><p className="text-xs text-muted-foreground">任务产物已保存到当前 Workspace：</p>{value.artifacts.filter((path) => !/^https?:\/\//i.test(path)).map((path) => <a key={path} href={`/api/workbench/tasks/${encodeURIComponent(value.taskId!)}/artifacts/${path.split('/').map((part) => encodeURIComponent(part)).join('/')}`} download className="block text-primary underline">下载 {path}</a>)}</div> : null })()}<pre className="mt-3 max-h-[440px] overflow-auto rounded-md bg-muted p-3 text-xs leading-5">{String(JSON.stringify(result, null, 2) ?? '')}</pre></section>}</div>
      </section>}

      {tab === 'usage' && <section className="space-y-5"><div><h2 className="font-medium">我的用量</h2><p className="mt-1 text-sm text-muted-foreground">只展示你自己的调用聚合；不会存储任务正文、输出内容或任何密钥。Token 仅在下游服务实际返回 usage 时统计。</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{usageCards(data.ownUsage).map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}</div><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按 Agent</h2><UsageRows rows={data.ownUsage.byAgent} empty="尚无个人调用记录。" /></section></section>}

      {tab === 'team' && isAdmin && <section className="space-y-5">
        <section className="rounded-xl border bg-card p-4"><div className="flex flex-wrap items-end gap-3"><label className="text-sm font-medium">开始日期<input type="date" value={usageWindow.from} onChange={(event) => setUsageWindow({ ...usageWindow, from: event.target.value })} className="mt-1.5 block rounded-md border bg-background px-3 py-2 text-sm" /></label><label className="text-sm font-medium">结束日期<input type="date" value={usageWindow.to} onChange={(event) => setUsageWindow({ ...usageWindow, to: event.target.value })} className="mt-1.5 block rounded-md border bg-background px-3 py-2 text-sm" /></label><button onClick={() => void refreshTeamUsage()} className="rounded-md border px-3 py-2 text-sm">刷新统计</button><button onClick={() => { setUsageWindow({ from: '', to: '' }); setFilteredTeamUsage(undefined) }} className="rounded-md px-3 py-2 text-sm text-muted-foreground">清除筛选</button></div><p className="mt-2 text-xs text-muted-foreground">管理员测试调用默认不计入业务用量；需要审计测试时可通过 API 加上 includeTests=true。</p></section>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{usageCards(usage?.total ?? data.ownUsage).map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}</div>
        <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border bg-card p-4"><h2 className="flex items-center gap-2 font-medium"><Building2 className="h-4 w-4" />部门</h2><div className="mt-3 flex gap-2"><input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如：市场部" /><button onClick={() => void addDepartment()} className="rounded-md border px-3 text-sm">新建</button></div><div className="mt-3 space-y-2">{data.departments?.map((department) => <div key={department.id} className="flex justify-between rounded-md bg-muted/60 px-3 py-2 text-sm"><span>{department.name}</span><span className="text-muted-foreground">{usage?.byDepartment.find((item) => item.id === department.id)?.calls ?? 0} 次</span></div>)}</div></section>
        <section className="rounded-xl border bg-card p-4"><h2 className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" />开通成员账号</h2><div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="用户名" /><input value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="姓名" /><input value={newUser.password} type="password" onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="初始密码（至少 10 位）" /><select value={newUser.departmentId} onChange={(event) => setNewUser({ ...newUser, departmentId: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm">{data.departments?.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select><select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="member">成员</option><option value="admin">管理员</option></select><button onClick={() => void addUser()} className="rounded-md bg-foreground px-3 py-2 text-sm text-background">开通账号</button></div></section></div>
        <section className="rounded-xl border bg-card p-4"><h2 className="font-medium">账号与个人用量</h2><div className="mt-3 overflow-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="p-2">成员</th><th className="p-2">部门</th><th className="p-2">角色</th><th className="p-2">调用</th><th className="p-2">状态</th><th className="p-2"></th></tr></thead><tbody>{data.users?.map((user) => <tr key={user.id} className="border-b border-border/50"><td className="p-2"><strong>{user.displayName}</strong><span className="ml-2 text-xs text-muted-foreground">{user.username}</span></td><td className="p-2">{data.departments?.find((item) => item.id === user.departmentId)?.name ?? '-'}</td><td className="p-2">{user.role === 'admin' ? '管理员' : '成员'}</td><td className="p-2">{usage?.byUser.find((item) => item.id === user.id)?.calls ?? 0}</td><td className="p-2">{user.status === 'active' ? '启用' : '已禁用'}</td><td className="p-2"><button disabled={user.id === data.identity.userId} onClick={() => void toggleUser(user)} className="rounded border px-2 py-1 text-xs disabled:opacity-40">{user.status === 'active' ? '禁用' : '启用'}</button></td></tr>)}</tbody></table></div></section>
        <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按部门用量</h2><UsageRows rows={usage?.byDepartment} empty="尚无部门调用记录。" /></section><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按 Agent 用量</h2><UsageRows rows={usage?.byAgent} empty="尚无 Agent 调用记录。" /></section></div>
      </section>}

      {tab === 'config' && isAdmin && <section className="space-y-5">
        <section className="rounded-xl border bg-card p-4"><h2 className="font-medium">公司聊天模型</h2><p className="mt-1 text-sm text-muted-foreground">这是员工在 Craft 对话入口中统一使用的默认模型。只由管理员维护；保存后会写入 Craft 服务端凭证和默认连接，员工不会看到 Key 或供应商选择。</p><div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4"><label className="text-sm font-medium">协议<select value={chatConnection.provider} onChange={(event) => setChatConnection({ ...chatConnection, provider: event.target.value })} className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm"><option value="openai-compatible">OpenAI 兼容接口</option><option value="agnes">Agnes 网关（OpenAI 兼容）</option><option value="anthropic">Anthropic Messages</option></select></label><label className="text-sm font-medium">Endpoint<input value={chatConnection.endpoint} onChange={(event) => setChatConnection({ ...chatConnection, endpoint: event.target.value })} className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder={chatConnection.provider === 'agnes' ? '例如 https://agnes.company.com/v1' : 'https://api.example.com/v1'} /></label><label className="text-sm font-medium">默认模型<input value={chatConnection.model} onChange={(event) => setChatConnection({ ...chatConnection, model: event.target.value })} className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如 gpt-4.1-mini" /></label><label className="text-sm font-medium">API Key<input value={chatConnection.apiKey} onChange={(event) => setChatConnection({ ...chatConnection, apiKey: event.target.value })} type="password" autoComplete="new-password" className="mt-1.5 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="仅保存一次，不会回显" /></label></div><p className="mt-3 text-xs text-muted-foreground">Agnes 这里只是预设名称，实际请求仍按 OpenAI 兼容协议发送；请填 Agnes 的网关地址、模型 ID 和网关 Key。</p><button disabled={busy} onClick={() => void saveCompanyChatModel()} className="mt-4 rounded-md bg-foreground px-3 py-2 text-sm text-background disabled:opacity-50">保存公司默认模型</button></section>

        <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">快速接入 Agent</h2><p className="mt-1 text-sm text-muted-foreground">选择 Agent 类型和凭证模式；Key 只会写入服务器加密库，不会进入 Manifest。</p><div className="mt-4 grid gap-3 sm:grid-cols-2"><input value={quickAgent.name} onChange={(event) => setQuickAgent({ ...quickAgent, name: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="Agent 名称，例如课程文案" /><select value={quickAgent.kind} onChange={(event) => setQuickAgent({ ...quickAgent, kind: event.target.value as AgentKindPreset })} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="dify">Dify 工作流</option><option value="http">HTTP / 自建 Agent</option><option value="python">Python 脚本</option><option value="mcp">MCP Agent</option></select><input value={quickAgent.description} onChange={(event) => setQuickAgent({ ...quickAgent, description: event.target.value })} className="sm:col-span-2 rounded-md border bg-background px-3 py-2 text-sm" placeholder="业务说明（员工可见）" />{quickAgent.kind === 'dify' || quickAgent.kind === 'http' ? <><input value={quickAgent.endpoint} onChange={(event) => setQuickAgent({ ...quickAgent, endpoint: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder={quickAgent.kind === 'dify' ? 'Dify 地址，例如 https://dify.company.com' : 'Agent 服务地址'} /><select value={quickAgent.credentialMode} onChange={(event) => setQuickAgent({ ...quickAgent, credentialMode: event.target.value as 'managed' | 'external' | 'none' })} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="managed">工作台托管 Key</option><option value="external">Agent 自带认证</option><option value="none">无需认证</option></select>{quickAgent.credentialMode === 'managed' && <input value={quickAgent.apiKey} onChange={(event) => setQuickAgent({ ...quickAgent, apiKey: event.target.value })} type="password" autoComplete="new-password" className="sm:col-span-2 rounded-md border bg-background px-3 py-2 text-sm" placeholder={quickAgent.kind === 'dify' ? 'Dify 应用 API Key（app-…）' : 'Agent API Key'} />}</> : <><input value={quickAgent.scriptOrCommand} onChange={(event) => setQuickAgent({ ...quickAgent, scriptOrCommand: event.target.value })} className="sm:col-span-2 rounded-md border bg-background px-3 py-2 text-sm" placeholder={quickAgent.kind === 'python' ? '例如 python /opt/agents/clean.py' : '例如 node /opt/agents/server.mjs'} /><input value={quickAgent.credentialRefs} onChange={(event) => setQuickAgent({ ...quickAgent, credentialRefs: event.target.value })} className="sm:col-span-2 rounded-md border bg-background px-3 py-2 text-sm" placeholder="脚本需要的凭证引用（逗号分隔，如 OPENAI_API_KEY）" /></>}</div><button onClick={() => void addQuickAgent()} className="mt-4 inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm text-background"><Plus className="h-4 w-4" />发布 Agent</button></section>
        <aside className="rounded-xl border bg-card p-4"><h2 className="font-medium">受管凭证库</h2><p className="mt-1 text-sm text-muted-foreground">用于补充已有 Agent 的地址或 Key。密钥仅加密写入服务器，保存后只显示“已配置”，无法回显；同名引用保存会覆盖旧值。</p><input value={newSecret.name} onChange={(event) => setNewSecret({ ...newSecret, name: event.target.value })} className="mt-4 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如 DIFY_API_KEY" /><input value={newSecret.value} onChange={(event) => setNewSecret({ ...newSecret, value: event.target.value })} type="password" autoComplete="new-password" className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="粘贴 Key 或地址" /><button onClick={() => void saveSecret()} className="mt-2 rounded-md border px-3 py-2 text-sm">加密保存</button><div className="mt-4 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground"><strong className="text-foreground">Dify 要填什么？</strong><br />在 Dify 应用的“API 访问”创建应用 API Key（通常为 <code>app-…</code>），填写 Dify 域名为 Base URL。工作流接入会自动调用 <code>/v1/workflows/run</code>。</div></aside></div>

        <section className="rounded-xl border bg-card p-4"><div className="flex items-center justify-between gap-3"><div><h2 className="font-medium">Agent 发布状态</h2><p className="mt-1 text-sm text-muted-foreground">测试调用会记录为管理员测试，不计入默认业务用量；禁用后员工不会再看到该 Agent。</p></div><button onClick={() => void load()} className="rounded-md border px-3 py-2 text-sm">刷新</button></div><div className="mt-3 space-y-2">{data.agents.length === 0 ? <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">暂无已发布 Agent。</p> : data.agents.map((agent) => <div key={agent.id} className="flex flex-wrap items-center justify-between gap-3 rounded-md border p-3"><div><strong>{agentName(agent)}</strong><span className="ml-2 text-xs text-muted-foreground">{agent.enabled === false ? '已禁用 · ' : ''}{agent.credentialMode ?? '兼容托管'} · {agent.health.status === 'configured' ? '凭证完整' : `缺少 ${agent.health.missingReferences.join('、')}`}</span><p className="mt-1 text-xs text-muted-foreground">{agent.description}</p></div><div className="flex gap-2"><button disabled={busy || agent.enabled === false} onClick={() => void testAgent(agent)} className="rounded-md border px-2 py-1 text-xs">测试连接</button><button onClick={() => void toggleAgent(agent)} className="rounded-md border px-2 py-1 text-xs">{agent.enabled === false ? '启用' : '禁用'}</button><button onClick={() => void deleteAgent(agent)} className="rounded-md border border-destructive/40 px-2 py-1 text-xs text-destructive">删除</button></div></div>)}</div></section>

        <details open={advancedOpen} onToggle={(event) => setAdvancedOpen((event.target as HTMLDetailsElement).open)} className="rounded-xl border bg-card p-4"><summary className="flex cursor-pointer list-none items-center justify-between font-medium">高级：编辑 Agent Manifest <ChevronDown className="h-4 w-4" /></summary><p className="mt-2 text-xs text-muted-foreground">仅用于复杂的输入字段、部门权限、限流或 MCP 工具名；真实密钥请始终存入上方凭证库。</p><textarea value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} className="mt-3 min-h-[360px] w-full rounded-md border bg-background p-3 font-mono text-xs" /><button onClick={() => void saveConfig()} className="mt-3 rounded-md border px-3 py-2 text-sm">校验并保存高级配置</button></details>
      </section>}
    </div>
  )
}
