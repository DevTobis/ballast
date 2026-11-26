import { describe, expect, it } from "vitest";
import type { ApiConfig } from "../config.js";
import type { ChainGateway } from "../chain.js";
import type { ContractClients } from "../contract-clients.js";
import { buildServer } from "../server.js";
import { createFakeDb } from "./fake-db.js";
import { z } from "zod";
import * as openApi from "../openapi.js";
import type { RouteSchema } from "../openapi.js";
import * as schemas from "../schemas.js";

const config: ApiConfig = {
  port: 0,
  jwtSigningSecret: "test-signing-key",
  sep10ServerSecret: "SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  sep10HomeDomain: "localhost",
  sep10WebAuthDomain: "localhost",
  networkPassphrase: "Test SDF Network ; September 2015",
  webhookSecretKey: "00".repeat(32),
  apiKeySecretKey: "00".repeat(32),
  complianceEnforced: false,
  consoleOrigin: "http://localhost:5173",
};

describe("OpenAPI document (/v1/openapi.json)", () => {
  it("serves an OpenAPI 3.1.0 document at /v1/openapi.json without authentication", async () => {
    const app = buildServer({
      config,
      db: createFakeDb(new Map()),
      contracts: {} as ContractClients,
      chain: { txHash: () => "hash" } as unknown as ChainGateway,
    });
    const res = await app.inject({ method: "GET", url: "/v1/openapi.json" });

    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("Ballast API");
    expect(doc.paths).toBeDefined();

    const txBuildingPostRoutes = [
      "/v1/credit-lines",
      "/v1/credit-lines/{id}/fund",
      "/v1/credit-lines/{id}/withdrawals",
      "/v1/credit-lines/{id}/close-liquidation",
      "/v1/credit-lines/{id}/pledges",
      "/v1/credit-lines/{id}/draws",
      "/v1/credit-lines/{id}/repayments",
      "/v1/exit/quotes",
      "/v1/exit/quotes/{id}/execute",
      "/v1/repo/proposals",
      "/v1/repo/proposals/{id}/accept",
      "/v1/repo/trades/{id}/unwind",
      "/v1/repo/trades/{id}/top-ups",
    ];

    for (const route of txBuildingPostRoutes) {
      expect(doc.paths[route], `missing route ${route}`).toBeDefined();
      expect(doc.paths[route].post, `missing POST for ${route}`).toBeDefined();

      const post = doc.paths[route].post;
      expect(post.responses["201"], `missing 201 response for ${route}`).toBeDefined();
      const resp201 = post.responses["201"].content["application/json"].schema;
      expect(resp201).toBeDefined();

      expect(post.requestBody, `missing requestBody for ${route}`).toBeDefined();
      const reqBodySchema = post.requestBody.content["application/json"].schema;
      expect(reqBodySchema).toBeDefined();
    }

    // Verify bigintish fields are documented as decimal strings
    const openCreditLine = doc.paths["/v1/credit-lines"].post.requestBody.content["application/json"].schema;
    expect(openCreditLine.properties.limit.type).toBe("string");
    expect(openCreditLine.properties.limit.description).toMatch(/decimal string/i);
    expect(openCreditLine.properties.limit.description).toMatch(/10\^7/);
    expect(openCreditLine.properties.agreementHash.type).toBe("string");

    const fundLine = doc.paths["/v1/credit-lines/{id}/fund"].post.requestBody.content["application/json"].schema;
    expect(fundLine.properties.amount.type).toBe("string");
    expect(fundLine.properties.amount.description).toMatch(/decimal string/i);

    const repoProposal = doc.paths["/v1/repo/proposals"].post.requestBody.content["application/json"].schema;
    expect(repoProposal.properties.units.type).toBe("string");
    expect(repoProposal.properties.cashAmount.type).toBe("string");
    expect(repoProposal.properties.agreementHash.type).toBe("string");
  });
});

describe("OpenAPI request bodies stay in step with the zod schemas the routes parse", () => {
  // Each documented body must list exactly the fields its route's zod schema reads, and mark as
  // required exactly the fields zod requires (a `.default()` or `.optional()` field is not required).
  const cases: Array<[string, RouteSchema, z.AnyZodObject]> = [
    ["POST /v1/credit-lines", openApi.openCreditLineRouteSchema, schemas.openCreditLineSchema],
    ["POST /v1/credit-lines/:id/fund", openApi.fundCreditLineRouteSchema, schemas.fundCreditLineSchema],
    ["POST /v1/credit-lines/:id/withdrawals", openApi.withdrawRouteSchema, schemas.withdrawSchema],
    ["POST /v1/credit-lines/:id/pledges", openApi.createPledgeRouteSchema, schemas.createPledgeSchema],
    ["POST /v1/credit-lines/:id/draws", openApi.createDrawRouteSchema, schemas.createDrawSchema],
    ["POST /v1/credit-lines/:id/repayments", openApi.createRepaymentRouteSchema, schemas.createRepaymentSchema],
    ["POST /v1/exit/quotes", openApi.exitQuoteRequestRouteSchema, schemas.exitQuoteRequestSchema],
    ["POST /v1/exit/quotes/:id/execute", openApi.exitExecuteRouteSchema, schemas.exitExecuteSchema],
    ["POST /v1/repo/proposals", openApi.repoProposalRouteSchema, schemas.repoProposalSchema],
    ["POST /v1/repo/proposals/:id/accept", openApi.repoTradeAcceptRouteSchema, schemas.repoTradeActionSchema],
    ["POST /v1/repo/trades/:id/unwind", openApi.repoTradeUnwindRouteSchema, schemas.repoTradeActionSchema],
    ["POST /v1/repo/trades/:id/top-ups", openApi.repoTopUpRouteSchema, schemas.repoTopUpSchema],
  ];

  it.each(cases)("%s", (_route, doc, zodSchema) => {
    const body = doc.body as { properties: Record<string, unknown>; required?: string[] };
    const shape = zodSchema.shape as Record<string, z.ZodTypeAny>;
    expect(Object.keys(body.properties).sort()).toEqual(Object.keys(shape).sort());
    const zodRequired = Object.entries(shape)
      .filter(([, field]) => !field.isOptional())
      .map(([key]) => key)
      .sort();
    expect([...(body.required ?? [])].sort()).toEqual(zodRequired);
  });
});
