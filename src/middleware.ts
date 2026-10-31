import NextAuth from "next-auth";
import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import { MODE_ADVENTUM_IA } from "@/platform/app-mode";

/**
 * LE MIDDLEWARE — dans `src/`, là où Next le cherche quand l'App Router vit dans `src/app` (31/10/2026).
 *
 * Il était à la racine du dépôt : Next ne l'a JAMAIS compilé (`middleware-manifest.json` vide). L'ERP s'en passait — ses
 * pages et ses routes vérifient elles-mêmes la session — mais le site Adventum IA (`APP_MODE=adventum-ia`) servait
 * l'ERP entier : sa racine, ses renvois vers l'app, ses refus n'existaient que dans `authorized` (`auth.config.ts`).
 *
 * Il ne s'applique donc QU'AU MODE APP. Sur l'ERP, il laisse tout passer : allumer d'un coup, en production, une
 * protection qui n'a jamais tourné (webhooks, portail, sondes) serait un changement à part, mesuré pour lui-même.
 */
const auth = NextAuth(authConfig).auth as unknown as (req: NextRequest, ev: NextFetchEvent) => Promise<Response | undefined>;

export default function middleware(req: NextRequest, ev: NextFetchEvent) {
  if (process.env.APP_MODE !== MODE_ADVENTUM_IA) return NextResponse.next();
  return auth(req, ev);
}

export const config = {
  // Run on all routes except Next internals, the auth API, and static assets.
  matcher: [
    "/((?!api/auth|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
