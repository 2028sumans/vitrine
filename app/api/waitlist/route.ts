import { Resend } from "resend";
import { NextResponse } from "next/server";

export async function POST(request: Request) {
  const resend = new Resend(process.env.RESEND_API_KEY);
  const { email } = await request.json();

  if (!email || typeof email !== "string" || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 });
  }

  await resend.emails.send({
    from: "MUSE Waitlist <onboarding@resend.dev>",
    to: process.env.WAITLIST_TO_EMAIL!,
    subject: "New waitlist signup — MUSE",
    html: `
      <p style="font-family:sans-serif;font-size:16px;color:#1A1A1A;">
        New waitlist signup:
      </p>
      <p style="font-family:monospace;font-size:18px;color:#C17F5E;">
        ${email}
      </p>
      <p style="font-family:sans-serif;font-size:13px;color:#6B6B68;">
        ${new Date().toLocaleString()}
      </p>
    `,
  });

  return NextResponse.json({ success: true });
}
