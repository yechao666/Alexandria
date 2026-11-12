import type { Router } from '../http/router.ts';
import type { RequestContext } from '../http/context.ts';
import { oidcConfigured, beginOidc, completeOidc } from '../domain/oidc.ts';

function redirect(rc: RequestContext, location: string): void {
  rc.res.statusCode = 302;
  rc.res.setHeader('location', location);
  rc.res.end();
}

export function registerOidcRoutes(router: Router): void {
  router.get('/api/auth/oidc/start', async (rc) => {
    if (!oidcConfigured(rc.app.env)) return redirect(rc, '/#/login?error=oidc_unavailable');
    const target = await beginOidc(rc);
    redirect(rc, target ?? '/#/login?error=oidc_api');
  });

  router.get('/api/auth/oidc/callback', async (rc) => {
    const result = await completeOidc(rc);
    if (!result.ok) return redirect(rc, `/#/login?error=${encodeURIComponent(result.error ?? 'oidc_api')}`);
    redirect(rc, result.returnTo ?? '/#/');
  });
}
