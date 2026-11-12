export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS';

export interface RouteDefinition {
  method: HttpMethod;
  path: string;
  handler: (rc: import('./context.ts').RequestContext) => void | Promise<void>;
}

interface CompiledRoute extends RouteDefinition {
  segments: string[];
}

export const METHOD_MISMATCH = 'METHOD_MISMATCH';

export interface RouteMatch {
  route: CompiledRoute;
  params: Record<string, string>;
}

export function normalizePath(pathname: string): string {
  if (!pathname) return '/';
  let value = pathname;
  while (value.length > 1 && value.endsWith('/')) value = value.slice(0, -1);
  return value || '/';
}

function split(path: string): string[] {
  return path.split('/').filter(Boolean);
}

export class Router {
  private routes: CompiledRoute[] = [];

  add(route: RouteDefinition): void {
    this.routes.push({ ...route, path: normalizePath(route.path), segments: split(route.path) });
  }
  get(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'GET', path, handler });
  }
  post(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'POST', path, handler });
  }
  patch(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'PATCH', path, handler });
  }
  delete(path: string, handler: RouteDefinition['handler']): void {
    this.add({ method: 'DELETE', path, handler });
  }

  match(method: string, pathname: string): RouteMatch | typeof METHOD_MISMATCH | null {
    const target = split(normalizePath(pathname));
    let mismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== target.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i += 1) {
        const segment = route.segments[i]!;
        const value = target[i]!;
        if (segment.startsWith(':')) {
          try {
            params[segment.slice(1)] = decodeURIComponent(value);
          } catch {
            ok = false;
            break;
          }
        } else if (segment !== value) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (route.method !== method) {
        mismatch = true;
        continue;
      }
      return { route, params };
    }
    return mismatch ? METHOD_MISMATCH : null;
  }
}
