import { FormEvent, useEffect, useMemo, useState } from 'react'

type Agent = { id: string; name: string; kind: string; description: string; icon: string; endpoint?: string; secretReferenceId?: string; secretReference?: { id: string; name: string; environmentVariable: string }; departmentIds: string[]; departmentNames: string[]; enabled: boolean }
type Dashboard = {
  currentUser: { id: string; displayName: string; username: string; departmentId: string; departmentName: string; role: 'admin' | 'member' }
  agents: Agent[]; recentUsage: Array<{ id: string; agentName: string; memberName: string; departmentName: string; status: string; createdAt: string }>
  summary: { totalRuns: number; configuredAgents: number; activeAgents: number }
  admin?: { departments: Array<{ id: string; name: string }>; members: Array<{ id: string; displayName: string; username: string; departmentId: string; departmentName: string; role: string; status: string }>; allAgents: Agent[]; secrets: Array<{ id: string; name: string; environmentVariable: string }> }
}

function normalizeDashboard(raw: any): Dashboard {
  const identity = raw.identity
  const agentIcon: Record<string, string> = { dify: '▶', fish: '♫', python: '✦', http: '⌁', mcp: '◇' }
  const agents = (raw.agents ?? []).map((agent: any) => ({
    id: agent.id, name: agent.toolName ?? agent.id, kind: agent.kind ?? 'http', description: agent.description ?? '已接入业务能力',
    icon: agentIcon[agent.kind] ?? '✦', endpoint: agent.health?.status === 'healthy' ? 'configured' : undefined,
    secretReferenceId: undefined, departmentIds: [], departmentNames: [], enabled: agent.health?.status !== 'disabled',
  }))
  const users = raw.users ?? []
  return {
    currentUser: { id: identity.userId, displayName: identity.displayName, username: identity.username, departmentId: identity.departmentId, departmentName: identity.departmentId, role: identity.role },
    agents, recentUsage: [],
    summary: { totalRuns: raw.ownUsage?.calls ?? 0, configuredAgents: agents.filter((agent: Agent) => Boolean(agent.endpoint)).length, activeAgents: agents.length },
    ...(identity.role === 'admin' ? { admin: { departments: raw.departments ?? [], members: users.map((user: any) => ({ id: user.id, username: user.username, displayName: user.displayName, departmentId: user.departmentId, departmentName: user.departmentId, role: user.role, status: user.status })), allAgents: agents, secrets: [] } } : {}),
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }, ...init })
  if (response.status === 401) { window.location.href = '/login'; throw new Error('登录已失效') }
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(payload.error || '请求失败')
  return payload as T
}

const kindLabel: Record<string, string> = { dify: 'Dify 工作流', fish: 'Fish 音色服务', python: 'Python 脚本', http: 'HTTP 服务' }

export default function App() {
  const [data, setData] = useState<Dashboard | null>(null)
  const [page, setPage] = useState<'home' | 'agents' | 'admin'>('home')
  const [selected, setSelected] = useState<Agent | null>(null)
  const [taskInput, setTaskInput] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const isAdmin = data?.currentUser.role === 'admin'

  const refresh = async () => {
    try { setData(normalizeDashboard(await request('/api/workbench/bootstrap'))); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : '加载失败') }
  }
  useEffect(() => { void refresh() }, [])
  const submit = async (path: string, body: unknown, method = 'POST') => {
    try { await request(path, { method, body: JSON.stringify(body) }); await refresh(); setNotice('已保存'); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : '操作失败') }
  }
  const runAgent = async () => {
    if (!selected) return
    try { const result = await request<{ summary?: string }>('/api/workbench/invoke', { method: 'POST', body: JSON.stringify({ agentId: selected.id, input: { task: taskInput } }) }); setNotice(result.summary || '任务已提交'); setSelected(null); setTaskInput(''); await refresh() } catch (reason) { setError(reason instanceof Error ? reason.message : '任务提交失败') }
  }
  const usable = data?.agents ?? []
  const adminData = data?.admin
  const header = useMemo(() => data ? `${data.currentUser.departmentName} · ${data.currentUser.displayName}` : '正在加载', [data])
  if (!data) return <main className="loading"><div className="brand-mark">智</div><p>{error || '正在连接智能工作台…'}</p><button onClick={() => void refresh()}>重新连接</button></main>

  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span className="brand-mark">智</span><span>智能工作台<small>TEAM AI HUB</small></span></div>
      <nav><button className={page === 'home' ? 'active' : ''} onClick={() => setPage('home')}><b>◈</b>工作台</button><button className={page === 'agents' ? 'active' : ''} onClick={() => setPage('agents')}><b>✦</b>Agent 中心</button>{isAdmin && <button className={page === 'admin' ? 'active' : ''} onClick={() => setPage('admin')}><b>⚙</b>管理控制台</button>}</nav>
      <div className="sidebar-note"><span className="online" />服务连接受控<br /><small>凭据仅由管理员配置</small></div>
      <button className="account" onClick={() => { void fetch('/api/auth/logout', { method: 'POST' }); window.location.href = '/login' }}><span className="avatar">{data.currentUser.displayName.slice(0, 1)}</span><span>{header}<small>退出登录</small></span></button>
    </aside>
    <main className="content">
      {notice && <div className="toast success" onClick={() => setNotice('')}>{notice}</div>}{error && <div className="toast error" onClick={() => setError('')}>{error}</div>}
      {page === 'home' && <><header><div><p className="eyebrow">BUSINESS AI OPERATIONS</p><h1>早上好，{data.currentUser.displayName}</h1><p className="muted">选择一个已授权的业务 Agent，系统会自动使用管理员配置的连接与凭据。</p></div><button className="secondary" onClick={() => setPage('agents')}>查看全部 Agent →</button></header><section className="stat-grid"><Stat label="可用 Agent" value={data.summary.activeAgents} note="按部门自动授权" /><Stat label="已配置连接" value={data.summary.configuredAgents} note="由管理员统一托管" /><Stat label="累计调用" value={data.summary.totalRuns} note="已计入部门与个人" /></section><section><div className="section-heading"><div><p className="eyebrow">RECOMMENDED</p><h2>常用能力</h2></div><span className="muted">不需要选择底层模型</span></div><AgentGrid agents={usable.slice(0, 4)} onSelect={setSelected} /></section><UsageTable records={data.recentUsage} /></>}
      {page === 'agents' && <><header><div><p className="eyebrow">AGENT CATALOG</p><h1>Agent 中心</h1><p className="muted">当前展示你所在部门可使用的能力。每项能力可对接 Dify、Fish、Python 或自建 HTTP 服务。</p></div></header><AgentGrid agents={usable} onSelect={setSelected} expanded /></>}
      {page === 'admin' && isAdmin && adminData && <AdminPanel data={adminData} submit={submit} />}
    </main>
    {selected && <div className="modal-backdrop" onMouseDown={() => setSelected(null)}><section className="modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setSelected(null)}>×</button><span className="agent-icon large">{selected.icon}</span><p className="eyebrow">{kindLabel[selected.kind]}</p><h2>{selected.name}</h2><p className="muted">{selected.description}</p><label>任务说明<textarea autoFocus placeholder="例如：上传一段课程转写，提炼 4 个章节与 3 条传播文案" value={taskInput} onChange={(event) => setTaskInput(event.target.value)} /></label><button className="primary" onClick={() => void runAgent()}>提交任务</button><p className="hint">运行记录会计入你的个人与部门使用统计。</p></section></div>}
  </div>
}

function Stat({ label, value, note }: { label: string; value: number; note: string }) { return <article className="stat"><p>{label}</p><strong>{value}</strong><small>{note}</small></article> }
function AgentGrid({ agents, onSelect, expanded }: { agents: Agent[]; onSelect: (agent: Agent) => void; expanded?: boolean }) { return <div className={expanded ? 'agent-grid expanded' : 'agent-grid'}>{agents.map((agent) => <article className="agent-card" key={agent.id}><div className="agent-top"><span className="agent-icon">{agent.icon}</span><span className={agent.endpoint ? 'tag ready' : 'tag'}>{agent.endpoint ? '已配置' : '待配置'}</span></div><h3>{agent.name}</h3><p>{agent.description}</p><footer><span>{kindLabel[agent.kind]}</span><button onClick={() => onSelect(agent)}>使用 Agent →</button></footer></article>)}</div> }
function UsageTable({ records }: { records: Dashboard['recentUsage'] }) { return <section className="usage"><div className="section-heading"><div><p className="eyebrow">ACTIVITY</p><h2>最近使用</h2></div></div>{records.length === 0 ? <div className="empty">还没有任务记录。先从上方选择一个 Agent 开始。</div> : <div className="table">{records.map((record) => <div className="row" key={record.id}><span className="dot" /><b>{record.agentName}</b><span>{record.memberName} · {record.departmentName}</span><span className={record.status === 'succeeded' ? 'status ok' : 'status'}>{record.status === 'succeeded' ? '已完成' : record.status === 'failed' ? '调用失败' : '待管理员配置'}</span><time>{new Date(record.createdAt).toLocaleString()}</time></div>)}</div>}</section> }
function AdminPanel({ data, submit }: { data: NonNullable<Dashboard['admin']>; submit: (path: string, body: unknown, method?: string) => Promise<void> }) {
  const [member, setMember] = useState({ username: '', displayName: '', password: '', departmentId: data.departments[0]?.id ?? '', role: 'member' }); const [secret, setSecret] = useState({ name: '', value: '' }); const [newAgent, setNewAgent] = useState({ name: '', kind: 'http', description: '' })
  return <><header><div><p className="eyebrow">ADMIN CONTROL PLANE</p><h1>管理控制台</h1><p className="muted">成员、部门、连接地址与凭据都在此统一管理；业务员工不会看到模型选择或密钥。</p></div></header><section className="admin-grid"><article className="panel"><h2>部门与成员</h2><form onSubmit={(event: FormEvent) => { event.preventDefault(); void submit('/api/workbench/users', member).then(() => setMember({ ...member, username: '', displayName: '', password: '' })) }}><input placeholder="登录账号" value={member.username} onChange={(e) => setMember({ ...member, username: e.target.value })} /><input placeholder="姓名" value={member.displayName} onChange={(e) => setMember({ ...member, displayName: e.target.value })} /><input placeholder="初始密码" type="password" value={member.password} onChange={(e) => setMember({ ...member, password: e.target.value })} /><select value={member.departmentId} onChange={(e) => setMember({ ...member, departmentId: e.target.value })}>{data.departments.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><button className="primary">开通成员账号</button></form><div className="member-list">{data.members.map((item) => <div key={item.id}><span className="avatar">{item.displayName.slice(0, 1)}</span><b>{item.displayName}<small>@{item.username} · {item.departmentName} · {item.role}</small></b><button className={item.status === 'active' ? 'text-button danger' : 'text-button'} onClick={() => void submit(`/api/workbench/users/${item.id}`, { status: item.status === 'active' ? 'disabled' : 'active' }, 'PATCH')}>{item.status === 'active' ? '停用' : '启用'}</button></div>)}</div></article><article className="panel"><h2>加密凭据库</h2><p className="muted">密钥仅在管理员提交时写入服务端加密凭据库，浏览器和普通成员不会再读取明文。</p><form onSubmit={(event) => { event.preventDefault(); void submit('/api/workbench/secrets', secret).then(() => setSecret({ name: '', value: '' })) }}><input placeholder="例如：DIFY_API_KEY" value={secret.name} onChange={(e) => setSecret({ ...secret, name: e.target.value.toUpperCase() })} /><input placeholder="粘贴真实密钥" type="password" value={secret.value} onChange={(e) => setSecret({ ...secret, value: e.target.value })} /><button className="primary">加密保存凭据</button></form><div className="empty">凭据名称与配置清单通过受控 API 管理；不会在此页面回显密钥。</div></article></section><section className="panel agents-config"><h2>Agent 连接映射</h2><p className="muted">Agent 清单由管理员通过受控配置 API 维护，支持 Dify、Fish、Python、HTTP 与 MCP；当前状态已在 Agent 中心展示。</p>{data.allAgents.map((agent) => <AgentConfig key={agent.id} agent={agent} departments={data.departments} secrets={data.secrets} submit={submit} />)}</section></>
}
function AgentConfig({ agent }: { agent: Agent; departments: Array<{ id: string; name: string }>; secrets: Array<{ id: string; name: string; environmentVariable: string }>; submit: (path: string, body: unknown, method?: string) => Promise<void> }) { return <div className="agent-config"><div><span className="agent-icon">{agent.icon}</span><b>{agent.name}<small>{kindLabel[agent.kind]}</small></b></div><span className={agent.endpoint ? 'status ok' : 'status'}>{agent.endpoint ? '连接健康' : '待配置或健康检查失败'}</span><span className="muted">由受控 Manifest 与加密凭据库管理</span></div> }
