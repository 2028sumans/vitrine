"use client";

import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="px-6 py-5">
        <div className="max-w-5xl mx-auto">
          <Link href="/" className="text-foreground font-bold tracking-tight text-lg hover:text-accent transition-colors">
            Vitrine
          </Link>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-6 py-20">
        <div className="w-full max-w-sm">

          {/* Decorative top */}
          <div className="flex justify-center mb-8">
            <div className="w-14 h-14 rounded-2xl bg-accent-subtle border border-accent/20 flex items-center justify-center text-2xl shadow-sm">
              🛍️
            </div>
          </div>

          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              Welcome to Vitrine
            </h1>
            <p className="text-muted text-sm leading-relaxed max-w-xs mx-auto">
              Connect your Pinterest account to get a personalized shopping page built from your own taste.
            </p>
          </div>

          <div className="bg-white border border-border rounded-2xl p-8 shadow-sm">
            {/* Pinterest button */}
            <button
              onClick={() => alert("Pinterest OAuth coming soon — waiting on API approval.")}
              className="w-full flex items-center justify-center gap-3 px-6 py-3.5 rounded-full bg-[#E60023] text-white font-semibold text-sm hover:bg-[#c4001d] active:scale-95 transition-all duration-150 shadow-sm"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
              Continue with Pinterest
            </button>

            {/* Divider */}
            <div className="flex items-center gap-3 my-6">
              <div className="flex-1 h-px bg-border" />
              <span className="text-xs text-muted">what you&apos;re agreeing to</span>
              <div className="flex-1 h-px bg-border" />
            </div>

            {/* Trust points */}
            <ul className="space-y-2.5">
              {[
                "Read-only access to your boards and pins",
                "We never post, like, or follow anything",
                "Your data is never sold or shared",
                "Revoke access anytime from Pinterest settings",
              ].map((point) => (
                <li key={point} className="flex items-start gap-2.5 text-xs text-muted">
                  <span className="text-accent mt-0.5 shrink-0">✓</span>
                  {point}
                </li>
              ))}
            </ul>
          </div>

          <p className="text-center text-xs text-muted mt-6">
            By continuing you agree to our{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
