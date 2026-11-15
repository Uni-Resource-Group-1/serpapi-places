// @vitest-environment node
import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { buildXlsx } from "../../src/server/services/xlsx.js";

describe("buildXlsx", () => {
  it("creates a valid workbook with ordered columns, numeric cells, and inert source text", () => {
    const archive = unzipSync(buildXlsx(["name", "lat", "review_count"], [
      { name: '=HYPERLINK("https://example.com")', lat: 23.7, review_count: 8, review_text: "private" },
      { name: "A & B\u0001", lat: null, review_count: 0 },
    ]));
    expect(Object.keys(archive)).toContain("[Content_Types].xml");
    expect(Object.keys(archive)).toContain("xl/workbook.xml");
    const sheet = strFromU8(archive["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t xml:space="preserve">name</t>');
    expect(sheet).toContain('<c r="B2"><v>23.7</v></c>');
    expect(sheet).toContain('<c r="C3"><v>0</v></c>');
    expect(sheet).toContain('t="inlineStr"><is><t xml:space="preserve">=HYPERLINK');
    expect(sheet).toContain("A &amp; B");
    expect(sheet).not.toContain("\u0001");
    expect(sheet).not.toContain("<f>");
    expect(sheet).not.toContain("private");
  });
});
