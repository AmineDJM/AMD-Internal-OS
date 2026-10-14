import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { companyScopedWhere } from "@/lib/company";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { MODULE_LABELS } from "@/lib/labels";
import { getAppSettings } from "@/lib/settings";
import { etatsDesBC } from "@/lib/bons-de-commande/etat";
import type { EtapeBC, PorteBC } from "@/lib/bons-de-commande/regle";
import { fichiersEmis } from "@/lib/legal/fichiers-emis";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BONS DE COMMANDE — la file de ce qu'il faut SIGNER (§118.149), module À PART (§118.176).
 *
 * « Mets un sous-module spécial sous Finances : Bons de commande — les bons de commande à signer
 * de leur part. Si un BC se retrouve là-bas, c'est qu'il doit être signé. » La file ne contient
 * donc QUE des BC « à signer » : validés par leur centre, ou sous le seuil de validation. Un BC
 * qui attend encore un centre n'y est pas — il n'est pas à signer, il est à valider — mais il est
 * COMPTÉ, pour que les signataires sachent ce qui arrive.
 *
 * Puis (01/10/2026) : « le module bon de commande doit être à part et le super admin donne les
 * accès à qui il veut ». La porte n'est plus le droit des Finances mais celui du module
 * `PURCHASE_ORDERS` : « Voir » ouvre la file, « Modifier » est le droit de signer.
 *
 * ── QUI VOIT QUOI ────────────────────────────────────────────────────────────────────────────
 *
 * Le module, puis exactement ce que le registre Legal protège déjà : la même entité
 * (`companyScopedWhere`) et les mêmes LECTEURS DÉSIGNÉS (`legalReaderWhere`). Une file qui
 * montrerait un BC restreint à quelqu'un qui n'en est pas lecteur lui en révélerait le titre, la
 * partie en face et le montant (§118.71). Et la FICHE du bon de commande s'ouvre par la même
 * porte (`legalViewScope`, troisième droit) : une file qu'aucun clic n'ouvre serait une impasse.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/**
 * Qui SIGNE un bon de commande : le droit « Modifier » du module Bons de commande (§118.176) — par
 * défaut ceux qui modifiaient les Finances, ensuite qui le Super Admin désigne.
 */
export function peutSignerBC(user: Pick<CurrentUser, "role" | "access">): boolean {
  return userCan(user as CurrentUser, "PURCHASE_ORDERS", "UPDATE");
}

/**
 * Le refus, écrit une fois : l'écran et l'action disent la même phrase. Il nomme la CASE à cocher
 * et l'écran où elle se coche : « revient aux Finances » ne dit pas au Super Admin quoi faire
 * (§118.30), et n'est plus vrai.
 */
export const REFUS_SIGNATURE_BC =
  `La signature d'un bon de commande demande le droit « Modifier » du module « ${MODULE_LABELS.PURCHASE_ORDERS} » — un Super Admin l'accorde dans Administration › Accès.`;

/**
 * LES BC QUE CETTE PERSONNE A LE DROIT DE LIRE — `null` : aucun. Le module, puis la même clause que
 * la liste Legal réduite aux bons de commande ; l'action de signature la rejoue sur la pièce visée.
 */
export async function bcVisiblesWhere(user: CurrentUser): Promise<Prisma.LegalDocumentWhereInput | null> {
  if (!userCan(user, "PURCHASE_ORDERS", "VIEW")) return null;
  const readerScope = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  return companyScopedWhere(user.id, {
    kind: "PURCHASE_ORDER",
    ...(readerScope ? { AND: [readerScope] } : {}),
  } as Prisma.LegalDocumentWhereInput);
}

export interface LigneBCFinances {
  id: string;
  reference: string | null;
  title: string;
  counterparty: string | null;
  montant: number | null;
  societe: string | null;
  creePar: string | null;
  creeLe: string;
  driveNodeId: string | null;
  /** Le Word et le PDF que la FABRIQUE a produits — ils s'ouvrent sous la porte de la pièce
   *  (`lienFichierEmis`), pas du Drive personnel de celui qui l'a émise (§118.152). */
  fichiers: { docx: boolean; pdf: boolean };
  etape: EtapeBC;
  porte: PorteBC | null;
  validationRequise: boolean;
  signeLe: string | null;
  signePar: string | null;
  /** Renvoyé à son émetteur (audit 360°, R09) : qui, quand, et ce qu'il faut corriger. */
  renvoi: { le: string; par: string | null; note: string | null } | null;
}

export interface FileBCFinances {
  aSigner: LigneBCFinances[];
  /**
   * Renvoyés à leur émetteur pour correction : ils ne sont plus à signer, mais les signataires les
   * VOIENT — un BC sorti de la file sans laisser de trace se lirait comme un BC perdu (§118.52).
   */
  renvoyes: LigneBCFinances[];
  signes: LigneBCFinances[];
  /** BC du circuit qui attendent encore un centre — comptés, pas listés : ils ne sont pas à signer. */
  enValidation: number;
  /** Seuil du centre Ad & Pro (BC de promotion). */
  seuil: number;
  /** Seuil du centre de validations (BC hors Ad & Pro). */
  seuilCentre: number;
  /** Vrai quand la file a été bornée : l'écran le dit au lieu de se croire exhaustif. */
  tronquee: boolean;
}

/** Au-delà, la file se dirait exhaustive sans l'être : on borne, et on le DIT (§118.60). */
const PLAFOND_FILE = 200;

export async function fileBonsDeCommande(user: CurrentUser, opts: { signesRecents?: number } = {}): Promise<FileBCFinances | null> {
  const visibles = await bcVisiblesWhere(user);
  if (!visibles) return null;
  const select = {
    id: true, reference: true, title: true, counterparty: true, createdAt: true, driveNodeId: true, custom: true,
    company: { select: { name: true, shortName: true } },
    createdBy: { select: { name: true } },
  } as const;

  const [enVol, signesDocs] = await Promise.all([
    // EN VOL : dans le circuit, pas encore signés, pas annulés.
    prisma.legalDocument.findMany({
      where: { AND: [visibles, { signedAt: null, bcCircuitAt: { not: null }, status: { notIn: ["CANCELLED", "RENEWED"] } }] },
      select, orderBy: { createdAt: "asc" }, take: PLAFOND_FILE,
    }),
    prisma.legalDocument.findMany({
      where: { AND: [visibles, { signedAt: { not: null }, signedById: { not: null } }] },
      select, orderBy: { signedAt: "desc" }, take: opts.signesRecents ?? 20,
    }),
  ]);

  // Chaque BC lit le seuil de SON centre (Ad & Pro ou centre de validations — Direction, 10/2026).
  const reglages = await getAppSettings();
  const seuil = reglages.bcValidationThreshold;
  const seuilCentre = reglages.bcValidationThresholdCentre;
  const etats = await etatsDesBC([...enVol, ...signesDocs].map((d) => d.id));
  const ligne = (d: (typeof enVol)[number]): LigneBCFinances | null => {
    const e = etats.get(d.id);
    if (!e) return null;
    return {
      id: d.id, reference: d.reference, title: d.title, counterparty: d.counterparty, montant: e.montant,
      societe: d.company ? (d.company.shortName || d.company.name) : null,
      creePar: d.createdBy?.name ?? null, creeLe: d.createdAt.toISOString(), driveNodeId: d.driveNodeId,
      fichiers: (() => { const f = fichiersEmis(d.custom); return { docx: Boolean(f.docx), pdf: Boolean(f.pdf) }; })(),
      etape: e.etape, porte: e.porte, validationRequise: e.validationRequise,
      signeLe: e.signeLe?.toISOString() ?? null, signePar: e.signePar?.name ?? null,
      renvoi: e.renvoi ? { le: e.renvoi.le.toISOString(), par: e.renvoi.par, note: e.renvoi.note } : null,
    };
  };
  const lignesEnVol = enVol.map(ligne).filter((l): l is LigneBCFinances => l !== null);
  return {
    aSigner: lignesEnVol.filter((l) => l.etape === "A_SIGNER"),
    renvoyes: lignesEnVol.filter((l) => l.etape === "A_CORRIGER"),
    signes: signesDocs.map(ligne).filter((l): l is LigneBCFinances => l !== null),
    enValidation: lignesEnVol.filter((l) => l.etape === "A_VALIDER" || l.etape === "A_REVOIR" || l.etape === "SANS_PORTE").length,
    seuil,
    seuilCentre,
    tronquee: enVol.length >= PLAFOND_FILE,
  };
}
