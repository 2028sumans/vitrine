"use client";

/**
 * Route-segment error boundary — catches errors thrown from any page below
 * app/layout.tsx (so /, /shop, /brands, /dashboard, etc.). Renders INSIDE
 * the root layout, so nav stays visible.
 *
 * Shows the actual error message and stack instead of the generic
 * "Application error: a client-side exception has occurred" that Next
 * otherwise displays in production. Makes Safari-only bugs debuggable.
 */

import { useEffect } from "react";

export default function RouteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // eslint-disable-next-line no-console
    console.error("[route-error]", error);
  }, [error]);

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6 py-12 bg-background text-foreground">
      <div className="max-w-xl w-full">
        <h1 className="font-display font-light text-4xl mb-3 leading-tight">
          Something broke.
        </h1>
        <p className="font-sans text-sm text-muted-strong mb-6 leading-relaxed">
          A client-side exception was thrown while rendering this page. Please
          screenshot the error below and share it so we can fix it.
        </p>
        <pre className="font-mono text-[11px] leading-relaxed bg-[rgba(42,51,22,0.05)] border border-border p-4 rounded-sm whitespace-pre-wrap break-words overflow-auto max-h-[60vh] mb-6">
          {`name: ${error.name}\n`}
          {`message: ${error.message}\n`}
          {error.digest ? `digest: ${error.digest}\n` : ""}
          {error.stack ? `\nstack:\n${error.stack}` : ""}
        </pre>
        <button
          onClick={() => reset()}
          className="px-6 py-3 bg-foreground text-background font-sans text-[10px] tracking-widest uppercase hover:bg-accent transition-colors"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
