import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy — MUSE",
  description: "How Muse collects, uses, and protects your data.",
};

const sections = [
  {
    heading: "Overview",
    body: `Muse ("we," "us," or "our") is a personal shopping tool that reads your Pinterest boards and generates a private, personalized shopping page for you — filled with real products that match your taste. This Privacy Policy explains what data we collect, how we use it, and the choices you have. We've written it in plain language on purpose — legal jargon helps nobody.

If you have questions, email us at privacy@muse.app.`,
  },
  {
    heading: "What data we collect",
    body: `We collect the minimum necessary to operate the service:

**Account information.** When you sign up for the waitlist or create an account, we collect your name and email address.

**Pinterest data (OAuth).** When you connect your Pinterest account, we request read-only access to your boards and pins via Pinterest's official OAuth flow. This includes board names, pin images, pin descriptions, and pin URLs. We use this data solely to analyze your taste and generate your personal shopping page. We do not store raw Pinterest data beyond the active session.

**Usage data.** Standard web analytics — page views, button clicks, browser type, referring URL. We use this to understand how people use Muse and improve the product.`,
  },
  {
    heading: "How we use your data",
    body: `We use the data we collect for the following purposes:

- **To generate your personal shopping page.** We pass your Pinterest board data to our AI analysis pipeline to understand your aesthetic and generate shoppable product recommendations for you. Your Pinterest data is only ever used to provide this service to you.
- **To operate the service.** Account management, authentication, customer support, and sending you service-related emails.
- **To generate affiliate revenue.** When you click a product link and make a purchase, we earn a small affiliate commission from the retailer. This is how Muse sustains itself as a free product.
- **To improve the product.** Aggregate, anonymized usage patterns help us build a better product.`,
  },
  {
    heading: "What we do NOT do",
    body: `We want to be explicit about this:

- **We do not sell your data.** Full stop. We don't sell, rent, or trade your personal information to any third party for marketing purposes.
- **We do not store raw Pinterest pin data beyond the active session.** We process Pinterest data to generate your storefront and do not retain a copy of your raw pins, images, or board contents in our database afterward.
- **We do not run ads.** There are no targeted ads on Muse, and we don't share your data with ad networks.
- **We do not share personal data with third parties** except as strictly necessary to operate — see the section below on third-party service providers.`,
  },
  {
    heading: "Pinterest data and OAuth",
    body: `Connecting your Pinterest account is entirely optional and requires your explicit approval through Pinterest's standard OAuth flow. Here's what that means in practice:

- **Read-only access.** We only request permission to read your boards and pins. We cannot post, modify, or delete anything on your Pinterest account.
- **You can revoke access at any time.** Visit your Pinterest settings under "Apps" and remove Muse. Once revoked, we will no longer have access to your Pinterest data.
- **We comply with Pinterest's API Terms of Service.** Our use of Pinterest data is governed by Pinterest's developer policies. We only use Pinterest data for the purposes described in this policy.`,
  },
  {
    heading: "Affiliate tracking",
    body: `When you click a product link on your Muse shopping page, that link may be an affiliate link — a standard industry mechanism that tells the retailer the purchase originated from Muse. Here's how it works:

- We use affiliate programs such as Amazon Associates, Rakuten, ShareASale, and similar networks to track purchases and earn commissions.
- Clicking an affiliate link will redirect you through the affiliate network's servers, which may set a tracking cookie in your browser.
- These cookies are set by the third-party affiliate network or retailer, not by Muse. Each network's own privacy policy governs those cookies.
- We only receive anonymized conversion data (e.g., "a purchase was made") — we do not receive your payment or personal information from retailers.`,
  },
  {
    heading: "Cookies",
    body: `Muse uses a minimal cookie footprint:

- **Session cookies.** We use a single session cookie to keep you logged in while you use the app. This cookie is deleted when you close your browser or log out.
- **No tracking cookies from us.** We don't use cookies for advertising, retargeting, or cross-site tracking.
- **Third-party affiliate cookies.** As described above, when you click a product link, the affiliate network or retailer may set their own cookies. These are outside our control and governed by their respective privacy policies.`,
  },
  {
    heading: "Third-party service providers",
    body: `To operate Muse, we work with a small number of trusted third-party providers. We share data with them only as necessary to provide the service:

- **AI/ML analysis providers.** We may send anonymized Pinterest board data to AI infrastructure providers to perform aesthetic analysis. These providers process data on our behalf under strict data processing agreements.
- **Affiliate networks.** We use affiliate networks to track purchases and process commissions. Only anonymized transaction data (no personal information) flows to these networks.
- **Infrastructure providers.** We use standard cloud hosting and database services to run the product.

We do not share your name, email, or personal information with any of these providers except where operationally required (e.g., a support ticket system).`,
  },
  {
    heading: "Data retention",
    body: `We retain your account data (name, email) for as long as your account is active or until you request deletion. Raw Pinterest board data is processed in-session and not stored long-term. Anonymized storefront performance data may be retained indefinitely.

To delete your account and all associated personal data, email privacy@muse.app.`,
  },
  {
    heading: "Security",
    body: `We take reasonable technical and organizational measures to protect your data — encrypted connections (HTTPS), secure credential storage, and limited internal access. No system is perfectly secure, but we take this seriously.`,
  },
  {
    heading: "Children's privacy",
    body: `Muse is not directed at children under 13. We do not knowingly collect data from anyone under 13. If you believe we have inadvertently collected such data, please contact us at privacy@muse.app and we will delete it.`,
  },
  {
    heading: "Changes to this policy",
    body: `We may update this policy as the product evolves. If we make material changes, we'll notify you by email or with a prominent notice on the site. The "effective date" below will always reflect the most recent version.`,
  },
  {
    heading: "Contact us",
    body: `Questions, requests, or concerns about this policy:

**Email:** privacy@muse.app

We aim to respond within 5 business days.`,
  },
];

function renderBody(text: string) {
  return text.split("\n\n").map((para, i) => {
    const lines = para.split("\n").map((line, j) => {
      const boldReplaced = line.replace(/\*\*(.+?)\*\*/g, (_, match) => (
        `<strong>${match}</strong>`
      ) as unknown as string);
      return (
        <span
          key={j}
          dangerouslySetInnerHTML={{ __html: boldReplaced }}
          className="block"
        />
      );
    });

    const isList = para.startsWith("- ");
    if (isList) {
      const items = para.split("\n").filter((l) => l.startsWith("- "));
      return (
        <ul key={i} className="list-disc list-inside space-y-1 text-muted text-sm leading-relaxed">
          {items.map((item, k) => {
            const content = item.slice(2);
            const html = content.replace(
              /\*\*(.+?)\*\*/g,
              "<strong class=\"text-foreground\">$1</strong>"
            );
            return (
              <li
                key={k}
                dangerouslySetInnerHTML={{ __html: html }}
                className="marker:text-accent"
              />
            );
          })}
        </ul>
      );
    }

    const html = para.replace(
      /\*\*(.+?)\*\*/g,
      "<strong class=\"text-foreground font-semibold\">$1</strong>"
    );
    return (
      <p
        key={i}
        dangerouslySetInnerHTML={{ __html: html.replace(/\n/g, "<br />") }}
        className="text-muted text-sm leading-relaxed"
      />
    );
  });
}

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="px-6 py-5 border-b border-border">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <Link
            href="/"
            className="text-foreground font-semibold tracking-tight text-lg hover:text-accent transition-colors"
          >
            Muse
          </Link>
          <Link
            href="/"
            className="text-sm text-muted hover:text-foreground transition-colors"
          >
            ← Back to home
          </Link>
        </div>
      </header>

      <main className="px-6 py-16 max-w-3xl mx-auto">
        {/* Header */}
        <div className="mb-12">
          <h1 className="text-4xl font-bold tracking-tight mb-3">
            Privacy Policy
          </h1>
          <p className="text-sm text-muted">Effective date: April 2025</p>
        </div>

        {/* Sections */}
        <div className="space-y-10">
          {sections.map((section) => (
            <section key={section.heading} className="border-t border-border pt-8">
              <h2 className="text-lg font-semibold tracking-tight mb-3">
                {section.heading}
              </h2>
              <div className="space-y-3">{renderBody(section.body)}</div>
            </section>
          ))}
        </div>
      </main>

      {/* Footer */}
      <footer className="px-6 py-8 border-t border-border mt-16">
        <div className="max-w-3xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-sm text-muted">
          <span>© 2025 Muse</span>
          <a
            href="mailto:privacy@muse.app"
            className="hover:text-foreground transition-colors underline underline-offset-2"
          >
            privacy@muse.app
          </a>
        </div>
      </footer>
    </div>
  );
}
