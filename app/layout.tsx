import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const cormorant = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-cormorant",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  title: "MUSE — Every quiet label, one feed",
  description:
    "MUSE pulls from hundreds of independent labels, archive sellers, resale shops, and small-batch makers — and puts them in a private feed tailored to your taste.",
  openGraph: {
    title: "MUSE — Every quiet label, one feed",
    description:
      "MUSE pulls from hundreds of independent labels, archive sellers, resale shops, and small-batch makers — and puts them in a private feed tailored to your taste.",
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
    <html lang="en" className={`${cormorant.variable} ${inter.variable}`}>
      <body className="bg-background text-foreground font-sans antialiased">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
