import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx";
import { ConfigError } from "./components/ConfigError.tsx";
import { AuthProvider } from "./lib/auth.tsx";
import { readConfig } from "./lib/config.ts";

const config = readConfig();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {config.ok ? (
      <BrowserRouter>
        <AuthProvider>
          <RootErrorBoundary>
            <App />
          </RootErrorBoundary>
        </AuthProvider>
      </BrowserRouter>
    ) : (
      <ConfigError problems={config.problems} />
    )}
  </StrictMode>,
);
