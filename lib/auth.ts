import { NextAuthOptions } from "next-auth";
import { getServiceSupabase } from "@/lib/supabase";

export const authOptions: NextAuthOptions = {
  secret: process.env.NEXTAUTH_SECRET,
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
      clientId: process.env.PINTEREST_CLIENT_ID,
      clientSecret: process.env.PINTEREST_CLIENT_SECRET,
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

      const supabase = getServiceSupabase();

      // Upsert user on first login
      const { error } = await supabase.from("users").upsert(
        {
          pinterest_id: user.id,
          name: user.name,
          image: user.image,
        },
        { onConflict: "pinterest_id" }
      );

      if (error) {
        console.error("Error upserting user:", error);
        return false;
      }

      return true;
    },
    async session({ session, token }) {
      if (token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
    async jwt({ token, account }) {
      if (account) {
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
