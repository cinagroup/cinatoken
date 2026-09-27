/** Keep native WebSocket authentication and Node Upgrade routing path-exact. */
export function isDashScopeRealtimePath(path: string): boolean {
	return path === '/v1/dashscope/realtime' || path === '/api/v1/dashscope/realtime';
}
