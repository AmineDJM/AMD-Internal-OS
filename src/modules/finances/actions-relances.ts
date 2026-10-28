"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import {
  commentaireDeRelance, etatDuPaiement, messageDeRelance, refusDeRelance, QUI_A_LA_MAIN, prevenirQuiALaMain,
} from "@/modules/finances/api";
import { verifierJetonRelance } from "@/lib/factures/jeton-relance";
import { CHEMIN_CENTRE_DE_PAIEMENT } from "@/lib/chemins/finances";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * RELANCER UN PAIEMENT — une action pour ce qui attend vraiment (Direction, 14/10/2026).
 *
 * La cible est la DEMANDE DE PAIEMENT ou l'ORDRE DE DÉPENSE : un poste Ad & Pro qui a demandé son paiement n'a qu'un
 * ordre (et le dossier compagnon que l'ordre ouvre), et c'est lui que le centre autorise puis que les Finances règlent.
 * L'état se lit sur l'ordre (`etatDuPaiement`) et la relance va à QUI A LA MAIN :
 *   • au centre de paiement — le PDG, le Super Admin et les sièges nommés — tant qu'il n'a pas autorisé ;
 *   • aux Finances une fois autorisé ;
 *   • au demandeur quand le dossier lui a été renvoyé (relancé par un tiers).
 *
 * QUI PEUT RELANCER : le demandeur (celui de la demande, ou celui qui a demandé le paiement du poste), la vue globale —
 * et, depuis le blocage « cette facture existe déjà », la personne arrêtée, sur présentation du jeton que le blocage lui
 * a remis (`jeton-relance.ts`). La trace dit QUI a relancé et POURQUOI.
 *
 * LA RÈGLE est celle de la relance du dossier : un paiement réglé, annulé, refusé ou pas encore demandé n'attend
 * personne ; une relance par heure et par personne (`refusDeRelance` → `refusDelaiDeCourtoisie`). Le commentaire est
 * facultatif.
 *
 * Le fil : la demande de paiement porteuse (la demande elle-même, ou le dossier compagnon de l'ordre) reçoit l'événement
 * `NUDGE` — c'est lui que le délai relit, et lui que la fiche montre. Au centre, un message s'ajoute aussi au fil de
 * l'ordre : le centre lit ses ordres, pas les dossiers.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const CIBLES = ["PAYMENT_REQUEST", "EXPENSE_ORDER"] as const;
type Cible = (typeof CIBLES)[number];

interface Lu {
  reference: string;
  ordre: { id: string; reference: string; status: string; centralStatus: string; requestedById: string | null; companyId: string | null } | null;
  dossier: { id: string; reference: string; status: string; requesterId: string; recipientId: string | null } | null;
}

async function lireCible(type: Cible, id: string): Promise<Lu | null> {
  const ORDRE = { id: true, reference: true, status: true, centralStatus: true, requestedById: true, companyId: true } as const;
  const DOSSIER = { id: true, reference: true, status: true, requesterId: true, recipientId: true, expenseOrderId: true } as const;
  if (type === "PAYMENT_REQUEST") {
    const d = await prisma.paymentRequest.findUnique({ where: { id }, select: DOSSIER });
    if (!d) return null;
    const ordre = d.expenseOrderId ? await prisma.expenseOrder.findUnique({ where: { id: d.expenseOrderId }, select: ORDRE }) : null;
    return { reference: d.reference, ordre, dossier: d };
  }
  const ordre = await prisma.expenseOrder.findUnique({ where: { id }, select: ORDRE });
  if (!ordre) return null;
  const dossier = await prisma.paymentRequest.findFirst({ where: { expenseOrderId: id }, select: DOSSIER, orderBy: { createdAt: "asc" } });
  return { reference: ordre.reference, ordre, dossier };
}

function peutRelancerSansJeton(user: SessionUser, lu: Lu): boolean {
  return hasGlobalView(user.role) || lu.dossier?.requesterId === user.id || lu.ordre?.requestedById === user.id;
}

export async function relancerPaiement(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const type = fdStr(formData, "cibleType") as Cible | null;
    const id = fdStr(formData, "cibleId");
    if (!type || !(CIBLES as readonly string[]).includes(type) || !id) return { ok: false, error: "Paiement introuvable." };
    const lu = await lireCible(type, id);
    if (!lu) return { ok: false, error: "Paiement introuvable." };

    const jeton = fdStr(formData, "jeton");
    const parJeton = verifierJetonRelance(jeton, user.id, type, id);
    if (!peutRelancerSansJeton(user, lu) && !parJeton) {
      return { ok: false, error: "Seul le demandeur peut relancer ce paiement." };
    }
    const demandeurId = lu.dossier?.requesterId ?? lu.ordre?.requestedById ?? null;
    const parLeDemandeur = demandeurId === user.id;
    const factureDejaConnue = parJeton && !parLeDemandeur;

    const etat = etatDuPaiement({ ordre: lu.ordre, demande: lu.dossier });
    const derniere = lu.dossier
      ? await prisma.paymentRequestEvent.findFirst({ where: { requestId: lu.dossier.id, kind: "NUDGE", actorId: user.id }, orderBy: { at: "desc" }, select: { at: true } })
      : lu.ordre
        ? await prisma.paymentCentreMessage.findFirst({ where: { orderId: lu.ordre.id, authorId: user.id, body: { startsWith: "Relance" } }, orderBy: { createdAt: "desc" }, select: { createdAt: true } })
            .then((m) => (m ? { at: m.createdAt } : null))
        : null;
    const refus = refusDeRelance({ etat, parLeDemandeur, derniereRelance: derniere?.at ?? null });
    if (refus) return { ok: false, error: refus };

    const commentaire = commentaireDeRelance(fdStr(formData, "commentaire"));
    const auteur = (await prisma.user.findUnique({ where: { id: user.id }, select: { name: true } }))?.name ?? "un utilisateur";
    const reference = lu.ordre && lu.dossier ? `${lu.dossier.reference} (${lu.ordre.reference})` : lu.reference;
    const message = messageDeRelance({ reference, auteur, parLeDemandeur, factureDejaConnue, commentaire });

    // LA TRACE — dans le fil du dossier (c'est lui que le délai relit), et au centre quand c'est lui qui a la main.
    if (lu.dossier) {
      await prisma.paymentRequestEvent.create({
        data: { requestId: lu.dossier.id, actorId: user.id, kind: "NUDGE", message: factureDejaConnue ? `Relance — facture déjà existante : ${message}` : (commentaire ?? "Relance") },
      });
    }
    if (lu.ordre && (etat === "CENTRE" || !lu.dossier)) {
      await prisma.paymentCentreMessage.create({ data: { orderId: lu.ordre.id, body: `Relance — ${message}`, authorId: user.id } });
    }

    const title = factureDejaConnue ? "Relance : une facture déjà en paiement a été redéposée" : "Relance sur un paiement";
    const prevenus = await prevenirQuiALaMain({
      etat, title, body: message, dossierId: lu.dossier?.id ?? null, recipientId: lu.dossier?.recipientId ?? null, demandeurId, acteurId: user.id,
    });
    // LE DEMANDEUR SAIT QU'ON ATTEND SON PAIEMENT : relancé par un tiers, il en est informé.
    if (!parLeDemandeur && demandeurId && etat !== "DEMANDEUR") {
      await notifyUser({ userId: demandeurId, type: "GENERIC", title: "Votre paiement a été relancé", body: message, link: lu.dossier ? `/validations/paiements/${lu.dossier.id}` : CHEMIN_CENTRE_DE_PAIEMENT });
    }
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Demandes de paiement",
      entityType: lu.dossier ? "PAYMENT_REQUEST" : "EXPENSE_ORDER", entityId: lu.dossier?.id ?? lu.ordre?.id ?? id,
      summary: message,
    });
    revalidatePath("/validations/paiements");
    if (lu.dossier) revalidatePath(`/validations/paiements/${lu.dossier.id}`);
    revalidatePath(CHEMIN_CENTRE_DE_PAIEMENT);
    return { ok: true, id: lu.dossier?.id ?? lu.ordre?.id ?? id, message: `Relance envoyée — ${prevenus} (${QUI_A_LA_MAIN[etat] ?? "qui a la main"} a la main).` };
  } catch (err) {
    console.error("[paiement] relancerPaiement failed", err);
    return { ok: false, error: "La relance n'a pas pu être envoyée." };
  }
}
