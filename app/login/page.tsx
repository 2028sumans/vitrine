"use client";

import Link from "next/link";
import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [loading, setLoading] = useState(false);

  async function handleSignIn() {
    setLoading(true);
    await signIn("pinterest", { callbackUrl: "/dashboard" });
  }

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">

      {/* Nav */}
      <header className="px-8 py-6 border-b border-border">
        <div className="max-w-5xl mx-auto">
          <Link
            href="/"
            className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200"
          >
            VITRINE
          </Link>
        </div>
      </header>

      {/* Content */}
      <div className="flex-1 flex items-center justify-center px-8 py-24">
        <div className="w-full max-w-sm">

          {/* Eyebrow */}
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-8 text-center">
            Your personal edit
          </p>

          {/* Heading */}
          <h1 className="font-display font-light text-5xl text-foreground leading-[1.05] text-center mb-3">
            Welcome.
          </h1>
          <p className="font-display font-light italic text-lg text-muted text-center mb-14 leading-relaxed">
            Connect your Pinterest.<br />We&apos;ll handle the rest.
          </p>

          {/* Pinterest button */}
          <button
            onClick={handleSignIn}
            disabled={loading}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-[#E60023] text-white font-sans text-[11px] tracking-widest uppercase hover:bg-[#c4001d] active:scale-[0.98] transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed mb-10"
          >
            {loading ? (
              <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4 62.8" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="shrink-0">
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
            )}
            {loading ? "Connecting…" : "Continue with Pinterest"}
          </button>

          {/* Divider */}
          <div className="border-t border-border mb-8" />

          {/* Trust points */}
          <ul className="space-y-3">
            {[
              "Read-only access to your boards and pins",
              "We never post, like, or follow anything",
              "Your data is never sold or shared",
              "Revoke access anytime from Pinterest settings",
            ].map((point) => (
              <li key={point} className="flex items-start gap-3">
                <span className="font-sans text-[9px] text-accent mt-0.5 shrink-0 tracking-widest">✓</span>
                <span className="font-sans text-xs text-muted leading-relaxed">{point}</span>
              </li>
            ))}
          </ul>

          {/* Privacy */}
          <p className="text-center font-sans text-[10px] text-muted/50 mt-12">
            By continuing you agree to our{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-muted transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
