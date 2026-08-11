import type { NextConfig } from "next";

/**
 * X-Forge runs as a local operator console: one process, one machine, the operator's own
 * Magnific key. `node:sqlite` and the vault live on the server side only, so the engine
 * modules are kept out of the client bundle explicitly rather than by convention.
 */
const nextConfig: NextConfig = {
  serverExternalPackages: ["node:sqlite"],
  experimental: {
    // Job submission carries base64 image payloads — the 1 MB default rejects a 4k still.
    serverActions: { bodySizeLimit: "64mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "no-referrer" },
        ],
      },
    ];
  },
};

export default nextConfig;
