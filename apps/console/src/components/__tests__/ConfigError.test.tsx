import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { ConfigError } from "../ConfigError.tsx";

afterEach(cleanup);

describe("ConfigError", () => {
  it("names each variable that is wrong, with what is wrong with it", () => {
    render(
      <ConfigError
        problems={[
          { variable: "VITE_API_URL", message: "is not set." },
          { variable: "VITE_STELLAR_NETWORK_PASSPHRASE", message: "has leading or trailing whitespace." },
        ]}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("VITE_API_URL");
    expect(alert.textContent).toContain("is not set.");
    expect(alert.textContent).toContain("VITE_STELLAR_NETWORK_PASSPHRASE");
    expect(alert.textContent).toContain("leading or trailing whitespace");
  });
});
