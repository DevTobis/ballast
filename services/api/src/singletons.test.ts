import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadNetworkConfig: vi.fn(),
  requireContractId: vi.fn(),
  RegistryClient: vi.fn(),
  PriceGuardClient: vi.fn(),
  PledgeVaultClient: vi.fn(),
  CreditLineClient: vi.fn(),
  ExitDeskClient: vi.fn(),
  RepoDvpClient: vi.fn(),
  createDatabase: vi.fn(),
}));

vi.mock("@ballast/network-config", () => ({
  loadNetworkConfig: mocks.loadNetworkConfig,
  requireContractId: mocks.requireContractId,
}));
vi.mock("@ballast/contract-clients", () => ({
  RegistryClient: mocks.RegistryClient,
  PriceGuardClient: mocks.PriceGuardClient,
  PledgeVaultClient: mocks.PledgeVaultClient,
  CreditLineClient: mocks.CreditLineClient,
  ExitDeskClient: mocks.ExitDeskClient,
  RepoDvpClient: mocks.RepoDvpClient,
}));
vi.mock("@ballast/db", () => ({ createDatabase: mocks.createDatabase }));

const contracts = [
  ["registry", "RegistryClient"],
  ["priceGuard", "PriceGuardClient"],
  ["pledgeVault", "PledgeVaultClient"],
  ["creditLine", "CreditLineClient"],
  ["exitDesk", "ExitDeskClient"],
  ["repoDvp", "RepoDvpClient"],
] as const;
const network = { contracts: Object.fromEntries(contracts.map(([key]) => [key, `id-${key}`])) };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.loadNetworkConfig.mockReturnValue(network);
  mocks.requireContractId.mockImplementation((_network: unknown, key: string) => `id-${key}`);
  for (const [, constructor] of contracts) {
    mocks[constructor].mockImplementation(function (options: unknown) { return { options }; });
  }
});

describe("getContractClients", () => {
  it("caches the complete client set and passes each constructor its own contract id", async () => {
    const { getContractClients } = await import("./contract-clients.js");
    const first = getContractClients();
    expect(getContractClients()).toBe(first);
    expect(mocks.loadNetworkConfig).toHaveBeenCalledTimes(1);
    expect(mocks.requireContractId).toHaveBeenCalledTimes(contracts.length);
    for (const [key, constructor] of contracts) {
      expect(mocks.requireContractId).toHaveBeenCalledWith(network, key);
      expect(mocks[constructor]).toHaveBeenCalledTimes(1);
      expect(mocks[constructor]).toHaveBeenCalledWith({ network, contractId: `id-${key}` });
      expect(first[key]).toBe(mocks[constructor].mock.results[0].value);
    }
  });

  it.each(contracts)("propagates the named %s error and retries without caching a partial set", async (key) => {
    const error = new Error(`network-config: contract id for "${key}" is not set (deploy it first)`);
    mocks.requireContractId.mockImplementation((_network: unknown, requested: string) => {
      if (requested === key) throw error;
      return `id-${requested}`;
    });
    const { getContractClients } = await import("./contract-clients.js");
    expect(() => getContractClients()).toThrow(error);
    expect(mocks.loadNetworkConfig).toHaveBeenCalledTimes(1);

    mocks.requireContractId.mockImplementation((_network: unknown, requested: string) => `id-${requested}`);
    const recovered = getContractClients();
    expect(Object.keys(recovered)).toEqual(contracts.map(([name]) => name));
    expect(mocks.loadNetworkConfig).toHaveBeenCalledTimes(2);
    for (const [name, constructor] of contracts) {
      const calls = mocks[constructor].mock.results;
      expect(recovered[name]).toBe(calls[calls.length - 1].value);
    }
    expect(getContractClients()).toBe(recovered);
    expect(mocks.loadNetworkConfig).toHaveBeenCalledTimes(2);
  });

  it("starts with a fresh singleton after resetting modules", async () => {
    const first = (await import("./contract-clients.js")).getContractClients();
    vi.resetModules();
    const second = (await import("./contract-clients.js")).getContractClients();
    expect(second).not.toBe(first);
    for (const [key, constructor] of contracts) {
      expect(second[key]).not.toBe(first[key]);
      expect(mocks[constructor]).toHaveBeenCalledTimes(2);
    }
  });
});

describe("getDb", () => {
  it("returns the same handle and calls createDatabase once", async () => {
    const database = {};
    mocks.createDatabase.mockReturnValue(database);
    const { getDb } = await import("./db.js");
    expect(getDb()).toBe(database);
    expect(getDb()).toBe(database);
    expect(mocks.createDatabase).toHaveBeenCalledTimes(1);
    expect(mocks.createDatabase).toHaveBeenCalledWith();
  });

  it("retries after initialization fails and only caches a successful handle", async () => {
    const error = new Error("database unavailable");
    const database = {};
    mocks.createDatabase.mockImplementationOnce(() => { throw error; }).mockReturnValue(database);
    const { getDb } = await import("./db.js");
    expect(() => getDb()).toThrow(error);
    expect(getDb()).toBe(database);
    expect(getDb()).toBe(database);
    expect(mocks.createDatabase).toHaveBeenCalledTimes(2);
  });

  it("starts with a fresh handle after resetting modules", async () => {
    const first = {}, second = {};
    mocks.createDatabase.mockReturnValueOnce(first).mockReturnValueOnce(second);
    expect((await import("./db.js")).getDb()).toBe(first);
    vi.resetModules();
    expect((await import("./db.js")).getDb()).toBe(second);
    expect(mocks.createDatabase).toHaveBeenCalledTimes(2);
  });
});
