import { describe, expect, it, vi } from "vitest";

const { submitMock, loadNetworkConfigMock } = vi.hoisted(() => ({
  submitMock: vi.fn(),
  loadNetworkConfigMock: vi.fn().mockReturnValue({
    rpcUrl: "https://default-rpc.example.com",
    networkPassphrase: "Default Passphrase",
  }),
}));

vi.mock("@ballast/operator-signing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@ballast/operator-signing")>();
  return { ...actual, submitSignedTx: submitMock };
});

vi.mock("@ballast/network-config", () => ({
  loadNetworkConfig: loadNetworkConfigMock,
}));

const { signAndSubmit } = await import("./submit.js");

describe("signAndSubmit", () => {
  it("signs the unsigned XDR and submits using custom network config if passed", async () => {
    submitMock.mockResolvedValueOnce({ hash: "tx-hash-123" });
    const signer = {
      publicKey: vi.fn().mockReturnValue("GKEEPER"),
      sign: vi.fn().mockResolvedValue("signed-xdr-abc"),
    };
    const network = {
      rpcUrl: "https://rpc.example.com",
      networkPassphrase: "Test Network Passphrase",
    };

    const hash = await signAndSubmit(signer as any, "unsigned-xdr-123", network);

    expect(signer.sign).toHaveBeenCalledWith("unsigned-xdr-123");
    expect(submitMock).toHaveBeenCalledWith(
      "https://rpc.example.com",
      "Test Network Passphrase",
      "signed-xdr-abc",
    );
    expect(hash).toBe("tx-hash-123");
  });

  it("falls back to loaded network config when not supplied", async () => {
    submitMock.mockResolvedValueOnce({ hash: "tx-hash-456" });
    const signer = {
      publicKey: vi.fn().mockReturnValue("GKEEPER"),
      sign: vi.fn().mockResolvedValue("signed-xdr-def"),
    };

    const hash = await signAndSubmit(signer as any, "unsigned-xdr-456");

    expect(loadNetworkConfigMock).toHaveBeenCalled();
    expect(signer.sign).toHaveBeenCalledWith("unsigned-xdr-456");
    expect(submitMock).toHaveBeenCalledWith(
      "https://default-rpc.example.com",
      "Default Passphrase",
      "signed-xdr-def",
    );
    expect(hash).toBe("tx-hash-456");
  });
});
