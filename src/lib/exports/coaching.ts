import type { CurrentUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { grilleCourante, lecteurCoaching } from "@/lib/coaching/serveur";
import { chargerFicheVisible, listerFichesVisibles } from "@/lib/coaching/fiches";
import { construireClasseurFiche, construireClasseurSuivi, nomDeFichier, type LignePourListe } from "@/lib/coaching/classeur";
import { formaterJour } from "@/lib/coaching/dates";
import { estIdentifiant } from "@/lib/exports/filtres";
import { exporte, MIME_XLSX, refusExport, type ResultatExport } from "@/lib/exports/types";

/**
 * LES EXPORTS DU COACHING (§118.157) — le suivi (toutes les fiches VISIBLES + la synthèse) et une fiche au format du
 * modèle de la Direction. Partagés par `/api/medical/coaching/export`, `/api/medical/coaching/[id]/export` et
 * l'Assistant IA (lot K7, décision 0037). La portée est celle de l'écran (`listerFichesVisibles`,
 * `chargerFicheVisible`) : un KAM exporte ses fiches, un superviseur celles de son équipe, le directeur des opérations
 * tout. Une fiche invisible rend 404, comme une fiche inexistante.
 */
const LIMITE = 5000;

/** Le collaborateur désigné par son identifiant (l'écran) ou son nom (l'assistant). */
async function collaborateurDesigne(d: string | null | undefined): Promise<string | null> {
  const t = (d ?? "").trim();
  if (!t || estIdentifiant(t)) return t || null;
  return (await prisma.user.findFirst({ where: { name: { contains: t, mode: "insensitive" } }, select: { id: true } }))?.id ?? "introuvable";
}

export async function exporterSuiviCoaching(user: CurrentUser, o: { collaborateur?: string | null; statut?: string | null } = {}): Promise<ResultatExport> {
  if (!userCan(user, "MEDICAL", "VIEW")) return refusExport(403, "Non autorisé.");
  const l = await lecteurCoaching(user);
  const [courante, liste] = await Promise.all([
    grilleCourante(),
    listerFichesVisibles(l, {
      collaboratorId: await collaborateurDesigne(o.collaborateur),
      statut: o.statut === "DRAFT" || o.statut === "FINALIZED" ? o.statut : null,
      limite: LIMITE,
    }),
  ]);
  // UNE COUPE SE DIT (§118.60) — et ici elle refuse : un classeur de suivi partiel se lirait comme complet.
  if (liste.tronque) return refusExport(413, `Plus de ${LIMITE} fiches : filtrez par collaborateur pour exporter.`);
  const lignes: LignePourListe[] = liste.fiches.flatMap((f) => (f.grille
    ? [{
      collaboratorId: f.collaboratorId, collaborateur: f.collaborateur, visitDate: f.visitDate, status: f.status,
      grille: f.grille, notes: f.notes, manager: f.manager, sector: f.sector, gridVersion: f.gridVersion,
      strengths: f.strengths, improvements: f.improvements,
    }]
    : []));
  const octets = await construireClasseurSuivi(lignes, courante.grille);
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Promotion médicale", summary: `Export du suivi du coaching — ${lignes.length} fiche(s)` });
  return exporte(octets, `Suivi_coaching_${new Date().toISOString().slice(0, 10)}.xlsx`, MIME_XLSX, `le suivi du coaching — ${lignes.length} fiche(s)`);
}

/** Une fiche : par son identifiant, ou la plus récente fiche VISIBLE d'un collaborateur désigné par son nom. */
export async function exporterFicheCoaching(user: CurrentUser, designation: string): Promise<ResultatExport> {
  if (!userCan(user, "MEDICAL", "VIEW")) return refusExport(403, "Non autorisé.");
  const l = await lecteurCoaching(user);
  const t = designation.trim();
  let id: string | null = estIdentifiant(t) ? t : null;
  if (!id && t) {
    const collaboratorId = await collaborateurDesigne(t);
    id = collaboratorId ? (await listerFichesVisibles(l, { collaboratorId, limite: 1 })).fiches[0]?.id ?? null : null;
  }
  const fiche = id ? await chargerFicheVisible(l, id) : null;
  if (!fiche) return refusExport(404, "Fiche introuvable.");
  if (!fiche.grille) return refusExport(409, "La grille de cette fiche ne se lit plus : le classeur ne peut pas être composé.");
  const { octets } = await construireClasseurFiche({
    grille: fiche.grille, gridVersion: fiche.gridVersion, collaborateur: fiche.collaborateur, manager: fiche.manager,
    visitDate: fiche.visitDate, sector: fiche.sector, notes: fiche.notes, strengths: fiche.strengths,
    improvements: fiche.improvements, status: fiche.status, finalizedAt: fiche.finalizedAt, finalisePar: fiche.finalisePar,
  });
  const quoi = `la fiche de coaching — ${fiche.collaborateur}, tournée du ${formaterJour(fiche.visitDate)}`;
  await recordAudit({ actorId: user.id, action: "EXPORT", module: "Promotion médicale", entityId: fiche.id, summary: `Export de ${quoi}` });
  return exporte(octets, nomDeFichier(fiche.collaborateur, fiche.visitDate), MIME_XLSX, quoi);
}
