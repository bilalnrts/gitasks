import type { ApiClient, MutationCoordinator } from "./api.js";
import type { OverlayManager, ToastManager } from "./components/overlays.js";
import type { RepositoryContext } from "./models.js";
import type { Router, AppRoute } from "./router.js";

export interface AppServices {
  api: ApiClient;
  router: Router;
  overlays: OverlayManager;
  toasts: ToastManager;
  mutations: MutationCoordinator;
  context: RepositoryContext;
  overlayRoot: HTMLElement;
  announce(message: string, urgent?: boolean): void;
}

export interface ViewController {
  update(route: AppRoute): void;
  dispose(): void;
}
