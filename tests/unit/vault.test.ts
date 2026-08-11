import { describe, expect, it } from "vitest";
import path from "path";
import { kindOfMime } from "@/lib/server/vault";
import { assetDir, kindDir, tenantRoot, vaultRoot } from "@/lib/server/paths";

/**
 * The library layout.
 *
 * These are the promises the Obsidian folder makes to the person browsing it: files land
 * under a folder named for their kind, one tenant never writes into another's, and a
 * stored path can never point outside the library.
 */
describe("library layout", () => {
  it("files each kind under the folder people expect", () => {
    expect(kindDir("image")).toBe("image");
    expect(kindDir("video")).toBe("video");
    expect(kindDir("audio")).toBe("audio");
    expect(kindDir("3d")).toBe("3D");
    expect(kindDir("vector")).toBe("vector");
    expect(kindDir("something-new")).toBe("file");
  });

  it("gives the single operator the root itself and segments anyone else", () => {
    expect(tenantRoot("local")).toBe(vaultRoot());
    expect(tenantRoot("other")).toBe(path.join(vaultRoot(), "other"));
  });

  it("puts an asset in its kind's directory", () => {
    expect(assetDir("local", "3d")).toBe(path.join(vaultRoot(), "3D"));
    expect(assetDir("other", "image")).toBe(path.join(vaultRoot(), "other", "image"));
  });

  it("classifies what the provider returns", () => {
    expect(kindOfMime("model/gltf-binary")).toBe("3d");
    expect(kindOfMime("image/svg+xml")).toBe("vector");
    expect(kindOfMime("image/png")).toBe("image");
  });
});
