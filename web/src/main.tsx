import "@fontsource-variable/public-sans";
import "./styles/tokens.css";
import "./styles/base.css";
import { RegistryProvider } from "@effect/atom-react";
import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { router } from "./router.tsx";

const root = document.getElementById("root");

if (root === null) throw new Error("index.html has no #root element");

createRoot(root).render(
  <StrictMode>
    <RegistryProvider>
      <RouterProvider router={router} />
    </RegistryProvider>
  </StrictMode>,
);
