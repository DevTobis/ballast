import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App.tsx";
import { RootErrorBoundary } from "./components/ErrorBoundary.tsx";
import { AuthProvider } from "./lib/auth.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <RootErrorBoundary>
          <App />
        </RootErrorBoundary>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
