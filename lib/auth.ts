import { NextAuthOptions } from "next-auth";
import { getServiceSupabase } from "@/lib/supabase";

declare module "next-auth" {
  interface Session {
    accessToken?: string;
    user: {
      id: string;
      name?: string | null;
      email?: string | null;
      image?: string | null;
    };
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
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

          const res = await fetch("https://api.pinterest.com/v5/oauth/token", {
            method: "POST",
            headers: {
              "Authorization": `Basic ${credentials}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: new URLSearchParams({
              grant_type:   "authorization_code",
              code:         params.code ?? "",
              redirect_uri: String(params.redirect_uri ?? ""),
            }),
          });

          const tokens = await res.json();
          console.log("[Pinterest token] status:", res.status, "response:", JSON.stringify(tokens).slice(0, 200));
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
        return {
          id:    String(profile.username ?? profile.id ?? "unknown"),
          name:  String(profile.username ?? ""),
          email: null,
          image: profile.profile_image ?? null,
        };
      },
    },
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
          id: token.sub ?? "",
        },
      };
    },
    async jwt({ token, account }) {
      if (account) {
        console.log("[NextAuth] account keys:", Object.keys(account));
        console.log("[NextAuth] access_token present:", !!account.access_token);
        token.accessToken = account.access_token;
      }
      return token;
    },
  },
  pages: {
    signIn: "/login",
    error: "/login",
  },
};
