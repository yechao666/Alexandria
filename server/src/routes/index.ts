import { Router } from '../http/router.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerLibraryRoutes } from './libraries.ts';
import { registerPageRoutes } from './pages.ts';
import { registerSourceRoutes } from './sources.ts';
import { registerSearchRoutes } from './search.ts';
import { registerAdminRoutes } from './admin.ts';
import { registerAgentRoutes } from './agent.ts';

export function createRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerLibraryRoutes(router);
  registerPageRoutes(router);
  registerSourceRoutes(router);
  registerSearchRoutes(router);
  registerAdminRoutes(router);
  registerAgentRoutes(router);
  return router;
}
