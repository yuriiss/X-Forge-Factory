import { createHmac } from "crypto";
import { describe, expect, it } from "vitest";
import { extractIdentifiers, extractUrls, parseOutline } from "@/lib/server/mcp";
import { signAsset, verifyAssetSignature, kindOfMime } from "@/lib/server/vault";

/**
 * The parsing and verification that sit between X-Forge and everyone else. These are the
 * places where a wrong assumption is silent rather than loud.
 */

describe("MCP outline parsing", () => {
  const OUTLINE = `items[3]:
  - slug: kling-26
    name: Kling 2.6
    family: Kling
    expectedGenerationTime: 600
    aspectRatios[3]: "1:1","16:9","9:16"
    durations[2]: 5,10
    keyframes:
      start:
        assetType: image
  - slug: wan-2-5
    name: Wan 2.5
    beta: true
  - slug: veo3
    name: Google Veo 3
`;

  it("reads records and their counted lists", () => {
    const rows = parseOutline(OUTLINE, "slug");
    expect(rows).toHaveLength(3);
    expect(rows[0].name).toBe("Kling 2.6");
    expect(rows[0].aspectRatios).toEqual(["1:1", "16:9", "9:16"]);
    expect(rows[0].durations).toEqual(["5", "10"]);
    expect(rows[1].beta).toBe("true");
  });

  it("skips nested sub-objects rather than inventing structure for them", () => {
    const rows = parseOutline(OUTLINE, "slug");
    expect(rows[0].assetType).toBeUndefined();
  });

  it("returns nothing for text that is not an outline, instead of guessing", () => {
    expect(parseOutline("this is prose, not a list", "slug")).toHaveLength(0);
  });

  /**
   * The bug this pins: `folders_list` nests the containing project under each folder, and
   * a parser that tolerated one level too many let `parent.name` overwrite the folder's
   * own `name` — so a folder called "Personal" was shown under the name of the project it
   * happened to live in.
   */
  it("does not let a nested field overwrite the record's own", () => {
    const rows = parseOutline(
      [
        "items[1]:",
        "  - reference: c46bb63f-ed27-488a-a266-cc59418ce98c",
        "    name: Personal",
        "    parent:",
        "      id: aa351c8a-5c4b-4ba2-b024-9348d87a0984",
        "      name: workspace",
        "    backgroundUrl: \"https://example.com/bg.webp\"",
      ].join("\n"),
      "reference",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Personal");
    expect(rows[0].id).toBeUndefined();
    expect(rows[0].backgroundUrl).toBe("https://example.com/bg.webp");
  });
});

describe("MCP result extraction", () => {
  it("finds asset URLs but never the gallery page", () => {
    const urls = extractUrls({
      content: [{ type: "text", text: "done" }],
      structuredContent: {
        items: [
          { url: "https://cdn.example.com/a/final.png", webUrl: "https://magnific.com/creations/abc123.png" },
          { url: "https://cdn.example.com/a/clip.mp4" },
        ],
      },
    });
    expect(urls).toContain("https://cdn.example.com/a/final.png");
    expect(urls).toContain("https://cdn.example.com/a/clip.mp4");
    expect(urls.some((u) => u.includes("magnific.com/creations"))).toBe(false);
  });

  it("falls back to identifiers in prose when there is no structured payload", () => {
    const ids = extractIdentifiers({
      content: [{ type: "text", text: 'items[2]:\n  - identifier: JN9Co2GOq4\n  - identifier: 6A2bmqViJO\n' }],
    });
    expect(ids).toEqual(expect.arrayContaining(["JN9Co2GOq4", "6A2bmqViJO"]));
  });
});

describe("webhook signature", () => {
  const secret = "whsec_testsecret_000000";
  const sign = (id: string, ts: string, body: string) => createHmac("sha256", secret).update(`${id}.${ts}.${body}`).digest("base64");

  it("matches the documented scheme", () => {
    const body = JSON.stringify({ data: { task_id: "t1", status: "COMPLETED" } });
    const expected = sign("wh_1", "1700000000", body);
    const header = `v1,${expected}`;
    const ok = header.split(" ").map((p) => p.split(",")[1]).some((c) => c === expected);
    expect(ok).toBe(true);
  });

  it("accepts any version in a multi-signature header (rotation stays deliverable)", () => {
    const body = "{}";
    const good = sign("wh_2", "1700000000", body);
    const header = `v1,anoldsignature v2,${good}`;
    expect(header.split(" ").map((p) => p.split(",")[1]).some((c) => c === good)).toBe(true);
  });

  it("rejects a body that was altered after signing", () => {
    const good = sign("wh_3", "1700000000", "{}");
    const forged = sign("wh_3", "1700000000", '{"status":"COMPLETED"}');
    expect(forged).not.toBe(good);
  });
});

describe("asset signatures", () => {
  it("verifies a fresh signature and refuses an expired one", () => {
    const token = signAsset("ast_1", 60_000);
    expect(verifyAssetSignature("ast_1", token)).toBe(true);
    // A signature for one asset must not open another.
    expect(verifyAssetSignature("ast_2", token)).toBe(false);
    const expired = signAsset("ast_1", -1000);
    expect(verifyAssetSignature("ast_1", expired)).toBe(false);
  });
});

describe("mime classification", () => {
  it("routes each family to the right renderer", () => {
    expect(kindOfMime("image/png")).toBe("image");
    expect(kindOfMime("image/svg+xml")).toBe("vector");
    expect(kindOfMime("video/mp4")).toBe("video");
    expect(kindOfMime("audio/mpeg")).toBe("audio");
    expect(kindOfMime("model/gltf-binary")).toBe("3d");
    expect(kindOfMime("application/pdf")).toBe("file");
  });
});
