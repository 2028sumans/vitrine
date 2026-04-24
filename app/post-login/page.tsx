"use client";

/**
 * /post-login — the default `callbackUrl` from /login.
 *
 * Thin router that checks whether the freshly-signed-in user has completed
 * the onboarding quiz, then forwards them:
 *
 *   - completed    → /shop      (existing user, skip straight to the app)
 *   - incomplete   → /onboarding (new user, run the quiz)
 *   - signed out   → /login     (somehow landed here without a session)
 *
 * We do this client-side instead of in middleware because the onboarding
 * check is a Supabase call that we'd prefer not to run on EVERY route —
 * running it once here, at the auth-boundary, covers the need.
 *
 * The page never renders anything past a brief loading state — the redirect
 * fires in useEffect, so by the time the browser paints, it's already moved.
 */

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useSession } from "next-auth/react";

export default function PostLoginPage() {
  const router = useRouter();
  const { data: session, status } = useSession();

  useEffect(() => {
    if (status === "loading") return;

    if (status === "unauthenticated" || !session?.user?.id) {
      router.replace("/login");
      return;
    }

    const userToken = session.user.id;

    (async () => {
      try {
        const res = await fetch(`/api/onboarding/status?userToken=${encodeURIComponent(userToken)}`);
        const j   = await res.json();
        router.replace(j?.completed ? "/shop" : "/onboarding");
      } catch {
        // If the status check fails, err on the side of running the quiz
        // (worst case: a returning user sees it twice — they can skip
        // through quickly since their uploads will just overwrite).
        router.replace("/onboarding");
      }
    })();
  }, [status, session, router]);

  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <p className="font-display font-light italic text-xl text-muted">
        One moment…
      </p>
    </div>
  );
}
