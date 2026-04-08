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
      token: "https://api.pinterest.com/v5/oauth/token",
      userinfo: "https://api.pinterest.com/v5/user_account",
      clientId: process.env.PINTEREST_APP_ID,
      clientSecret: process.env.PINTEREST_APP_SECRET,
      profile(profile) {
        return {
          id: profile.username,
          name: profile.username,
          email: null, // Pinterest doesn't return email
          image: profile.profile_image,
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
