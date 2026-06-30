// Local/remote integration smoke test: real MCP client -> server -> live CIS + write-gate.
// Usage: MCP_URL=... MCP_KEY=... node test/smoke.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.env.MCP_URL ?? 'http://localhost:8080/mcp');
const key = process.env.MCP_KEY ?? 'dev-secret-123';
const sub = process.env.SUB ?? '3011fbeb-4a97-4657-8c30-6bf4b3ffc3fe';

const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${key}` } },
});
const client = new Client({ name: 'smoke', version: '1.0.0' });
await client.connect(transport);

const { tools } = await client.listTools();
for (const t of tools) {
  const actions = t.inputSchema.properties?.action?.enum?.join(',') ?? '(no action param)';
  console.log('TOOL', t.name, '=>', actions);
}

const envs = await client.callTool({ name: 'BTPInspect', arguments: { action: 'environments' } });
const et = envs.content?.[0]?.text ?? JSON.stringify(envs);
console.log(
  'READ  environments:',
  envs.isError ? `ERROR ${et.slice(0, 200)}` : `OK ${et.slice(0, 140).replace(/\s+/g, ' ')}`,
);

const w = await client.callTool({
  name: 'BTPServices',
  arguments: { action: 'create_service', subaccount: sub, name: 'smoke-svc', offering: 'xsuaa', plan: 'application' },
});
console.log(
  'WRITE create_service:',
  `${w.isError ? 'BLOCKED/GATED ' : 'UNEXPECTED-OK '}${(w.content?.[0]?.text ?? '').slice(0, 160)}`,
);

await client.close();
