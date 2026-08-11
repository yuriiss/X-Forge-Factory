import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "X-FORGE · Magnific console",
  description: "Operator console for api.magnific.com and the Magnific MCP server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
