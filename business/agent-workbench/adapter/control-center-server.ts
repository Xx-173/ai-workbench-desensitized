#!/usr/bin/env node
/** Local web Control Center for Agent manifests, secrets and usage. */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentControlPlane, FileManifestStore } from '../src/control-plane.ts';
import { EncryptedFileSecretVault } from '../src/secret-vault.ts';
import { JsonlUsageLedger } from '../src/usage-ledger.ts';

export interface ControlCenterConfig {
  readonly workspaceRootPath: string;
  readonly host: string;
  readonly port: number;
  readonly manifestsPath: string;
  readonly secretStorePath: string;
  readonly masterKeyEnv: string;
  readonly adminToken?: string;
}

function readArg(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function parseControlCenterArgs(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): ControlCenterConfig {
  const workspaceRootPath = readArg(argv, '--workspace-root');
  if (!workspaceRootPath) throw new Error('--workspace-root is required');
  const host = readArg(argv, '--host') ?? '127.0.0.1';
  const portText = readArg(argv, '--port') ?? '4318';
  const port = Number(portText);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be 1..65535');
  const controlDir = join(workspaceRootPath, '.agent-workbench');
  const masterKeyEnv = readArg(argv, '--master-key-env') ?? 'AGENT_WORKBENCH_MASTER_KEY';
  const adminTokenEnv = readArg(argv, '--admin-token-env') ?? 'AGENT_WORKBENCH_ADMIN_TOKEN';
  const adminToken = env[adminTokenEnv];
  const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';
  if (!isLoopback && !adminToken) throw new Error('A non-loopback Control Center requires AGENT_WORKBENCH_ADMIN_TOKEN');
  return {
    workspaceRootPath,
    host,
    port,
    manifestsPath: readArg(argv, '--agents-config') ?? join(controlDir, 'agents.json'),
    secretStorePath: readArg(argv, '--secret-store') ?? join(controlDir, 'secrets.enc.json'),
    masterKeyEnv,
    ...(adminToken ? { adminToken } : {}),
  };
}

function page(): string {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Agent Control Center</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui,"Microsoft YaHei",sans-serif;color:#172033;background:#f5f7fb}body{margin:0}.wrap{max-width:1150px;margin:0 auto;padding:32px 20px 64px}header{display:flex;justify-content:space-between;gap:16px;align-items:start;margin-bottom:24px}h1{margin:0;font-size:28px}h2{margin:0 0 14px;font-size:18px}p,.muted{color:#5c687d}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}.card{background:#fff;border:1px solid #e4e8f0;border-radius:12px;padding:18px;box-shadow:0 4px 14px #243b5a0a}.stat{font-size:28px;font-weight:700;margin-top:8px}.row{display:flex;justify-content:space-between;align-items:center;gap:12px}.badge{border-radius:999px;padding:3px 9px;font-size:12px;background:#edf2ff;color:#244bd6}.bad{background:#fff0f0;color:#b42318}textarea,input{box-sizing:border-box;width:100%;border:1px solid #ccd4e0;border-radius:8px;padding:10px;font:13px ui-monospace,SFMono-Regular,Consolas,monospace;background:#fff}textarea{min-height:360px;resize:vertical}button{border:0;border-radius:8px;background:#2457d6;color:#fff;padding:9px 12px;cursor:pointer;font-weight:600}button.secondary{background:#eaf0ff;color:#2349ab}button.danger{background:#c9382d}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}.agent{border-top:1px solid #eef1f5;padding:12px 0}.agent:first-child{border-top:0}.agent code{font-size:12px;background:#f2f4f8;padding:2px 5px;border-radius:4px}.notice{margin-top:10px;padding:10px;border-radius:8px;background:#ecfdf3;color:#067647;display:none}.error{background:#fff0f0;color:#b42318}.table{width:100%;border-collapse:collapse;font-size:13px}.table th,.table td{text-align:left;padding:9px;border-bottom:1px solid #edf0f4}.two{display:grid;grid-template-columns:2fr 1fr;gap:16px}@media(max-width:800px){.two{grid-template-columns:1fr}}
</style></head><body><main class="wrap"><header><div><h1>Agent Control Center</h1><p>本地控制面：Manifest、Key 引用、执行策略和无原文用量统计。</p></div><span class="badge">仅本地绑定</span></header>
<section class="grid" id="stats"><div class="card">正在加载…</div></section>
<section class="card" style="margin-top:16px"><h2>Agent 清单与健康状态</h2><p class="muted">“检查”只验证本地配置和 Key 引用，不会自动向 Dify、Fish、Coze 发起网络请求。</p><div id="agents"></div></section>
<section class="two" style="margin-top:16px"><section class="card"><h2>Manifest 配置</h2><p class="muted">在此保存 Agent、重试、限流、日配额与成本估算规则。真实 Key 不应写进该 JSON。</p><textarea id="config" spellcheck="false"></textarea><div class="toolbar"><button onclick="saveConfig()">校验并保存配置</button><button class="secondary" onclick="loadAll()">重新读取</button></div><div id="configNotice" class="notice"></div></section>
<section class="card"><h2>Secret Store</h2><p class="muted">值采用本地 AES-256-GCM 加密；页面永不回显已保存的值。</p><input id="secretName" placeholder="例如 DIFY_API_KEY"><div style="height:8px"></div><input id="secretValue" type="password" placeholder="粘贴 Key 或地址"><div class="toolbar"><button onclick="saveSecret()">保存引用值</button></div><div id="secrets"></div></section></section>
<section class="card" style="margin-top:16px"><h2>用量与估算成本</h2><table class="table"><thead><tr><th>Agent</th><th>调用</th><th>成功/失败</th><th>耗时</th><th>Token</th><th>估算成本</th></tr></thead><tbody id="usage"></tbody></table></section>
</main><script>
const q=s=>document.querySelector(s);let config={};const adminToken=new URLSearchParams(location.hash.slice(1)).get('token');
async function api(path,options={}){const r=await fetch(path,{headers:{'content-type':'application/json',...(adminToken?{authorization:'Bearer '+adminToken}:{}),...(options.headers||{})},...options});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||r.statusText);return data}
function notice(id,message,error=false){const e=q(id);e.textContent=message;e.className='notice'+(error?' error':'');e.style.display='block';setTimeout(()=>e.style.display='none',4200)}
function policy(agent){const p=agent.policy||{};const parts=[];if(p.retry)parts.push('重试 '+p.retry.maxAttempts+' 次');if(p.rateLimit)parts.push('限流 '+p.rateLimit.maxRequests+'/'+Math.round(p.rateLimit.windowMs/1000)+'s');if(p.quota)parts.push('日配额 '+(p.quota.maxCallsPerDay||'-')+' 调用 / '+(p.quota.maxTokensPerDay||'-')+' token');return parts.join(' · ')||'未设置运行策略'}
async function health(id){try{const h=await api('/api/agents/'+encodeURIComponent(id)+'/health',{method:'POST'});alert(h.status==='configured'?'配置完整':'缺少：'+h.missingReferences.join(', '))}catch(e){alert(e.message)}}
function renderAgents(){q('#agents').innerHTML=config.agents.length?config.agents.map(a=>'<div class="agent"><div class="row"><strong>'+a.id+'</strong><span class="badge">'+a.kind+'</span></div><div class="muted">'+a.description+'</div><div style="margin:7px 0"><code>'+a.toolName+'</code> · '+policy(a)+'</div><button class="secondary" onclick="health(\''+a.id+'\')">检查配置</button></div>').join(''):'<p class="muted">尚未添加 Agent。可从仓库的 agents.example.json 复制模板。</p>'}
function renderDashboard(d){q('#stats').innerHTML='<div class="card"><div class="muted">已登记 Agent</div><div class="stat">'+d.agents+'</div></div><div class="card"><div class="muted">已配置 Key / 地址引用</div><div class="stat">'+d.configuredSecrets+'</div></div><div class="card"><div class="muted">已统计调用</div><div class="stat">'+d.usage.reduce((n,x)=>n+x.calls,0)+'</div></div>';q('#usage').innerHTML=d.usage.length?d.usage.map(x=>'<tr><td>'+x.agentId+'</td><td>'+x.calls+'</td><td>'+x.successes+'/'+x.failures+'</td><td>'+x.durationMs+'ms</td><td>'+(x.inputTokens+x.outputTokens)+'</td><td>'+ (x.estimatedCost===null?'-':x.estimatedCost.toFixed(6)+' '+x.currency)+'</td></tr>').join(''):'<tr><td colspan="6" class="muted">尚无调用记录</td></tr>'}
function renderSecrets(items){q('#secrets').innerHTML=items.length?'<div class="muted" style="margin-top:12px">'+items.map(x=>'<div class="row" style="padding:6px 0"><code>'+x.name+'</code><button class="danger" onclick="deleteSecret(\''+x.name+'\')">删除</button></div>').join('')+'</div>':'<p class="muted">暂无已配置引用</p>'}
async function loadAll(){try{config=await api('/api/config');q('#config').value=JSON.stringify(config,null,2);renderAgents();renderDashboard(await api('/api/dashboard'));renderSecrets(await api('/api/secrets'))}catch(e){notice('#configNotice',e.message,true)}}
async function saveConfig(){try{const next=JSON.parse(q('#config').value);config=await api('/api/config',{method:'PUT',body:JSON.stringify(next)});renderAgents();notice('#configNotice','已通过校验并保存。MCP Server 可在下一次请求时重新加载此文件。')}catch(e){notice('#configNotice',e.message,true)}}
async function saveSecret(){try{await api('/api/secrets',{method:'POST',body:JSON.stringify({name:q('#secretName').value,value:q('#secretValue').value})});q('#secretValue').value='';renderSecrets(await api('/api/secrets'));renderDashboard(await api('/api/dashboard'))}catch(e){alert(e.message)}}
async function deleteSecret(name){if(!confirm('删除 '+name+'？'))return;await api('/api/secrets/'+encodeURIComponent(name),{method:'DELETE'});renderSecrets(await api('/api/secrets'));renderDashboard(await api('/api/dashboard'))}
loadAll();
</script></body></html>`;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    length += buffer.length;
    if (length > 1_000_000) throw new Error('Request body exceeds 1 MB');
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
}

function authorized(request: IncomingMessage, token: string | undefined): boolean {
  return !token || request.headers.authorization === `Bearer ${token}`;
}

export async function startControlCenter(config: ControlCenterConfig): Promise<void> {
  const masterKey = process.env[config.masterKeyEnv];
  if (!masterKey) throw new Error(`Missing required master-key environment variable: ${config.masterKeyEnv}`);
  const plane = new AgentControlPlane(
    new FileManifestStore(config.manifestsPath),
    await EncryptedFileSecretVault.open(config.secretStorePath, masterKey),
    new JsonlUsageLedger(join(config.workspaceRootPath, '.agent-workbench', 'usage.jsonl')),
  );
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? '/', `http://${config.host}`).pathname;
      if (request.method === 'GET' && pathname === '/') {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return response.end(page());
      }
      if (!authorized(request, config.adminToken)) return sendJson(response, 401, { error: 'Unauthorized' });
      if (request.method === 'GET' && pathname === '/api/config') return sendJson(response, 200, await plane.getConfig());
      if (request.method === 'PUT' && pathname === '/api/config') return sendJson(response, 200, await plane.replaceConfig(await readJson(request)));
      if (request.method === 'GET' && pathname === '/api/secrets') return sendJson(response, 200, await plane.listSecrets());
      if (request.method === 'POST' && pathname === '/api/secrets') {
        const body = await readJson(request) as { name?: unknown; value?: unknown };
        if (typeof body.name !== 'string' || typeof body.value !== 'string') throw new Error('name and value are required');
        await plane.setSecret(body.name, body.value);
        return sendJson(response, 201, { name: body.name, configured: true });
      }
      const secretMatch = pathname.match(/^\/api\/secrets\/([A-Z][A-Z0-9_]*)$/);
      if (request.method === 'DELETE' && secretMatch) {
        await plane.deleteSecret(secretMatch[1]!);
        return sendJson(response, 200, { deleted: secretMatch[1] });
      }
      const healthMatch = pathname.match(/^\/api\/agents\/([A-Za-z][A-Za-z0-9_-]*)\/health$/);
      if (request.method === 'POST' && healthMatch) return sendJson(response, 200, await plane.checkAgent(healthMatch[1]!));
      if (request.method === 'GET' && pathname === '/api/dashboard') return sendJson(response, 200, await plane.dashboard());
      return sendJson(response, 404, { error: 'Not found' });
    } catch (error) {
      return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => resolve());
  });
  console.error(`Agent Control Center listening on http://${config.host}:${config.port}`);
}

function isDirectRun(): boolean {
  return process.argv[1] === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  startControlCenter(parseControlCenterArgs(process.argv.slice(2))).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
