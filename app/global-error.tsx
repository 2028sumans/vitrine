"use client";

/**
 * Root-level error boundary (catches errors in app/layout.tsx and below).
 *
 * In production Next.js usually swallows client-side exceptions behind a
 * generic "Application error: a client-side exception has occurred" page
 * that hides the actual stack trace. We intercept that here so the user
 * can actually see what broke — especially useful for Safari-only bugs
 * that don't surface on Chrome/Firefox during development.
 */

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Also log to the console so Safari Web Inspector picks it up.
    // eslint-disable-next-line no-console
    console.error("[global-error]", error);
  }, [error]);

  return (
    <html lang="en">
      <body style={{
        fontFamily: "system-ui, -apple-system, sans-serif",
        background: "#FAFAF5",
        color: "#2A3316",
        padding: "2rem",
        minHeight: "100vh",
        margin: 0,
      }}>
        <div style={{ maxWidth: 720, margin: "0 auto" }}>
          <h1 style={{ fontWeight: 300, fontSize: 32, marginBottom: 16 }}>
            Something broke.
          </h1>
          <p style={{ fontSize: 14, marginBottom: 20, opacity: 0.8 }}>
            A client-side exception was thrown. The text below is the actual
            error — please screenshot and share it so we can fix it.
          </p>
          <pre style={{
            fontFamily: "ui-monospace, SFMono-Regular, monospace",
            fontSize: 12,
            background: "rgba(42,51,22,0.05)",
            border: "1px solid rgba(42,51,22,0.15)",
            padding: "1rem",
            borderRadius: 4,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "auto",
            maxHeight: "60vh",
            marginBottom: 20,
          }}>
            {`name: ${error.name}\n`}
            {`message: ${error.message}\n`}
            {error.digest ? `digest: ${error.digest}\n` : ""}
            {error.stack ? `\nstack:\n${error.stack}` : ""}
          </pre>
          <button
            onClick={() => reset()}
            style={{
              background: "#2A3316",
              color: "#FAFAF5",
              border: "none",
              padding: "12px 24px",
              fontSize: 10,
              letterSpacing: "0.2em",
              textTransform: "uppercase",
              cursor: "pointer",
            }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
