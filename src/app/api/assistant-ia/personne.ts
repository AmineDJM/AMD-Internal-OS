import { NextResponse } from "next/server";
import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";

/**
 * LE REFUS D'UNE ROUTE DE RELECTURE de l'Assistant IA (fil, Atelier) : personne connectée et titulaire du module —
 * sinon la réponse de refus, toute faite. L'identité, elle, se lit dans la route par `@/lib/session` (la session
 * partagée, Vue exacte comprise) : ce module ne la résout pas.
 */
export function refusAssistantIA(user: CurrentUser | null): NextResponse | null {
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  if (!peutUtiliserAssistantIA(user)) return NextResponse.json({ error: "Non autorisé." }, { status: 403 });
  return null;
}

/** En « Vue exacte », un administrateur regarde l'écran de quelqu'un : il ne lit pas ses données. */
export const enVueExacte = (user: CurrentUser): boolean => Boolean(user.impersonatedBy || user.visualise);

export const SANS_CACHE = { headers: { "Cache-Control": "no-store" } } as const;
