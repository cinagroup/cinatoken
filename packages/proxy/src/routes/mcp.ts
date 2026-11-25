import type { Context } from 'hono';
import { scheduleResourceCompletion } from '../runtime/schedule-resource-completion';
/**
 * `POST /mcp` aggregates every enabled upstream.
 * `POST /mcp/:slug` exposes one server.
 * Stateless Streamable HTTP: no session id, GET is 405.
 */
import { Hono } from 'hono';
import { requireMcpCaller, type McpCaller, type McpEnv } from '../middleware/mcp-auth';
import { handleMcpAggregateRequest, mcpAggregateDeps } from '../services/mcp/aggregate';

export const mcpRoutes = new Hono<McpEnv>();

mcpRoutes.use('*', requireMcpCaller);
mcpRoutes.on(['GET','DELETE'],'*',c=>c.json({jsonrpc:'2.0',id:null,error:{code:-32000,message:'Method not allowed'}},405,{Allow:'POST'}));

async function serve(c: Context<McpEnv>) {
	const slug = c.req.param('slug')?.trim() || null;
	if (slug === 'builtin') {
		return new Response(
			JSON.stringify({ jsonrpc: '2.0', error: { code: -32602, message: 'Unknown MCP server' }, id: null }),
			{
				status: 404,
				headers: { 'Content-Type': 'application/json' },
			},
		);
	}
	const apiKey = c.get('apiKey');
	if (!apiKey) throw new Error('Missing authenticated MCP actor');
	const repos = c.get('repositories') as Parameters<typeof mcpAggregateDeps>[0];
	return handleMcpAggregateRequest(c.req.raw, {
		apiKey,
		slug,
		deps: mcpAggregateDeps(repos, (task) => scheduleResourceCompletion(c, task)),
	});
}

mcpRoutes.all('/', (c) => serve(c));
mcpRoutes.all('/:slug', (c) => serve(c));
