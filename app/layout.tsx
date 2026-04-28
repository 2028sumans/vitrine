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
  title: "MUSE — The future of slow fashion",
  description:
    "MUSE pulls from hundreds of sustainable labels, vintage stores around the world, preloved platforms, and ethical small-batch makers — and puts them in a private feed tailored to your taste.",
  // Explicit favicon registration. We also have app/icon.svg which Next's
  // file-convention picks up automatically, but browsers cache favicons so
  // aggressively that being explicit here (and in layout) helps guarantee the
  // link tag is emitted on every page.
  icons: {
    icon: [
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    shortcut: "/icon.svg",
  },
  openGraph: {
    title: "MUSE — The future of slow fashion",
    description:
      "MUSE pulls from hundreds of sustainable labels, vintage stores around the world, preloved platforms, and ethical small-batch makers — and puts them in a private feed tailored to your taste.",
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
