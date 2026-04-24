/**
 * POST /api/auth/signup
 *
 * Creates a MUSE-native (email + password) account. On success returns
 * { ok: true } and the caller signs in via signIn("credentials", ...) with
 * the same email + password.
 *
 * Request body
 * ------------
 *   { email: string, password: string, name?: string }
 *
 * Response
 * --------
 *   200 { ok: true, email }                 — account created
 *   400 { error: "invalid-email" | ... }    — validation failed
 *   409 { error: "email-taken" }            — email already registered
 *   500 { error: "internal" }               — unexpected
 *
 * Design notes
 * ------------
 * - We do NOT create a NextAuth session here. The client calls signIn()
 *   immediately after the 200 response, which exercises the Credentials
 *   authorize() path (same as a normal sign-in). One code path for "log
 *   me in" is strictly simpler than two.
 * - Passwords are stored as bcrypt hashes, cost 12. 12 is the 2024 default
 *   recommended by OWASP; it costs ~200 ms per hash on commodity hardware.
 * - Pinterest users have placeholder emails (`username@pinterest.muse`)
 *   which can collide with a real Pinterest-muse domain email. We check
 *   the incoming email against that exact suffix and reject — nobody
 *   should ever be registering one.
 */

import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { getServiceSupabase } from "@/lib/supabase";

const BCRYPT_COST = 12;

// Minimum viable password rules. Deliberately permissive — strict rules
// backfire (users forget them, write them down). We only reject the truly
// bad cases.
const MIN_PASSWORD_LEN = 8;

// Simple RFC-compliant-ish check. Good enough for "looks like an email".
// We're not trying to validate deliverability here.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "bad-json" }, { status: 400 });
  }

  const b        = body as Record<string, unknown>;
  const email    = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  const nameRaw  = String(b.name ?? "").trim();
  const name     = nameRaw.slice(0, 120) || null;

  if (!email || !EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }
  if (email.endsWith("@pinterest.muse")) {
    // Reserved for the Pinterest-OAuth placeholder emails. Blocking here
    // prevents an attacker from pre-registering @pinterest.muse addresses.
    return NextResponse.json({ error: "invalid-email" }, { status: 400 });
  }
  if (!password || password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json({ error: "weak-password" }, { status: 400 });
  }

  try {
    const sb = getServiceSupabase();

    // Email uniqueness check. We also enforce this in Supabase's UNIQUE
    // constraint on users.email, so this is belt-and-braces — returning a
    // clean 409 here avoids relying on insert-side error text.
    const { data: existing } = await sb
      .from("users")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (existing) {
      return NextResponse.json({ error: "email-taken" }, { status: 409 });
    }

    const password_hash = await bcrypt.hash(password, BCRYPT_COST);

    const { error } = await sb.from("users").insert({
      email,
      name,
      password_hash,
      // pinterest_id stays NULL for MUSE accounts. Fine — the UNIQUE
      // constraint on pinterest_id allows multiple NULLs.
    });

    if (error) {
      // Race between the .select check above and the insert → fallback to
      // the 409 path. Any other insert error is a real 500.
      const msg = String(error.message ?? "").toLowerCase();
      if (msg.includes("duplicate") || msg.includes("unique")) {
        return NextResponse.json({ error: "email-taken" }, { status: 409 });
      }
      console.error("[signup] insert failed:", error.message);
      return NextResponse.json({ error: "internal" }, { status: 500 });
    }

    return NextResponse.json({ ok: true, email });
  } catch (err) {
    console.error("[signup] unexpected:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "internal" }, { status: 500 });
  }
}
