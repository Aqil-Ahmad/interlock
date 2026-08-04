import type { BranchRef, Finding, Repo } from '@interlock/shared';

/**
 * Typed client for the daemon API.
 *
 * Models come from `@interlock/shared`, so a change to a model shape breaks the
 * UI build rather than the running page.
 */

export interface ApiClientOptions {
  /** Empty in dev: Vite proxies `/api` to the daemon. */
  readonly baseUrl?: string;
  readonly token: string;
}

export class ApiClient {
  readonly #baseUrl: string;
  readonly #token: string;

  constructor(options: ApiClientOptions) {
    this.#baseUrl = options.baseUrl ?? '';
    this.#token = options.token;
  }

  listRepos(): Promise<Repo[]> {
    return this.#get<Repo[]>('/api/repos');
  }

  listBranches(repoId: string): Promise<BranchRef[]> {
    return this.#get<BranchRef[]>(`/api/repos/${repoId}/branches`);
  }

  listFindings(repoId: string): Promise<Finding[]> {
    return this.#get<Finding[]>(`/api/repos/${repoId}/findings`);
  }

  /** Live event stream; the dashboard should reflect a new Finding within a second. */
  openEventStream(onMessage: (data: unknown) => void): WebSocket {
    const url = new URL('/ws', this.#baseUrl || window.location.origin);
    url.protocol = url.protocol.replace('http', 'ws');
    url.searchParams.set('token', this.#token);

    const socket = new WebSocket(url);
    socket.addEventListener('message', (event: MessageEvent<string>) => {
      onMessage(JSON.parse(event.data));
    });
    return socket;
  }

  async #get<T>(path: string): Promise<T> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      headers: { authorization: `Bearer ${this.#token}` },
    });
    if (!response.ok) {
      throw new Error(`Interlock API ${path} failed: ${String(response.status)}`);
    }
    return (await response.json()) as T;
  }
}
