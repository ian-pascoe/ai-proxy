// Page routes (code-based, no generator). The Worker answers every one of these paths with index.html
// (src/access/routes.ts `PANEL_SECTIONS`); add a section there when adding a top-level page here.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "./components/Shell.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { AccountsPage } from "./pages/Accounts.tsx";
import { ConnectPage } from "./pages/Connect.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { NotFound, Placeholder } from "./pages/Placeholder.tsx";

const rootRoute = createRootRoute({ component: Shell, notFoundComponent: NotFound });

const page = (path: string, title: string, holds: string) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    component: () => <Placeholder title={title} holds={holds} />,
  });

const routeTree = rootRoute.addChildren([
  createRoute({ getParentRoute: () => rootRoute, path: "/", component: OverviewPage }),
  createRoute({ getParentRoute: () => rootRoute, path: "/accounts", component: AccountsPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/accounts/connect",
    component: ConnectPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/accounts/$authIndex",
    component: AccountPage,
  }),
  page(
    "/keys",
    "API keys",
    "Provider API keys grouped by provider, with connection tests and model discovery.",
  ),
  page(
    "/models",
    "Models",
    "The models clients can call, which accounts serve each one, aliases and exclusions.",
  ),
  page(
    "/usage",
    "Usage",
    "Itemised usage by model, provider, user, account or day, and the request log.",
  ),
  page(
    "/settings",
    "Settings",
    "The settings that apply on Workers, and the raw configuration with a diff before saving.",
  ),
]);

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
