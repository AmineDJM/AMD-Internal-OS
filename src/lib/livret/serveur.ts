import { prisma } from "@/lib/prisma";
import { anyRoleFilter } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { persistUploadedDocument } from "@/lib/documents";
import { getCareDossier } from "@/lib/queries/care";
import { detailsStockes } from "@/lib/care-fiches";
import { ficheStockee } from "@/lib/missions-equipe/participation";
import { cleLivret } from "@/lib/care-pieces-acces";
import { civiliteDuGrade, livretGeneral, livretIndividuel, versPoste, type EntreeLivret, type MembreLivret } from "./modele";
import { rendreLivretPdf } from "./rendu-pdf";

/**
 * LE LIVRET DE SÉJOUR, CÔTÉ SERVEUR — lire la demande (événement, fiches voyageur, postes de groupe, équipe
 * Adventum, contacts), construire le livret (`modele.ts`, pur), le dessiner (`rendu-pdf.ts`), et le RANGER comme
 * une pièce de la demande (`Document`, catégorie SUPPORTING_DOC, `stepKey` « livret:… ») : même nom à chaque
 * régénération, donc une nouvelle VERSION — l'ancienne reste lisible.
 *
 * La porte (qui génère) est celle des billets émis, vérifiée par la route ; la lecture du PDF passe par
 * `/api/documents/[id]` (et `peutLirePieceDePriseEnCharge` pour l'assistante et l'équipe).
 */

export type PerimetreLivret = "NATIONAL" | "INTERNATIONAL";
const MODULE = { NATIONAL: "CONGRESS_NATIONAL", INTERNATIONAL: "CONGRESS_INTERNATIONAL" } as const;

const iso = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

async function evenement(scope: PerimetreLivret, id: string) {
  if (scope === "INTERNATIONAL") {
    const r = await prisma.congressInternational.findUnique({ where: { id }, select: { name: true, city: true, country: true, startDate: true, endDate: true, requesterId: true, careReservationDossierId: true } });
    return r ? { nom: r.name, ville: r.city, pays: r.country, lieu: null, debut: iso(r.startDate), fin: iso(r.endDate ?? r.startDate), requesterId: r.requesterId, sujetId: r.careReservationDossierId } : null;
  }
  const r = await prisma.congressNational.findUnique({ where: { id }, select: { name: true, city: true, country: true, hostInstitution: true, date: true, endDate: true, requesterId: true, careReservationDossierId: true } });
  return r ? { nom: r.name, ville: r.city, pays: r.country, lieu: r.hostInstitution, debut: iso(r.date), fin: iso(r.endDate ?? r.date), requesterId: r.requesterId, sujetId: r.careReservationDossierId } : null;
}

/** Tout ce que le livret lit d'une demande — sans un montant (les cases passent par `versPoste`). */
export async function entreeDuLivret(scope: PerimetreLivret, requestId: string): Promise<EntreeLivret | null> {
  const ev = await evenement(scope, requestId);
  if (!ev) return null;
  const parent = scope === "NATIONAL" ? { congressNationalId: requestId } : { congressInternationalId: requestId };
  const [care, identites, missions, assistantes] = await Promise.all([
    getCareDossier(scope, requestId),
    prisma.careBeneficiary.findMany({ where: parent, select: { id: true, doctorId: true, jobTitle: true, institution: true } }),
    prisma.missionAssignment.findMany({
      where: { entityType: MODULE[scope], entityId: requestId, archivedAt: null, response: "CONFIRMEE" },
      orderBy: { createdAt: "asc" },
      select: {
        dateDepart: true, dateRetour: true, accordVersionId: true, billetReference: true, billetTrajets: true, hotelNom: true, hotelConfirmation: true,
        user: { select: { name: true, title: true, phone: true } },
      },
    }),
    prisma.user.findMany({ where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) }, select: { id: true, name: true, phone: true }, orderBy: { createdAt: "asc" } }),
  ]);

  // L'annuaire : grade (→ Pr / Dr), service et établissement de chaque praticien, en une requête.
  const doctorIds = identites.map((i) => i.doctorId).filter((x): x is string => Boolean(x));
  const docteurs = doctorIds.length
    ? await prisma.medicalDoctor.findMany({
      where: { id: { in: doctorIds } },
      select: { id: true, title: true, institution: true, serviceRef: { select: { name: true } }, institutionRef: { select: { name: true } } },
    })
    : [];
  const docteurDe = new Map(docteurs.map((d) => [d.id, d]));
  const identiteDe = new Map(identites.map((i) => [i.id, i]));

  // Les dates CONVENUES d'un membre : celles de l'accord (sa fiche de participation), sinon celles de la mission.
  const accords = missions.map((m) => m.accordVersionId).filter((x): x is string => Boolean(x));
  const versions = accords.length ? await prisma.missionParticipationVersion.findMany({ where: { id: { in: accords } }, select: { id: true, contenu: true } }) : [];
  const ficheDe = new Map(versions.map((v) => [v.id, ficheStockee(v.contenu)]));
  const equipe: MembreLivret[] = missions.map((m) => {
    const f = m.accordVersionId ? ficheDe.get(m.accordVersionId) ?? null : null;
    return {
      nom: m.user.name, fonction: m.user.title, telephone: m.user.phone,
      du: f?.presenceDu ?? iso(m.dateDepart) ?? ev.debut, au: f?.presenceAu ?? iso(m.dateRetour) ?? ev.fin,
      billetReference: m.billetReference, trajets: detailsStockes(m.billetTrajets, 2),
      hotelNom: m.hotelNom, hotelConfirmation: m.hotelConfirmation,
    };
  });

  const demandeur = ev.requesterId ? await prisma.user.findUnique({ where: { id: ev.requesterId }, select: { name: true, title: true, phone: true } }) : null;
  // L'assistante de direction : celle qui tient le sujet de réservation, sinon la seule active.
  const sujet = ev.sujetId ? await prisma.dossier.findUnique({ where: { id: ev.sujetId }, select: { assignedToId: true } }) : null;
  const assistante = assistantes.find((a) => a.id === sujet?.assignedToId) ?? (assistantes.length === 1 ? assistantes[0]! : null);

  return {
    evenement: { nom: ev.nom, ville: ev.ville, pays: ev.pays, lieu: ev.lieu, debut: ev.debut, fin: ev.fin, international: scope === "INTERNATIONAL" },
    personnes: care.beneficiaries.map((b) => {
      const i = identiteDe.get(b.id);
      const d = i?.doctorId ? docteurDe.get(i.doctorId) : undefined;
      return {
        id: b.id, nom: b.name, statut: b.status,
        civilite: civiliteDuGrade(d?.title ?? null, i?.jobTitle ?? null),
        fonction: i?.jobTitle ?? null,
        service: d?.serviceRef?.name ?? null,
        etablissement: d?.institutionRef?.name ?? d?.institution ?? i?.institution ?? null,
        postes: b.cells.map(versPoste),
      };
    }),
    groupe: care.groupPostes.map((g) => ({
      id: g.id, serviceKind: g.serviceKind, label: g.label, date: g.date, timeStart: g.timeStart, address: g.address, exclus: g.excludedBeneficiaryIds, status: g.status,
    })),
    equipe,
    demandeur: demandeur ? { nom: demandeur.name, fonction: demandeur.title, telephone: demandeur.phone } : null,
    assistante: assistante ? { nom: assistante.name, fonction: "Assistante de direction", telephone: assistante.phone } : null,
    edition: new Date().toISOString().slice(0, 10),
  };
}

/**
 * GÉNÈRE ET RANGE un livret : le livret GÉNÉRAL (`beneficiaryId` nul) ou celui d'UNE personne de la demande.
 * Rend l'identifiant du `Document` créé (la nouvelle version).
 */
export async function genererLivret(
  acteurId: string, scope: PerimetreLivret, requestId: string, beneficiaryId: string | null,
): Promise<{ ok: true; documentId: string; nom: string } | { ok: false; error: string }> {
  const entree = await entreeDuLivret(scope, requestId);
  if (!entree) return { ok: false, error: "Demande introuvable." };
  let livret;
  if (beneficiaryId) {
    const p = entree.personnes.find((x) => x.id === beneficiaryId);
    if (!p) return { ok: false, error: "Cette personne n'est pas sur la demande." };
    if (p.statut === "REJECTED" || p.statut === "WITHDRAWN") return { ok: false, error: "Cette personne n'est plus prise en charge : pas de livret." };
    livret = livretIndividuel(p, entree);
  } else {
    livret = livretGeneral(entree);
  }
  const pdf = await rendreLivretPdf(livret);
  const module = MODULE[scope];
  const r = await persistUploadedDocument(acteurId, {
    entityType: module, entityId: requestId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL",
    stepKey: cleLivret(beneficiaryId),
    file: new File([new Uint8Array(pdf)], livret.nomFichier, { type: "application/pdf" }),
    buffer: pdf,
  });
  if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le livret n'a pas pu être enregistré." };
  await recordAudit({
    actorId: acteurId, action: "CREATE", module, entityType: module, entityId: requestId,
    summary: `${livret.type === "GENERAL" ? "Livret de la délégation" : "Livret de séjour"} généré — « ${livret.nomFichier} ».`,
  }).catch(() => undefined);
  return { ok: true, documentId: r.documentId, nom: livret.nomFichier };
}

/** Le dernier livret GÉNÉRAL rangé sur une demande (pour la page de mission d'un membre de l'équipe). */
export async function dernierLivretGeneral(entityType: string, entityId: string): Promise<string | null> {
  if (entityType !== "CONGRESS_INTERNATIONAL" && entityType !== "CONGRESS_NATIONAL") return null;
  const d = await prisma.document.findFirst({
    where: { entityType, entityId, stepKey: cleLivret(null), fileKey: { not: null } },
    orderBy: { createdAt: "desc" }, select: { id: true },
  });
  return d?.id ?? null;
}
