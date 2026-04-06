"use client";

import Link from "next/link";

export default function LoginPage() {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      {/* Nav */}
      <header className="px-6 py-5">
        <div className="max-w-5xl mx-auto">
          <Link
            href="/"
            className="text-foreground font-semibold tracking-tight text-lg hover:text-accent transition-colors"
          >
            Vitrine
          </Link>
        </div>
      </header>

      {/* Login card */}
      <div className="flex-1 flex items-center justify-center px-6 py-20">
        <div className="w-full max-w-sm">
          <div className="text-center mb-8">
            <h1 className="text-3xl font-bold tracking-tight mb-2">
              Sign in to Vitrine
            </h1>
            <p className="text-muted text-sm leading-relaxed">
              Connect your Pinterest account to get your personalized shopping
              page.
            </p>
          </div>

          <div className="bg-white border border-border rounded-2xl p-8 shadow-sm">
            {/* Pinterest OAuth button */}
            <button
              onClick={() => alert("Pinterest OAuth coming soon — waiting on API approval.")}
              className="w-full flex items-center justify-center gap-3 px-6 py-3.5 rounded-full bg-[#E60023] text-white font-semibold text-sm hover:bg-[#c4001d] active:scale-95 transition-all duration-150 shadow-sm"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
              >
                <path d="M12 0C5.373 0 0 5.373 0 12c0 5.084 3.163 9.426 7.627 11.174-.105-.949-.2-2.405.042-3.441.218-.937 1.407-5.965 1.407-5.965s-.359-.719-.359-1.782c0-1.668.967-2.914 2.171-2.914 1.023 0 1.518.769 1.518 1.69 0 1.029-.655 2.568-.994 3.995-.283 1.194.599 2.169 1.777 2.169 2.133 0 3.772-2.249 3.772-5.495 0-2.873-2.064-4.882-5.012-4.882-3.414 0-5.418 2.561-5.418 5.207 0 1.031.397 2.138.893 2.738a.36.36 0 0 1 .083.345l-.333 1.36c-.053.22-.174.267-.402.161-1.499-.698-2.436-2.889-2.436-4.649 0-3.785 2.75-7.262 7.929-7.262 4.163 0 7.398 2.967 7.398 6.931 0 4.136-2.607 7.464-6.227 7.464-1.216 0-2.359-.632-2.75-1.378l-.748 2.853c-.271 1.043-1.002 2.35-1.492 3.146C9.57 23.812 10.763 24 12 24c6.627 0 12-5.373 12-12S18.627 0 12 0z" />
              </svg>
              Continue with Pinterest
            </button>

            <p className="text-center text-xs text-muted mt-6 leading-relaxed">
              We only request read access to your boards and pins. We never
              post, modify, or store your Pinterest data.
            </p>
          </div>

          <p className="text-center text-xs text-muted mt-6">
            By continuing, you agree to our{" "}
            <Link
              href="/privacy"
              className="underline underline-offset-2 hover:text-foreground transition-colors"
            >
              Privacy Policy
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
