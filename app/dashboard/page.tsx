/**
 * /dashboard previously hosted the standalone "Tailor to your taste" intake.
 * That experience now lives inline on every /shop category page (and on
 * /shop?all=1) via the TasteShopFlow component, so /dashboard is just a
 * redirect to /shop?all=1 — preserving any old bookmarks / external links.
 */
import { redirect } from "next/navigation";

export default function DashboardRedirect() {
  redirect("/shop?all=1");
}
