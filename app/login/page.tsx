"use client";

/**
 * /login — two sign-in paths on one page:
 *
 *   1. Pinterest OAuth — required for Pinterest board import in /dashboard.
 *   2. MUSE email + password — browse + onboarding + everything that
 *      doesn't touch Pinterest. Simpler first-time experience for users
 *      without a Pinterest account.
 *
 * The MUSE tab flips between "Sign in" and "Create account" modes — same
 * form fields, just a toggle at the bottom. Signup POSTs to
 * /api/auth/signup and then immediately calls signIn("credentials") with
 * the same creds, so the session-setting path is the same for both modes.
 *
 * Post-sign-in routing
 * --------------------
 * Both paths pass `callbackUrl=/post-login` so the user lands on a thin
 * router that checks onboarding completion (status API) and forwards to
 * /onboarding or /shop accordingly. That page doesn't exist yet in the
 * legacy codebase; it's added alongside this route in the same commit.
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { signIn } from "next-auth/react";

// Wrapping in Suspense because `useSearchParams` bails static rendering.
export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const searchParams = useSearchParams();
  // Allow deep-links to pre-fill a callback. Defaults to /post-login which
  // runs the "has the user onboarded yet?" check, then routes.
  const callbackUrl  = searchParams?.get("callbackUrl") ?? "/post-login";

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* Nav */}
      <header className="px-8 py-6 border-b border-border">
        <div className="max-w-5xl mx-auto">
          <Link
            href="/"
            className="font-display font-light tracking-[0.20em] text-base text-foreground hover:text-accent transition-colors duration-200"
          >
            MUSE
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="flex-1 flex items-center justify-center px-8 py-16">
        <div className="w-full max-w-md">
          <p className="font-sans text-[9px] tracking-widest uppercase text-muted mb-6 text-center">
            Your personal edit
          </p>
          <h1 className="font-display font-light text-5xl text-foreground leading-[1.05] text-center mb-3">
            Welcome.
          </h1>
          <p className="font-display font-light italic text-lg text-muted text-center mb-10 leading-relaxed">
            Pick how you want to sign in.
          </p>

          {/* Pinterest path */}
          <PinterestButton callbackUrl={callbackUrl} />

          {/* Divider */}
          <div className="flex items-center gap-4 my-10">
            <div className="flex-1 border-t border-border" />
            <span className="font-sans text-[9px] tracking-widest uppercase text-muted-dim">or</span>
            <div className="flex-1 border-t border-border" />
          </div>

          {/* MUSE account path */}
          <MuseAccountForm callbackUrl={callbackUrl} />

          <p className="text-center font-sans text-[10px] text-muted/60 mt-10">
            By continuing you agree to our{" "}
            <Link href="/privacy" className="underline underline-offset-2 hover:text-muted transition-colors">
              Privacy Policy
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

// ── Pinterest button ──────────────────────────────────────────────────────────

function PinterestButton({ callbackUrl }: { callbackUrl: string }) {
  const [loading, setLoading] = useState(false);

  return (
    <button
      onClick={async () => {
        setLoading(true);
        await signIn("pinterest", { callbackUrl });
      }}
      disabled={loading}
      className="w-full flex items-center justify-center gap-3 px-6 py-4 bg-[#E60023] text-white font-sans text-[11px] tracking-widest uppercase hover:bg-[#c4001d] active:scale-[0.98] transition-all duration-150 disabled:opacity-60 disabled:cursor-not-allowed"
    >
      {loading ? (
        <svg className="animate-spin shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeDasharray="31.4 62.8" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="shrink-0" aria-hidden>
          <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
        </svg>
      )}
      {loading ? "Connecting…" : "Continue with Pinterest"}
    </button>
  );
}

// ── MUSE account form ────────────────────────────────────────────────────────

/**
 * One form, two modes. The toggle at the bottom flips mode without unmounting
 * the inputs so anything typed survives the switch (useful when the user
 * realises mid-form they're on the wrong screen).
 */
function MuseAccountForm({ callbackUrl }: { callbackUrl: string }) {
  const [mode, setMode]         = useState<"signin" | "signup">("signin");
  const [email, setEmail]       = useState("");
  const [password, setPassword] = useState("");
  const [name, setName]         = useState("");
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState<string | null>(null);

  const isSignup = mode === "signup";

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isSignup) {
        // Create the account first. 409 = email already registered — tell
        // the user to switch to sign-in.
        const res = await fetch("/api/auth/signup", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({ email, password, name: name || undefined }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          const code: string = body?.error ?? "internal";
          const msg =
            code === "email-taken"   ? "That email is already registered — switch to Sign in."
          : code === "invalid-email" ? "That doesn't look like a valid email."
          : code === "weak-password" ? "Password must be at least 8 characters."
          :                            "Sign-up failed. Try again in a moment.";
          throw new Error(msg);
        }
      }
      // Same path for both modes: hand email + password to NextAuth.
      const result = await signIn("credentials", {
        email,
        password,
        redirect:    false,
        callbackUrl,
      });
      if (result?.error) {
        // For signin: wrong password / no such user. For signup: highly
        // unlikely (we just created the row) but handle anyway.
        throw new Error(isSignup
          ? "Account created but sign-in failed. Try signing in manually."
          : "Email or password doesn't match."
        );
      }
      // Navigate on success. `signIn` in redirect:false mode doesn't navigate
      // for us, so we do it explicitly — callbackUrl is user-controlled so
      // we keep it on-origin.
      window.location.href = result?.url ?? callbackUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong.");
      setLoading(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      {isSignup && (
        <Field
          label="Name"
          hint="What should we call you?"
          input={
            <input
              type="text"
              autoComplete="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-4 py-3 bg-transparent border border-border-mid focus:border-foreground focus:outline-none font-sans text-sm text-foreground transition-colors"
              placeholder="Optional"
            />
          }
        />
      )}

      <Field
        label="Email"
        input={
          <input
            type="email"
            required
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full px-4 py-3 bg-transparent border border-border-mid focus:border-foreground focus:outline-none font-sans text-sm text-foreground transition-colors"
            placeholder="you@domain.com"
          />
        }
      />

      <Field
        label="Password"
        hint={isSignup ? "At least 8 characters." : undefined}
        input={
          <input
            type="password"
            required
            minLength={isSignup ? 8 : undefined}
            autoComplete={isSignup ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full px-4 py-3 bg-transparent border border-border-mid focus:border-foreground focus:outline-none font-sans text-sm text-foreground transition-colors"
            placeholder="••••••••"
          />
        }
      />

      {error && (
        <p className="font-sans text-xs text-[#7a2a2a] leading-relaxed" role="alert">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={loading}
        className="w-full px-6 py-3.5 bg-foreground text-background font-sans text-[11px] tracking-widest uppercase hover:bg-accent transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
      >
        {loading
          ? isSignup ? "Creating your account…" : "Signing in…"
          : isSignup ? "Create MUSE account" : "Sign in"}
      </button>

      <div className="text-center pt-1">
        <button
          type="button"
          onClick={() => { setMode(isSignup ? "signin" : "signup"); setError(null); }}
          className="font-sans text-[10px] tracking-widest uppercase text-muted hover:text-foreground transition-colors"
        >
          {isSignup ? "Have an account? Sign in →" : "New here? Create an account →"}
        </button>
      </div>
    </form>
  );
}

function Field({ label, hint, input }: { label: string; hint?: string; input: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block font-sans text-[10px] tracking-widest uppercase text-muted-strong mb-1.5">
        {label}
      </span>
      {input}
      {hint && (
        <span className="block font-sans text-[10px] text-muted mt-1.5">{hint}</span>
      )}
    </label>
  );
}
