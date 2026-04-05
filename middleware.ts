export { default } from "next-auth/middleware";

export const config = {
  // Protect all routes under /dashboard and /storefront/edit
  matcher: ["/dashboard/:path*", "/storefront/edit/:path*"],
};
