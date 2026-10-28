/**
 * PRISE EN CHARGE — les ÉCRIVAINS LOCAUX du fichier d'actions : la trace d'audit d'un geste, la fiche d'une
 * personne (billetterie, hôtellerie), le sujet de l'assistante de direction.
 *
 * Sortis de `actions/care-actions.ts` (lot V4). C'étaient des fonctions LOCALES du fichier, appelées sans le
 * formulaire : le contrat des actions ne les suivait pas. Elles gardent ce statut — le fichier d'actions les
 * désigne par un alias local, et les corps internes (`./saisie`, `./circuit`) par un import RELATIF, que la
 * dérivation ne suit pas (`contrat/internes.ts`).
 */
import { Prisma } from "@prisma/client";
import { anyRoleFilter, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { deviseDuPoste } from "@/lib/care-fiches";
import { createDossierRecord, ecrireDansLeSujet } from "@/lib/dossiers-core";
import { sansBloquer } from "@/lib/journal";
import { SPEC, type loadRequest, type Scope } from "@/lib/actions/internes/care/demande";

export async function journaliser(user: SessionUser, scope: Scope, id: string, action: "CREATE" | "UPDATE" | "DELETE", detail: string) {
  await recordAudit({
    actorId: user.id, module: SPEC[scope].module, entityType: SPEC[scope].module, entityId: id, action, summary: detail,
  }).catch(sansBloquer("care-actions.audit.recordAudit"));
}

/**
 * OUVRIR LA FICHE D'UNE PERSONNE — sa billetterie et son hôtellerie, ouvertes par défaut (Direction, 10/2026).
 * Idempotent : une personne qui a déjà un billet (ou un hôtel) n'en reçoit pas un second. L'hôtel prend la
 * ville de l'événement ; ses dates viendront du billet.
 */
export async function ouvrirLaFiche(tx: Prisma.TransactionClient, scope: Scope, beneficiaryId: string, city: string | null, userId: string) {
  const deja = await tx.careCell.findMany({ where: { beneficiaryId, kind: "SERVICE", serviceKind: { in: ["TICKET", "HOTEL"] } }, select: { serviceKind: true } });
  const last = await tx.careCell.findFirst({ where: { beneficiaryId }, orderBy: { position: "desc" }, select: { position: true } });
  let pos = last?.position ?? 0;
  const data: Prisma.CareCellCreateManyInput[] = [];
  if (!deja.some((c) => c.serviceKind === "TICKET")) {
    data.push({ beneficiaryId, kind: "SERVICE", serviceKind: "TICKET", label: "Billetterie", currency: deviseDuPoste(scope, "TICKET"), requestedById: userId, position: ++pos });
  }
  if (!deja.some((c) => c.serviceKind === "HOTEL")) {
    data.push({ beneficiaryId, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city, currency: deviseDuPoste(scope, "HOTEL"), requestedById: userId, position: ++pos });
  }
  if (data.length) await tx.careCell.createMany({ data });
}

/**
 * LE SUJET DE L'ASSISTANTE DE DIRECTION pour cette prise en charge — celui déjà ouvert (on y écrit), sinon un
 * nouveau. Même règle qu'au sponsoring : une seule assistante active en est responsable ; plusieurs, toutes
 * participantes ; aucune, la demande n'a personne à qui partir, et on le dit.
 */
export async function ecrireAuSujetDeLAssistante(
  scope: Scope, req: NonNullable<Awaited<ReturnType<typeof loadRequest>>>, user: SessionUser, titre: string, corps: string,
): Promise<{ ok: true; id: string; reference: string; nouveau: boolean } | { ok: false; error: string }> {
  if (req.careReservationDossierId) {
    const ecrit = await ecrireDansLeSujet({ dossierId: req.careReservationDossierId, authorId: user.id, body: `${titre}\n${corps}` });
    if (ecrit) {
      const d = await prisma.dossier.findUnique({ where: { id: req.careReservationDossierId }, select: { reference: true } });
      return { ok: true, id: req.careReservationDossierId, reference: d?.reference ?? "", nouveau: false };
    }
  }
  const assistantes = await prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) },
    select: { id: true }, orderBy: { createdAt: "asc" },
  });
  if (assistantes.length === 0) {
    return { ok: false, error: "Aucune assistante de direction active : la demande n'a personne à qui partir (Administration › Comptes)." };
  }
  const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
  const sujet = await createDossierRecord({
    title: `Prise en charge — ${req.name}`,
    description: `${titre}\n${corps}`,
    category: "Billets",
    priority: "HIGH",
    assignedToId: seule,
    participantIds: [...(seule ? [] : assistantes.map((a) => a.id)), ...(req.requesterId ? [req.requesterId] : [])],
    sourceType: SPEC[scope].module,
    sourceId: req.id,
    companyId: req.companyId ?? null,
  }, user.id);
  if (scope === "NATIONAL") await prisma.congressNational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  else await prisma.congressInternational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  return { ok: true, id: sujet.id, reference: sujet.reference, nouveau: true };
}
