import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import App from "../App.tsx";
import { AuthProvider, useAuth } from "../lib/auth.tsx";
import { ErrorBoundary, RootErrorBoundary } from "../components/ErrorBoundary.tsx";

const failure = new Error("Invalid server field");
const pages = vi.hoisted(() => ({ failLogin: false, failMarkets: false }));
vi.mock("../pages/BorrowerView.tsx", () => ({ BorrowerView: () => { throw new Error("Invalid server field"); } }));
vi.mock("../pages/LenderView.tsx", () => ({ LenderView: () => <h1>Lender ready</h1> }));
vi.mock("../pages/Login.tsx", () => ({ Login: () => {
  if (pages.failLogin) throw new Error("Login failed");
  return <h1>Login ready</h1>;
} }));
vi.mock("../pages/Markets.tsx", () => ({ Markets: () => {
  if (pages.failMarkets) throw new Error("Markets failed");
  return <h1>Markets ready</h1>;
} }));

function ThrowingPage(): never { throw failure; }

function Navigation() {
  const navigate = useNavigate();
  const location = useLocation();
  const { session } = useAuth();
  return <>
    <button onClick={() => navigate("/markets")}>Go to markets</button>
    <button onClick={() => navigate("/borrower")}>Go to borrower</button>
    <span data-testid="route">{location.pathname}</span>
    <span data-testid="session">{session ? "connected" : "disconnected"}</span>
  </>;
}

function renderApp(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <Navigation />
        <RootErrorBoundary><App /></RootErrorBoundary>
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  localStorage.clear();
  pages.failLogin = false;
  pages.failMarkets = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

function stubLocation(location: Partial<Location>) {
  vi.stubGlobal("window", new Proxy(window, {
    get(target, key) {
      return key === "location" ? location : Reflect.get(target, key, target);
    },
  }));
}

function saveSession() {
  localStorage.setItem("ballast.console.session", JSON.stringify({
    token: "test-token", partyId: "test-party", stellarAccount: "GTESTACCOUNT",
  }));
}

describe("error recovery", () => {
  it("renders healthy children without a fallback", () => {
    render(<ErrorBoundary onDisconnect={vi.fn()}><p>Healthy view</p></ErrorBoundary>);
    expect(screen.getByText("Healthy view")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("renders a safe fallback, logs the error, and offers reload and disconnect", () => {
    const disconnect = vi.fn();
    render(<ErrorBoundary onDisconnect={disconnect}><ThrowingPage /></ErrorBoundary>);
    expect(screen.getByRole("alert").textContent).toContain("Unable to display this page");
    expect(screen.queryByText(failure.message)).toBeNull();
    expect(console.error).toHaveBeenCalledWith("Console rendering failed", failure, expect.any(String));
    const reload = vi.fn();
    stubLocation({ reload });
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(reload).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it("keeps shell navigation usable and resets when switching tabs", async () => {
    saveSession();
    renderApp("/login");
    fireEvent.click(screen.getByRole("button", { name: "Go to borrower" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("navigation")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Lender" }));
    expect(await screen.findByText("Lender ready")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("link", { name: "Borrower" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
  });

  it("disconnects from a failed console page and returns to login", async () => {
    saveSession();
    renderApp("/login");
    fireEvent.click(screen.getByRole("button", { name: "Go to borrower" }));
    const fallback = await screen.findByRole("alert");
    fireEvent.click(within(fallback).getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Login ready")).toBeTruthy();
    expect(localStorage.getItem("ballast.console.session")).toBeNull();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it.each(["/login", "/markets"])("catches root page failures at %s and clears the session", (path) => {
    saveSession();
    pages.failLogin = path === "/login";
    pages.failMarkets = path === "/markets";
    renderApp(path);
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(localStorage.getItem("ballast.console.session")).toBeNull();
    expect(screen.getByTestId("route").textContent).toBe("/login");
    expect(screen.getByTestId("session").textContent).toBe("disconnected");
  });

  it("resets the root fallback after a route change", () => {
    pages.failLogin = true;
    renderApp("/login");
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Go to markets" }));
    expect(screen.getByText("Markets ready")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
