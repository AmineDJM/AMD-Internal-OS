import { prisma } from "@/lib/prisma";
import { lireSoldeSaisi, type LigneSolde, type StatutDepart } from "../../domaine/depart/regles";
import { lireCertificatSaisi, type ChampsCertificat } from "../../domaine/depart/certificat";

/**
 * LA FIN DE CONTRAT D'UNE FICHE, POUR L'ÉCRAN (lecture seule) : la plus récente, son circuit tel que le moteur des
 * validations le tient, sa liste de sortie, son solde et son certificat. Le solde n'est rendu qu'à qui voit les
 * salaires (`avecSolde`) — l'appelant le décide, la lecture ne le devine pas.
 */
export interface DepartDTO {
  id: string;
  motif: string;
  dateFin: string;
  preavisJours: number | null;
  note: string | null;
  statut: StatutDepart;
  ouvertLe: Date;
  ouvertPar: string;
  valideLe: Date | null;
  compteFermeLe: Date | null;
  validation: {
    id: string; reference: string; statut: string; version: number;
    etapes: { ordre: number; valideur: string; statut: string; motif: string | null; decideeLe: Date | null }[];
  } | null;
  taches: { id: string; categorie: string; libelle: string; detail: string | null; quantite: number | null; source: string | null; faitLe: Date | null; faitPar: string | null }[];
  solde: LigneSolde[] | null;
  soldeModifieLe: Date | null;
  certificat: ChampsCertificat | null;
  certificatEmisLe: Date | null;
  certificatReference: string | null;
}

export async function getDepartDeLaFiche(employeeId: string, opts: { avecSolde: boolean }): Promise<DepartDTO | null> {
  const d = await prisma.departSalarie.findFirst({
    where: { employeeId }, orderBy: { createdAt: "desc" },
    include: { taches: { orderBy: [{ ordre: "asc" }, { createdAt: "asc" }] } },
  });
  if (!d) return null;
  const v = d.validationRequestId
    ? await prisma.validationRequest.findUnique({
        where: { id: d.validationRequestId },
        select: { id: true, reference: true, status: true, version: true, steps: { orderBy: { order: "asc" }, select: { order: true, status: true, reason: true, decidedAt: true, validator: { select: { name: true } } } } },
      })
    : null;
  const ids = [d.ouvertParId, ...d.taches.map((t) => t.faitParId).filter((x): x is string => !!x)];
  const noms = new Map((await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  // UNE DEMANDE RETIRÉE AILLEURS (Centre de validations) : la fiche dit « annulée » sans attendre la prochaine écriture.
  const statut: StatutDepart = (d.statut === "EN_VALIDATION" || d.statut === "A_CORRIGER") && (!v || v.status === "CANCELLED")
    ? "ANNULE"
    : (d.statut as StatutDepart);
  const solde = opts.avecSolde && d.solde != null ? lireSoldeSaisi(d.solde) : null;
  return {
    id: d.id, motif: d.motif, dateFin: d.dateFin.toISOString().slice(0, 10), preavisJours: d.preavisJours, note: d.note,
    statut,
    ouvertLe: d.createdAt, ouvertPar: noms.get(d.ouvertParId) ?? "—", valideLe: d.valideLe, compteFermeLe: d.compteFermeLe,
    validation: v ? {
      id: v.id, reference: v.reference, statut: v.status, version: v.version,
      etapes: v.steps.map((s) => ({ ordre: s.order, valideur: s.validator?.name ?? "—", statut: s.status, motif: s.reason, decideeLe: s.decidedAt })),
    } : null,
    taches: d.taches.map((t) => ({
      id: t.id, categorie: t.categorie, libelle: t.libelle, detail: t.detail, quantite: t.quantite != null ? Number(t.quantite) : null,
      source: t.source, faitLe: t.faitLe, faitPar: t.faitParId ? noms.get(t.faitParId) ?? "—" : null,
    })),
    solde: solde && solde.ok ? solde.lignes : null,
    soldeModifieLe: d.soldeModifieLe,
    certificat: lireCertificatSaisi(d.certificat),
    certificatEmisLe: d.certificatEmisLe, certificatReference: d.certificatReference,
  };
}
