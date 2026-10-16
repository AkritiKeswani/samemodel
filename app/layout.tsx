import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SameModel",
  description: "Same model, different provider, different answers. Benchmark every OpenRouter provider serving a model on your own prompts.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
