import { Router } from '../http/router.ts';
import { registerAuthRoutes } from './auth.ts';
import { registerLibraryRoutes } from './libraries.ts';
import { registerPageRoutes } from './pages.ts';
import { registerSourceRoutes } from './sources.ts';
import { registerSearchRoutes } from './search.ts';
import { registerAdminRoutes } from './admin.ts';
import { registerAgentRoutes } from './agent.ts';
import { registerMcpRoutes } from './mcp.ts';
import { registerEventRoutes } from './events.ts';
import { registerReviewRoutes } from './review.ts';
import { registerWecomAuthRoutes } from './wecom.ts';
import { registerOidcRoutes } from './oidc.ts';
import { registerScimRoutes } from './scim.ts';
import { registerOntologyRoutes } from './ontology.ts';
import { registerSocialRoutes } from './social.ts';
import { registerExportRoutes } from './export.ts';

export function createRouter(): Router {
  const router = new Router();
  registerAuthRoutes(router);
  registerLibraryRoutes(router);
  registerPageRoutes(router);
  registerSourceRoutes(router);
  registerSearchRoutes(router);
  registerAdminRoutes(router);
  registerAgentRoutes(router);
  registerMcpRoutes(router);
  registerEventRoutes(router);
  registerReviewRoutes(router);
  registerWecomAuthRoutes(router);
  registerOidcRoutes(router);
  registerScimRoutes(router);
  registerOntologyRoutes(router);
  registerSocialRoutes(router);
  registerExportRoutes(router);
  return router;
}
