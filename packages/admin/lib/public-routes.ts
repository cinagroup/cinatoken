/**
 * Routes rendered without the administrator authentication shell.
 *
 * Keep this list explicit: publishing a page is a product and access-control
 * decision, not a side effect of adding a directory below `app/`.
 */
export function isPublicProductPath(pathname: string): boolean {
	if (pathname === '/') return true;
	if (pathname === '/models' || pathname.startsWith('/models/')) return true;
	if (['/providers', '/compare', '/chat', '/rankings', '/benchmarks'].includes(pathname)) return true;
	return pathname === '/account' || pathname.startsWith('/account/');
}
