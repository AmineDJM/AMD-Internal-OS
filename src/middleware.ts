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

/**
 * LES ROUTES QUI REÇOIVENT DES FICHIERS N'ENTRENT PAS DANS LE MIDDLEWARE (24/11/2026).
 *
 * Dès qu'un middleware s'applique à une requête, Next RECOPIE son corps pour pouvoir le rejouer, et coupe cette copie à
 * `experimental.middlewareClientMaxBodySize` (10 Mo par défaut). Le middleware s'appliquant depuis le 08/11 à toutes les
 * routes, tout envoi de plus de 10 Mo arrivait TRONQUÉ (« Failed to parse body as FormData ») : fichiers du Drive et des
 * documents de 10 à 25 Mo, audio des rapports terrain et des réunions, pièces de la messagerie. Ces routes vérifient
 * elles-mêmes la session ; le middleware ne sert qu'au mode Adventum IA. Le plafond relevé (`next.config.mjs`) couvre le
 * reste (actions serveur avec pièce jointe, 256 Mo comme `serverActions.bodySizeLimit`).
 * Garde-fou : `src/lib/config/corps-middleware.test.ts`.
 */
export const config = {
  matcher: [
    "/((?!api/auth|api/drive|api/documents|api/messaging|api/meetings|api/field-reports|api/onlyoffice|api/regulatory|api/rh|api/prises-en-charge|api/donnees-marche|_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
