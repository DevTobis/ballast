import { describe, expect, it } from "vitest";
import { toCsv } from "../routes/reports.js";

describe("toCsv", () => {
  it("returns header line only when there are no rows", () => {
    expect(toCsv([])).toBe("kind");
  });

  it("builds columns from the ordered union of every row kind, with kind first and blank missing cells", () => {
    const marginEvent = {
      kind: "margin_event",
      id: "m-1",
      creditLineId: "line-1",
      state: "warning",
      ltvBps: 8500,
    };
    const draw = {
      kind: "draw",
      id: "d-1",
      creditLineId: "line-1",
      amount: "1000000",
      txHash: "0xabc",
      ledger: 12345,
    };

    const csv = toCsv([marginEvent, draw]);
    const lines = csv.split("\n");

    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe("kind,id,creditLineId,state,ltvBps,amount,txHash,ledger");
    expect(lines[1]).toBe('"margin_event","m-1","line-1","warning",8500,"","",""');
    expect(lines[2]).toBe('"draw","d-1","line-1","","","1000000","0xabc",12345');
  });

  it("handles empty values and strings without data loss", () => {
    const row1 = { kind: "a", foo: "bar" };
    const row2 = { kind: "b", baz: 42 };
    expect(toCsv([row1, row2])).toBe(
      'kind,foo,baz\n"a","bar",""\n"b","",42',
    );
  });
});
