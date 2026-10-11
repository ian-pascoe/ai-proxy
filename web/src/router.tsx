// Page routes (code-based, no generator). The Worker answers every one of these paths with index.html
// (src/access/routes.ts `PANEL_SECTIONS`); add a section there when adding a top-level page here.
import { createRootRoute, createRoute, createRouter } from "@tanstack/react-router";
import { Shell } from "./components/Shell.tsx";
import { AccountPage } from "./pages/Account.tsx";
import { AccountsPage } from "./pages/Accounts.tsx";
import { ConnectPage } from "./pages/Connect.tsx";
import { KeyGroupPage, NewKeyGroupPage } from "./pages/KeyGroup.tsx";
import { KeysPage } from "./pages/Keys.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { NotFound, Placeholder } from "./pages/Placeholder.tsx";
import { UsagePage } from "./pages/Usage.tsx";
import { readNewKeySearch } from "./lib/keys.ts";
import { readUsageSearch } from "./lib/usage.ts";

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
  createRoute({ getParentRoute: () => rootRoute, path: "/keys", component: KeysPage }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/keys/new",
    validateSearch: readNewKeySearch,
    component: NewKeyGroupPage,
  }),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/keys/$family/$index",
    component: KeyGroupPage,
  }),
  page(
    "/models",
    "Models",
    "The models clients can call, which accounts serve each one, aliases and exclusions.",
  ),
  createRoute({
    getParentRoute: () => rootRoute,
    path: "/usage",
    validateSearch: readUsageSearch,
    component: UsagePage,
  }),
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
