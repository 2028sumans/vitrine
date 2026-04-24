import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { getServiceSupabase } from "@/lib/supabase";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    user: {
      id:        string;
      name?:     string | null;
      email?:    string | null;
      image?:    string | null;
      /** Which auth path this session came from. Used to gate Pinterest-
       *  only features (Pinterest board import) — Credentials users see
       *  those surfaces grayed out. */
      provider?: "pinterest" | "credentials";
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    /** Mirror of session.user.provider — propagated via the jwt() callback
     *  so session() can read it. Defaults to "pinterest" for legacy sessions
     *  issued before this field existed. */
    provider?:   "pinterest" | "credentials";
  }
}

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
  session: { strategy: "jwt" },
  providers: [
    {
      id: "pinterest",
      name: "Pinterest",
      type: "oauth",
      checks: ["state"],   // disable PKCE — send code_verifier manually if needed
      authorization: {
        url: "https://www.pinterest.com/oauth/",
        params: {
          scope: "boards:read,pins:read",
          response_type: "code",
        },
      },
      token: {
        url: "https://api.pinterest.com/v5/oauth/token",
        async request({ params, provider }) {
          const credentials = Buffer.from(
            `${provider.clientId}:${provider.clientSecret}`
          ).toString("base64");

          console.log("[Pinterest token] params keys:", Object.keys(params));

          const body: Record<string, string> = {
            grant_type:   "authorization_code",
            code:         String(params.code ?? ""),
            redirect_uri: `${process.env.NEXTAUTH_URL}/api/auth/callback/pinterest`,
          };

          // Include PKCE code_verifier if NextAuth generated one
          if (params.code_verifier) {
            body.code_verifier = String(params.code_verifier);
          }

          const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
            method: "POST",
            headers: {
              "Authorization": `Basic ${credentials}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams(body),
          });

          const tokens = await res.json();
          console.log("[Pinterest token] status:", res.status, "response:", JSON.stringify(tokens).slice(0, 300));
          return { tokens };
        },
      },
      userinfo: {
        url: "https://api.pinterest.com/v5/user_account",
        async request({ tokens }) {
          const res = await fetch("https://api.pinterest.com/v5/user_account", {
            headers: { Authorization: `Bearer ${tokens.access_token}` },
          });
          const profile = await res.json();
          console.log("[Pinterest userinfo] status:", res.status, "keys:", Object.keys(profile));
          return profile;
        },
      },
      clientId: process.env.PINTEREST_APP_ID,
      clientSecret: process.env.PINTEREST_APP_SECRET,
      profile(profile) {
        console.log("[Pinterest profile] raw:", JSON.stringify(profile).slice(0, 200));
        const username = String(profile.username ?? profile.id ?? "unknown");
        return {
          id:    username,
          name:  username,
          // NextAuth requires a non-null email — use a placeholder
          email: `${username}@pinterest.muse`,
          image: profile.profile_image ?? null,
        };
      },
    },

    // MUSE-native email + password account. Used by /login's "Create or sign
    // into a MUSE account" tab and by /api/auth/signup (which pre-creates the
    // row, then calls signIn("credentials") with the just-set password).
    CredentialsProvider({
      id:   "credentials",
      name: "MUSE account",
      credentials: {
        email:    { label: "Email",    type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        const email    = String(credentials?.email    ?? "").trim().toLowerCase();
        const password = String(credentials?.password ?? "");
        if (!email || !password) return null;

        try {
          const sb = getServiceSupabase();
          const { data } = await sb
            .from("users")
            .select("id, email, name, image, password_hash")
            .ilike("email", email)
            .maybeSingle();
          if (!data?.password_hash) return null;

          const match = await bcrypt.compare(password, data.password_hash);
          if (!match) return null;

          // The `id` NextAuth puts on session.user.id is what the rest of
          // the app uses as `user_token`. Using email here (lowercased)
          // keeps that string stable across sign-ins without exposing
          // the UUID and without colliding with Pinterest usernames
          // (which don't contain @).
          return {
            id:    email,
            email,
            name:  (data.name as string | null) ?? email.split("@")[0],
            image: (data.image as string | null) ?? null,
          };
        } catch (err) {
          console.error("[credentials.authorize] failed:", err instanceof Error ? err.message : err);
          return null;
        }
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider !== "pinterest") return false;

      // Best-effort user upsert — never block sign-in on DB failure
      try {
        const supabase = getServiceSupabase();
        await supabase.from("users").upsert(
          {
            pinterest_id: user.id,
            name: user.name,
            image: user.image,
          },
          { onConflict: "pinterest_id" }
        );
      } catch (err) {
        console.warn("User upsert failed (non-fatal):", err);
      }

      return true;
    },
    async session({ session, token }) {
      return {
        ...session,
        accessToken: token.accessToken,
        user: {
          ...session.user,
          id:       token.sub ?? "",
          // Legacy sessions (issued before the provider tag landed) read as
          // "pinterest" — that matches pre-existing behavior since Pinterest
          // was the only path.
          provider: token.provider ?? "pinterest",
        },
      };
    },
    async jwt({ token, account }) {
      if (account) {
        console.log("[NextAuth] account keys:", Object.keys(account));
        console.log("[NextAuth] access_token present:", !!account.access_token);
        token.accessToken = account.access_token;
        // The account.provider string is "pinterest" for OAuth or
        // "credentials" for the CredentialsProvider — narrow defensively.
        token.provider = account.provider === "credentials" ? "credentials" : "pinterest";
      }
      return token;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
};
