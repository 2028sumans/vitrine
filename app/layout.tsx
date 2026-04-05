import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vitrine — Your Pinterest boards, made shoppable",
  description:
    "Vitrine turns your Pinterest boards into shoppable storefronts. Connect your boards, share your taste, your audience shops the aesthetic you've already built.",
  openGraph: {
    title: "Vitrine — Your Pinterest boards, made shoppable",
    description:
      "Vitrine turns your Pinterest boards into shoppable storefronts. Connect your boards, share your taste, your audience shops the aesthetic you've already built.",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground font-sans">{children}</body>
    </html>
  );
}
