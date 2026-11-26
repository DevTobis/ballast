export interface RouteSchema {
  summary: string;
  description: string;
  body: Record<string, unknown>;
  response: Record<string | number, unknown>;
  [key: string]: unknown;
}

export const BIGINTISH_SCHEMA = {
  type: "string" as const,
  pattern: "^[0-9]+$",
  description:
    "Decimal string representing a fixed-point integer scaled by 10^7 (Stellar stroops). For example, '10000000' represents 1.0000000 unit. Safe integers are accepted by the parser but strings must be sent for precision.",
};

export const HEX_BUFFER_SCHEMA = {
  type: "string" as const,
  pattern: "^(0x)?[0-9a-fA-F]+$",
  description: "Hexadecimal string with optional '0x' prefix (e.g. '0xabcdef...' or 'abcdef...').",
};

export const TX_RESPONSE_201_SCHEMA = {
  type: "object" as const,
  required: ["xdr", "txHash"],
  properties: {
    xdr: {
      type: "string",
      description: "Base64-encoded unsigned Stellar transaction envelope XDR.",
    },
    txHash: {
      type: "string",
      description: "Computed transaction hash of the unsigned transaction.",
    },
  },
  additionalProperties: true,
};

export const openCreditLineRouteSchema: RouteSchema = {
  summary: "Open a credit line",
  description: "Builds the open transaction on CreditLine contract and creates a pending credit line record.",
  body: {
    type: "object",
    required: ["lenderId", "borrowerId", "loanCcy", "limit", "rateBps", "cureWindowS", "asset", "agreementHash"],
    properties: {
      lenderId: { type: "string", format: "uuid", description: "UUID of the lending party (must match authenticated caller)" },
      borrowerId: { type: "string", format: "uuid", description: "UUID of the borrowing party" },
      loanCcy: { type: "string", description: "Currency symbol or code (e.g. 'USDC')" },
      limit: BIGINTISH_SCHEMA,
      rateBps: { type: "integer", minimum: 0, description: "Borrow rate in basis points (e.g. 500 = 5%)" },
      feeBps: { type: "integer", minimum: 0, default: 0, description: "Platform fee in basis points" },
      cureWindowS: { type: "integer", minimum: 1, description: "Cure window in seconds" },
      asset: { type: "string", description: "Stellar asset or contract address" },
      agreementHash: HEX_BUFFER_SCHEMA,
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "creditLineId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        creditLineId: { type: "string", format: "uuid", description: "ID of the newly created credit line" },
      },
    },
  },
};

export const fundCreditLineRouteSchema: RouteSchema = {
  summary: "Fund a credit line",
  description: "Builds a funding transaction transferring committed USDC from lender to CreditLine contract.",
  body: {
    type: "object",
    required: ["amount"],
    properties: {
      amount: BIGINTISH_SCHEMA,
    },
  },
  response: {
    201: TX_RESPONSE_201_SCHEMA,
  },
};

export const withdrawRouteSchema: RouteSchema = {
  summary: "Withdraw undrawn funds or interest",
  description: "Builds a withdrawal transaction for the lender to retrieve undrawn funds or claimed interest.",
  body: {
    type: "object",
    required: ["kind", "amount"],
    properties: {
      kind: {
        type: "string",
        enum: ["undrawn", "interest"],
        description: "'undrawn' returns committed USDC (including repaid principal); 'interest' returns repaid interest.",
      },
      amount: BIGINTISH_SCHEMA,
    },
  },
  response: {
    201: TX_RESPONSE_201_SCHEMA,
  },
};

export const closeLiquidationRouteSchema: RouteSchema = {
  summary: "Close a liquidated credit line",
  description: "Builds transaction to close an uncured, liquidating credit line and settle recovery.",
  body: {
    type: "object",
    properties: {},
  },
  response: {
    201: TX_RESPONSE_201_SCHEMA,
  },
};

export const createPledgeRouteSchema: RouteSchema = {
  summary: "Pledge collateral to a credit line",
  description: "Builds transaction depositing collateral units into the PledgeVault for the credit line.",
  body: {
    type: "object",
    required: ["assetId", "units", "custodyMode"],
    properties: {
      assetId: { type: "string", format: "uuid", description: "UUID of the accepted asset" },
      units: BIGINTISH_SCHEMA,
      custodyMode: {
        type: "string",
        enum: ["escrow", "issuer_lien", "custodian_lien"],
        description: "Custody arrangement mode for the pledged collateral",
      },
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "pledgeId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        pledgeId: { type: "string", format: "uuid", description: "ID of the pledge record" },
      },
    },
  },
};

export const createDrawRouteSchema: RouteSchema = {
  summary: "Draw borrowed funds",
  description: "Builds transaction borrowing USDC from the funded credit line, sent to specified account.",
  body: {
    type: "object",
    required: ["amount", "to"],
    properties: {
      amount: BIGINTISH_SCHEMA,
      to: { type: "string", description: "Destination Stellar account address" },
    },
  },
  response: {
    201: TX_RESPONSE_201_SCHEMA,
  },
};

export const createRepaymentRouteSchema: RouteSchema = {
  summary: "Repay borrowed debt",
  description: "Builds transaction transferring USDC repayment (interest first, then principal) to CreditLine contract.",
  body: {
    type: "object",
    required: ["amount"],
    properties: {
      amount: BIGINTISH_SCHEMA,
    },
  },
  response: {
    201: TX_RESPONSE_201_SCHEMA,
  },
};

export const exitQuoteRequestRouteSchema: RouteSchema = {
  summary: "Request an exit quote",
  description: "Queries ExitDesk for immediate liquidation quote and records the open quote.",
  body: {
    type: "object",
    required: ["assetId", "units"],
    properties: {
      assetId: { type: "string", format: "uuid", description: "UUID of the asset to exit" },
      units: BIGINTISH_SCHEMA,
    },
  },
  response: {
    201: {
      type: "object",
      required: ["id", "assetId", "units", "price", "spreadBps", "usdcOut", "expiresAt"],
      properties: {
        id: { type: "string", format: "uuid", description: "Quote ID" },
        assetId: { type: "string", format: "uuid", description: "Asset ID" },
        units: BIGINTISH_SCHEMA,
        price: BIGINTISH_SCHEMA,
        spreadBps: { type: "integer", description: "Spread in basis points" },
        usdcOut: BIGINTISH_SCHEMA,
        expiresAt: { type: "string", format: "date-time", description: "Expiration timestamp" },
      },
    },
  },
};

export const exitExecuteRouteSchema: RouteSchema = {
  summary: "Execute an exit quote",
  description: "Builds execution transaction for an open, unexpired exit quote.",
  body: {
    type: "object",
    required: ["to"],
    properties: {
      minUsdcOut: {
        ...BIGINTISH_SCHEMA,
        description: "Minimum acceptable USDC payout (at most 1% slippage below quote). Omitted defaults to quoted payout.",
      },
      to: { type: "string", description: "Destination Stellar account address for payout" },
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "quoteId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        quoteId: { type: "string", format: "uuid", description: "Exit quote ID" },
      },
    },
  },
};

export const repoProposalRouteSchema: RouteSchema = {
  summary: "Propose a repo trade",
  description: "Builds proposal transaction on RepoDvp contract and persists proposed trade.",
  body: {
    type: "object",
    required: ["cashLenderId", "cashBorrowerId", "assetId", "units", "cashAmount", "rateBps", "kind", "maturityAt", "agreementHash"],
    properties: {
      cashLenderId: { type: "string", format: "uuid", description: "UUID of the cash lender (must match authenticated caller)" },
      cashBorrowerId: { type: "string", format: "uuid", description: "UUID of the cash borrower counterparty" },
      assetId: { type: "string", format: "uuid", description: "UUID of the collateral asset" },
      units: BIGINTISH_SCHEMA,
      cashAmount: BIGINTISH_SCHEMA,
      rateBps: { type: "integer", minimum: 0, description: "Repo interest rate in basis points" },
      kind: { type: "string", enum: ["intraday", "overnight", "open", "term"], description: "Repo trade structure kind" },
      maturityAt: { type: "string", format: "date-time", description: "Maturity timestamp (ISO 8601)" },
      agreementHash: HEX_BUFFER_SCHEMA,
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "tradeId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        tradeId: { type: "string", format: "uuid", description: "ID of the newly proposed repo trade" },
      },
    },
  },
};

export const repoTradeAcceptRouteSchema: RouteSchema = {
  summary: "Accept a repo trade proposal",
  description: "Builds acceptance (leg 1 settlement) transaction on RepoDvp contract.",
  body: {
    type: "object",
    properties: {
      contractTradeId: {
        ...BIGINTISH_SCHEMA,
        description: "On-chain repo trade ID. Optional: read from database record if omitted.",
      },
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "tradeId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        tradeId: { type: "string", format: "uuid", description: "Repo trade ID" },
      },
    },
  },
};

export const repoTradeUnwindRouteSchema: RouteSchema = {
  summary: "Unwind a repo trade",
  description: "Builds unwind (leg 2 settlement) transaction on RepoDvp contract at or after maturity.",
  body: {
    type: "object",
    properties: {
      contractTradeId: {
        ...BIGINTISH_SCHEMA,
        description: "On-chain repo trade ID. Optional: read from database record if omitted.",
      },
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "tradeId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        tradeId: { type: "string", format: "uuid", description: "Repo trade ID" },
      },
    },
  },
};

export const repoTopUpRouteSchema: RouteSchema = {
  summary: "Top up collateral for a repo trade",
  description: "Builds transaction adding collateral units to cure a repo margin call.",
  body: {
    type: "object",
    required: ["units"],
    properties: {
      units: BIGINTISH_SCHEMA,
    },
  },
  response: {
    201: {
      type: "object",
      required: ["xdr", "txHash", "tradeId"],
      properties: {
        xdr: { type: "string", description: "Unsigned Stellar transaction XDR" },
        txHash: { type: "string", description: "Transaction hash" },
        tradeId: { type: "string", format: "uuid", description: "Repo trade ID" },
      },
    },
  },
};

/**
 * Returns the OpenAPI 3.1.0 document describing the Ballast API endpoints,
 * including all transaction-building POST routes with their request body
 * and 201 response schemas.
 */
export function getOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: "3.1.0",
    info: {
      title: "Ballast API",
      version: "1.0.0",
      description:
        "REST API for Ballast credit lines, repo DVP, exit desk, and settlement operations. Monetary fields are scaled by 10^7 and sent/received as decimal strings (bigintish).",
    },
    paths: {
      "/v1/credit-lines": {
        post: {
          summary: openCreditLineRouteSchema.summary,
          description: openCreditLineRouteSchema.description,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: openCreditLineRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Credit line open transaction built",
              content: {
                "application/json": {
                  schema: openCreditLineRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/fund": {
        post: {
          summary: fundCreditLineRouteSchema.summary,
          description: fundCreditLineRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: fundCreditLineRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Funding transaction built",
              content: {
                "application/json": {
                  schema: fundCreditLineRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/withdrawals": {
        post: {
          summary: withdrawRouteSchema.summary,
          description: withdrawRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: withdrawRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Withdrawal transaction built",
              content: {
                "application/json": {
                  schema: withdrawRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/close-liquidation": {
        post: {
          summary: closeLiquidationRouteSchema.summary,
          description: closeLiquidationRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: closeLiquidationRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Close liquidation transaction built",
              content: {
                "application/json": {
                  schema: closeLiquidationRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/pledges": {
        post: {
          summary: createPledgeRouteSchema.summary,
          description: createPledgeRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createPledgeRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Collateral pledge transaction built",
              content: {
                "application/json": {
                  schema: createPledgeRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/draws": {
        post: {
          summary: createDrawRouteSchema.summary,
          description: createDrawRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createDrawRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Draw transaction built",
              content: {
                "application/json": {
                  schema: createDrawRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/credit-lines/{id}/repayments": {
        post: {
          summary: createRepaymentRouteSchema.summary,
          description: createRepaymentRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: createRepaymentRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Repayment transaction built",
              content: {
                "application/json": {
                  schema: createRepaymentRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/exit/quotes": {
        post: {
          summary: exitQuoteRequestRouteSchema.summary,
          description: exitQuoteRequestRouteSchema.description,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: exitQuoteRequestRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Exit quote created",
              content: {
                "application/json": {
                  schema: exitQuoteRequestRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/exit/quotes/{id}/execute": {
        post: {
          summary: exitExecuteRouteSchema.summary,
          description: exitExecuteRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: exitExecuteRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Exit execution transaction built",
              content: {
                "application/json": {
                  schema: exitExecuteRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/repo/proposals": {
        post: {
          summary: repoProposalRouteSchema.summary,
          description: repoProposalRouteSchema.description,
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: repoProposalRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Repo proposal transaction built",
              content: {
                "application/json": {
                  schema: repoProposalRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/repo/proposals/{id}/accept": {
        post: {
          summary: repoTradeAcceptRouteSchema.summary,
          description: repoTradeAcceptRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: repoTradeAcceptRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Repo acceptance transaction built",
              content: {
                "application/json": {
                  schema: repoTradeAcceptRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/repo/trades/{id}/unwind": {
        post: {
          summary: repoTradeUnwindRouteSchema.summary,
          description: repoTradeUnwindRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: repoTradeUnwindRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Repo unwind transaction built",
              content: {
                "application/json": {
                  schema: repoTradeUnwindRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
      "/v1/repo/trades/{id}/top-ups": {
        post: {
          summary: repoTopUpRouteSchema.summary,
          description: repoTopUpRouteSchema.description,
          parameters: [{ name: "id", in: "path", required: true, schema: { type: "string", format: "uuid" } }],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: repoTopUpRouteSchema.body,
              },
            },
          },
          responses: {
            "201": {
              description: "Repo top-up transaction built",
              content: {
                "application/json": {
                  schema: repoTopUpRouteSchema.response[201],
                },
              },
            },
          },
        },
      },
    },
  };
}
