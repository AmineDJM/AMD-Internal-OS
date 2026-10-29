import { NextResponse } from "next/server";
import { getCurrentUserPourEcrire } from "@/lib/session";
import { hasGlobalView, hasRole } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { peutTeleverserBillet } from "@/modules/ad-pro/partage";
import { genererLivret, type PerimetreLivret } from "@/lib/livret/serveur";
import { attendu } from "@/lib/journal";

export const dynamic = "force-dynamic";

/**
 * GÉNÉRER UN LIVRET DE SÉJOUR (Direction, 10/2026) — `POST` d'un formulaire (`BoutonLivret`) : `scope`, `id` de la demande,
 * `personne` (vide = le livret général de la délégation). Le PDF est rangé dans les pièces de la demande (une nouvelle
 * version à chaque fois), puis le navigateur est renvoyé sur ce document — il s'ouvre dans l'onglet du formulaire.
 *
 * La porte est celle des billets émis (`peutTeleverserBillet` : le demandeur, la Direction Marketing, l'assistante de
 * direction, le Super Admin, la vue globale), et, pour qui n'est ni assistante ni demandeur, la vue de la demande — la
 * même que la page « Billets et confirmations ».
 */
export async function POST(req: Request) {
  const user = await getCurrentUserPourEcrire();
  if (!user) return texte("Session expirée : reconnectez-vous.", 401);
  const form = await req.formData().catch(attendu("corps de requête illisible : c'est une erreur du client, il reçoit le repli", null));
  const scopeBrut = String(form?.get("scope") ?? "");
  const id = String(form?.get("id") ?? "").trim();
  const personne = String(form?.get("personne") ?? "").trim() || null;
  if ((scopeBrut !== "NATIONAL" && scopeBrut !== "INTERNATIONAL") || !id) return texte("Demande non précisée.", 400);
  const scope: PerimetreLivret = scopeBrut;
  const module = scope === "NATIONAL" ? "CONGRESS_NATIONAL" : "CONGRESS_INTERNATIONAL";

  const demande = scope === "NATIONAL"
    ? await prisma.congressNational.findUnique({ where: { id }, select: { requesterId: true } })
    : await prisma.congressInternational.findUnique({ where: { id }, select: { requesterId: true } });
  if (!demande) return texte("Demande introuvable.", 404);
  const autorise = peutTeleverserBillet(
    { id: user.id, roles: [user.role, user.secondaryRole].filter((r): r is NonNullable<typeof r> => Boolean(r)), vueGlobale: hasGlobalView(user) },
    { requesterId: demande.requesterId },
  );
  const sansFiche = hasRole(user, "DIRECTION_ASSISTANT") || hasRole(user, "SUPER_ADMIN") || hasGlobalView(user) || demande.requesterId === user.id;
  if (!autorise || (!sansFiche && !(await canAccessEntity(user, module, id, "VIEW")))) return texte("Demande introuvable.", 404);

  const r = await genererLivret(user.id, scope, id, personne);
  if (!r.ok) return texte(r.error, 409);
  // Une adresse RELATIVE : derrière le proxy de l'hébergeur, `req.url` porte l'hôte interne.
  return new NextResponse(null, { status: 303, headers: { Location: `/api/documents/${r.documentId}`, "Cache-Control": "no-store" } });
}

function texte(message: string, status: number) {
  return new NextResponse(message, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
