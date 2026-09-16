/** Native Craft panel for the authenticated multi-Agent workbench. */

import { useEffect, useMemo, useState } from 'react'
import { Bot, Building2, KeyRound, Play, RefreshCw, ShieldCheck, Users } from 'lucide-react'

type Identity = { userId: string; username: string; displayName: string; departmentId: string; role: 'admin' | 'member' }
type Agent = { id: string; toolName: string; description: string; kind: string; inputSchema: { properties: Record<string, { type: string; description: string }>; required?: string[] }; health: { status: string; missingReferences: string[] } }
type Department = { id: string; name: string }
type User = { id: string; username: string; displayName: string; departmentId: string; role: string; status: 'active' | 'disabled' }
type Usage = { calls: number; successes: number; failures: number; durationMs: number; inputTokens: number; outputTokens: number }
type UsageRow = Usage & { id: string; name: string }
type Bootstrap = { identity: Identity; agents: Agent[]; ownUsage: Usage & { byAgent?: UsageRow[] }; departments?: Department[]; users?: User[]; teamUsage?: { total: Usage; byDepartment: UsageRow[]; byUser: UsageRow[]; byAgent: UsageRow[] } }

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

function schemaExample(agent: Agent | undefined): string {
  if (!agent) return '{}'
  return JSON.stringify(Object.fromEntries(Object.entries(agent.inputSchema.properties).map(([key, value]) => [key, value.type === 'number' ? 0 : value.type === 'boolean' ? false : value.type === 'array' ? [] : ''])), null, 2)
}

function UsageRows({ rows, empty }: { rows: UsageRow[] | undefined; empty: string }) {
  if (!rows?.length) return <p className="mt-3 rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">{empty}</p>
  return <div className="mt-3 overflow-auto"><table className="w-full min-w-[670px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="p-2">对象</th><th className="p-2">调用</th><th className="p-2">成功 / 失败</th><th className="p-2">输入 Token</th><th className="p-2">输出 Token</th><th className="p-2">耗时</th></tr></thead><tbody>{rows.map((row) => <tr key={row.id} className="border-b border-border/50"><td className="p-2 font-medium">{row.name}</td><td className="p-2">{row.calls}</td><td className="p-2">{row.successes} / {row.failures}</td><td className="p-2">{row.inputTokens}</td><td className="p-2">{row.outputTokens}</td><td className="p-2">{Math.round(row.durationMs / 1000)}s</td></tr>)}</tbody></table></div>
}

export default function AgentWorkbenchPage() {
  const [data, setData] = useState<Bootstrap | null>(null)
  const [tab, setTab] = useState<Tab>('run')
  const [selectedAgentId, setSelectedAgentId] = useState('')
  const [input, setInput] = useState('{}')
  const [result, setResult] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [config, setConfig] = useState('')
  const [departmentName, setDepartmentName] = useState('')
  const [newUser, setNewUser] = useState({ username: '', displayName: '', password: '', departmentId: '', role: 'member' })
  const [newSecret, setNewSecret] = useState({ name: '', value: '' })

  const selectedAgent = useMemo(() => data?.agents.find((agent) => agent.id === selectedAgentId), [data, selectedAgentId])

  const load = async () => {
    setError('')
    try {
      const next = await api<Bootstrap>('/api/workbench/bootstrap')
      setData(next)
      setSelectedAgentId((current) => current || next.agents[0]?.id || '')
      if (!newUser.departmentId && next.departments?.[0]) setNewUser((current) => ({ ...current, departmentId: next.departments![0]!.id }))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  useEffect(() => { void load() }, [])
  useEffect(() => { if (selectedAgent) setInput(schemaExample(selectedAgent)) }, [selectedAgentId])

  const runAgent = async () => {
    if (!selectedAgentId) return
    setBusy(true); setError(''); setResult(null)
    try {
      const parsed = JSON.parse(input) as object
      setResult(await api('/api/workbench/invoke', { method: 'POST', body: JSON.stringify({ agentId: selectedAgentId, input: parsed }) }))
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

  if (!data && !error) return <div className="h-full grid place-items-center text-sm text-muted-foreground">正在连接 AI 工作台…</div>
  if (!data) return <div className="h-full grid place-items-center p-8 text-center"><div><p className="font-medium">AI 工作台未启用</p><p className="mt-2 max-w-lg text-sm text-muted-foreground">{error}。请由服务器管理员启用 CRAFT_TEAM_MODE，并用浏览器打开 Craft WebUI。</p><button className="mt-4 rounded-md border px-3 py-1.5 text-sm" onClick={() => void load()}>重试</button></div></div>

  const isAdmin = data.identity.role === 'admin'
  const usage = data.teamUsage
  return (
    <div className="h-full overflow-auto bg-background p-5 @container">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><Bot className="h-5 w-5" /><h1 className="text-lg font-semibold">AI 工作台</h1></div><p className="mt-1 text-sm text-muted-foreground">在 Craft 内运行已审批 Agent；密钥不下发给成员，调用按账号和部门归集。</p></div>
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><span>{data.identity.displayName} · {data.identity.role === 'admin' ? '管理员' : '成员'}</span><button className="rounded-md border p-2" title="刷新" onClick={() => void load()}><RefreshCw className="h-4 w-4" /></button></div>
      </header>
      <div className="mb-5 flex gap-2 border-b pb-3">
        <button onClick={() => setTab('run')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'run' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><Play className="mr-1 inline h-3.5 w-3.5" />运行 Agent</button>
        <button onClick={() => setTab('usage')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'usage' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}>我的用量</button>
        {isAdmin && <button onClick={() => setTab('team')} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'team' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><Users className="mr-1 inline h-3.5 w-3.5" />团队与用量</button>}
        {isAdmin && <button onClick={() => { void loadConfig() }} className={`rounded-md px-3 py-1.5 text-sm ${tab === 'config' ? 'bg-foreground text-background' : 'hover:bg-muted'}`}><KeyRound className="mr-1 inline h-3.5 w-3.5" />Agent 配置</button>}
      </div>
      {error && <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}

      {tab === 'run' && <section className="grid gap-4 xl:grid-cols-[300px_minmax(0,1fr)]">
        <aside className="space-y-2">{data.agents.length === 0 ? <p className="rounded-lg border p-4 text-sm text-muted-foreground">管理员尚未配置可用 Agent。</p> : data.agents.map((agent) => <button key={agent.id} onClick={() => setSelectedAgentId(agent.id)} className={`w-full rounded-lg border p-3 text-left ${selectedAgentId === agent.id ? 'border-foreground bg-muted/60' : 'hover:bg-muted/40'}`}><div className="flex justify-between gap-2"><strong className="text-sm">{agent.id}</strong><span className="text-xs text-muted-foreground">{agent.kind}</span></div><p className="mt-1 text-xs text-muted-foreground">{agent.description}</p><p className={`mt-2 text-xs ${agent.health.status === 'configured' ? 'text-emerald-600' : 'text-amber-600'}`}>{agent.health.status === 'configured' ? '已配置' : `缺少 ${agent.health.missingReferences.join(', ')}`}</p></button>)}</aside>
        <div className="space-y-4"><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">{selectedAgent?.description ?? '选择一个 Agent'}</h2><p className="mt-1 text-xs text-muted-foreground">工具名：{selectedAgent?.toolName ?? '-'}</p><label className="mt-4 block text-sm font-medium">输入 JSON</label><textarea value={input} onChange={(event) => setInput(event.target.value)} spellCheck={false} className="mt-2 min-h-52 w-full rounded-md border bg-background p-3 font-mono text-xs outline-none focus:ring-2 focus:ring-ring" /><button disabled={!selectedAgent || busy || selectedAgent.health.status !== 'configured'} onClick={() => void runAgent()} className="mt-3 inline-flex items-center gap-2 rounded-md bg-foreground px-3 py-2 text-sm font-medium text-background disabled:opacity-50"><Play className="h-4 w-4" />{busy ? '执行中…' : '运行并记录用量'}</button></section>
        {result !== null && <section className="rounded-xl border bg-card p-4"><h2 className="font-medium">映射后的执行结果</h2><pre className="mt-3 max-h-[440px] overflow-auto rounded-md bg-muted p-3 text-xs leading-5">{String(JSON.stringify(result, null, 2) ?? '')}</pre></section>}</div>
      </section>}

      {tab === 'usage' && <section className="space-y-5"><div><h2 className="font-medium">我的用量</h2><p className="mt-1 text-sm text-muted-foreground">只展示你自己的调用聚合；不会存储任务正文、输出内容或任何密钥。Token 仅在下游服务实际返回 usage 时统计。</p></div><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{usageCards(data.ownUsage).map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}</div><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按 Agent</h2><UsageRows rows={data.ownUsage.byAgent} empty="尚无个人调用记录。" /></section></section>}

      {tab === 'team' && isAdmin && <section className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{usageCards(usage?.total ?? data.ownUsage).map(([label, value]) => <div key={String(label)} className="rounded-xl border bg-card p-4"><p className="text-xs text-muted-foreground">{label}</p><p className="mt-1 text-2xl font-semibold">{value}</p></div>)}</div>
        <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border bg-card p-4"><h2 className="flex items-center gap-2 font-medium"><Building2 className="h-4 w-4" />部门</h2><div className="mt-3 flex gap-2"><input value={departmentName} onChange={(event) => setDepartmentName(event.target.value)} className="min-w-0 flex-1 rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如：市场部" /><button onClick={() => void addDepartment()} className="rounded-md border px-3 text-sm">新建</button></div><div className="mt-3 space-y-2">{data.departments?.map((department) => <div key={department.id} className="flex justify-between rounded-md bg-muted/60 px-3 py-2 text-sm"><span>{department.name}</span><span className="text-muted-foreground">{usage?.byDepartment.find((item) => item.id === department.id)?.calls ?? 0} 次</span></div>)}</div></section>
        <section className="rounded-xl border bg-card p-4"><h2 className="flex items-center gap-2 font-medium"><ShieldCheck className="h-4 w-4" />开通成员账号</h2><div className="mt-3 grid gap-2 sm:grid-cols-2"><input value={newUser.username} onChange={(event) => setNewUser({ ...newUser, username: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="用户名" /><input value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="姓名" /><input value={newUser.password} type="password" onChange={(event) => setNewUser({ ...newUser, password: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm" placeholder="初始密码（至少 10 位）" /><select value={newUser.departmentId} onChange={(event) => setNewUser({ ...newUser, departmentId: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm">{data.departments?.map((department) => <option key={department.id} value={department.id}>{department.name}</option>)}</select><select value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value })} className="rounded-md border bg-background px-3 py-2 text-sm"><option value="member">成员</option><option value="admin">管理员</option></select><button onClick={() => void addUser()} className="rounded-md bg-foreground px-3 py-2 text-sm text-background">开通账号</button></div></section></div>
        <section className="rounded-xl border bg-card p-4"><h2 className="font-medium">账号与个人用量</h2><div className="mt-3 overflow-auto"><table className="w-full min-w-[620px] text-left text-sm"><thead className="border-b text-xs text-muted-foreground"><tr><th className="p-2">成员</th><th className="p-2">部门</th><th className="p-2">角色</th><th className="p-2">调用</th><th className="p-2">状态</th><th className="p-2"></th></tr></thead><tbody>{data.users?.map((user) => <tr key={user.id} className="border-b border-border/50"><td className="p-2"><strong>{user.displayName}</strong><span className="ml-2 text-xs text-muted-foreground">{user.username}</span></td><td className="p-2">{data.departments?.find((item) => item.id === user.departmentId)?.name ?? '-'}</td><td className="p-2">{user.role === 'admin' ? '管理员' : '成员'}</td><td className="p-2">{usage?.byUser.find((item) => item.id === user.id)?.calls ?? 0}</td><td className="p-2">{user.status === 'active' ? '启用' : '已禁用'}</td><td className="p-2"><button disabled={user.id === data.identity.userId} onClick={() => void toggleUser(user)} className="rounded border px-2 py-1 text-xs disabled:opacity-40">{user.status === 'active' ? '禁用' : '启用'}</button></td></tr>)}</tbody></table></div></section>
        <div className="grid gap-5 xl:grid-cols-2"><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按部门用量</h2><UsageRows rows={usage?.byDepartment} empty="尚无部门调用记录。" /></section><section className="rounded-xl border bg-card p-4"><h2 className="font-medium">按 Agent 用量</h2><UsageRows rows={usage?.byAgent} empty="尚无 Agent 调用记录。" /></section></div>
      </section>}

      {tab === 'config' && isAdmin && <section className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_330px]"><div className="rounded-xl border bg-card p-4"><h2 className="font-medium">Agent Manifest</h2><p className="mt-1 text-xs text-muted-foreground">在这里新增、编辑或删除 Agent。保存后，工作台和 MCP Server 会读取更新后的配置；真实密钥不要写进 JSON。可通过 access.departmentIds / access.roles 限定成员可见与可调用范围，服务端会再次校验。</p><textarea value={config} onChange={(event) => setConfig(event.target.value)} spellCheck={false} className="mt-3 min-h-[460px] w-full rounded-md border bg-background p-3 font-mono text-xs" /><button onClick={() => void saveConfig()} className="mt-3 rounded-md bg-foreground px-3 py-2 text-sm text-background">校验并保存</button></div><aside className="rounded-xl border bg-card p-4"><h2 className="font-medium">Secret Store</h2><p className="mt-1 text-xs text-muted-foreground">管理员在此配置模型、Dify、Fish 等连接所需 Key。值仅加密存储在服务端，不回显给任何成员。</p><input value={newSecret.name} onChange={(event) => setNewSecret({ ...newSecret, name: event.target.value })} className="mt-3 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="DIFY_API_KEY" /><input value={newSecret.value} onChange={(event) => setNewSecret({ ...newSecret, value: event.target.value })} type="password" className="mt-2 w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="粘贴密钥或地址" /><button onClick={() => void saveSecret()} className="mt-2 rounded-md border px-3 py-2 text-sm">加密保存</button></aside></section>}
    </div>
  )
}
