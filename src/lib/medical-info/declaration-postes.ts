import type { AdProItemKind, EntityType, Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { notifyRoles } from "@/lib/notify";
import { createMedicalInfoDeclaration } from "@/lib/medical-info";
import { EVENT_SOURCES } from "@/lib/medical-info/circuits";
import { loadEntity } from "@/lib/workflow/engine/entites";
import { reporterLesPostesSurLaDeclaration } from "@/lib/workflow/engine/montants";
import { PARENT_COLONNE, type AdProParent } from "@/lib/chemins/ad-pro";
import { sansBonDeCommande } from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA DÉCLARATION À L'INFORMATION MÉDICALE S'OUVRE QUAND LES DEVIS SONT VALIDÉS (Direction, 19/11/2026 — recette 24/11/2026).
 *
 * « L'information médicale ne doit pas commencer tant qu'Assia n'a pas validé tous les postes et les devis. »
 *
 * Jusqu'au 19/11, le dossier `DIM-…` naissait à la pré-validation, avant le moindre poste. Désormais :
 *   • la pré-validation n'ouvre plus rien (`emitFinancials`, moteur du circuit) ;
 *   • le dossier s'ouvre au moment où le DERNIER poste est PRÊT : accordé par la Direction Marketing, son agence choisie
 *     pour un poste « agence », et — RECETTE 24/11/2026 — SON DEVIS VALIDÉ par la Direction Marketing (au moins une ligne
 *     d'un devis validée pour lui : `validerLignesDuDevis`, ou le choix de l'agence qui valide les lignes retenues). Un
 *     poste sans devis — le versement d'un sponsoring direct (`sansBonDeCommande`), le matériel du stock — est prêt dès
 *     qu'il est accordé. Un poste refusé ne compte pas ; un brouillon retient ;
 *   • UN POSTE TARDIF EST TOUJOURS PERMIS (recette 24/11/2026) : la déclaration ouverte, la demande prend encore des postes.
 *     Ils passent l'accord et le devis comme les autres ; le montant déclaré suit les postes prêts
 *     (`reporterLesPostesDeclares`) et le pharmacien est prévenu (`signalerPostesALaDeclaration`). Une déclaration déjà
 *     validée (ou dont l'ordre est émis) n'est pas réécrite : le pharmacien est prévenu, son montant reste celui validé.
 *
 * Le contrôle de conformité du BAT, poste par poste, ne change pas : il suit son poste.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PostesPourDeclaration {
  /** Les postes qui comptent (non refusés — un brouillon compte : il doit être soumis ou supprimé). */
  total: number;
  /** Ceux qui sont PRÊTS : accordés, agence choisie pour un poste « agence », devis validé pour un poste qui en a un. */
  valides: number;
  /** Tous prêts, et au moins un. */
  prets: boolean;
  /** Ce que portent les postes prêts — le montant accordé, à défaut l'estimation. C'est le montant déclaré. */
  montant: number;
  /** CE QUI BLOQUE ENCORE, dit en clair (« 1 poste en attente de la Direction Marketing »…) — vide quand tout est prêt. */
  blocages: string[];
  /** Les brouillons jamais soumis — ils RETIENNENT la déclaration, et « À venir » le dit. */
  brouillons: number;
}

const estSourceDeclaree = (type: string): type is AdProParent => EVENT_SOURCES.includes(type);

type PosteLu = {
  status: string; kind: string; voie: string | null; amountGranted: unknown; amountEstimated: unknown;
  execution: { agenceRetenueAt: Date | null } | null;
  /** Au moins une ligne d'un devis (non annulé) est validée pour ce poste — ou un BC vivant, ou un devis de voyageur retenu. */
  devisValide: boolean;
};

const pl = (n: number, s: string, p: string) => `${n} ${n > 1 ? p : s}`;

/**
 * CE POSTE PASSE-T-IL PAR UN DEVIS VALIDÉ ? (recette 24/11/2026) — tout poste d'argent, sauf celui qui se paie sans bon de
 * commande (le versement d'un sponsoring direct, la voie « direct » : `sansBonDeCommande`) et le matériel du stock, qui
 * n'engage pas d'argent : les deux seuls dont `validerLignesDuDevis` refuse les lignes. La même frontière, lue au même endroit.
 */
export function passeParUnDevis(p: { kind: string; voie: string | null }): boolean {
  if (p.kind === "STOCK_MATERIAL") return false;
  const voie = p.voie === "AGENCE" || p.voie === "DIRECT" ? p.voie : null;
  return !sansBonDeCommande({ kind: p.kind as AdProItemKind, voie });
}

const sansAgence = (p: PosteLu) => p.status === "APPROVED" && p.voie === "AGENCE" && !p.execution?.agenceRetenueAt;
const sansDevis = (p: PosteLu) => p.status === "APPROVED" && !sansAgence(p) && passeParUnDevis(p) && !p.devisValide;
/** UN POSTE PRÊT À ÊTRE DÉCLARÉ : accordé, son agence choisie (voie « agence »), son devis validé (s'il en a un). */
const estPret = (p: PosteLu) => p.status === "APPROVED" && !sansAgence(p) && !sansDevis(p);

/**
 * LA LECTURE DES POSTES — PURE. UN BROUILLON RETIENT LA DÉCLARATION (recette sponsoring, 23/11/2026) : il compte, et
 * « À venir » dit au pharmacien ce qui retient : « 1 poste en brouillon — à soumettre ou à supprimer ». Un refusé ne compte
 * pas. Un poste accordé dont le devis n'est pas validé retient aussi (recette 24/11/2026).
 */
export function lirePostesPourDeclaration(tous: readonly PosteLu[]): PostesPourDeclaration {
  const brouillons = tous.filter((p) => p.status === "DRAFT").length;
  const postes = tous.filter((p) => p.status !== "REJECTED");
  const valides = postes.filter(estPret);
  const n = (f: (p: PosteLu) => boolean) => postes.filter(f).length;
  const blocages = [
    brouillons ? `${pl(brouillons, "poste", "postes")} en brouillon — à soumettre ou à supprimer` : null,
    n((p) => p.status === "PENDING") ? `${pl(n((p) => p.status === "PENDING"), "poste", "postes")} en attente de la Direction Marketing` : null,
    n((p) => p.status === "REVISION") ? `${pl(n((p) => p.status === "REVISION"), "poste", "postes")} à revoir par le demandeur` : null,
    n(sansAgence) ? `${pl(n(sansAgence), "poste « agence » sans agence choisie", "postes « agence » sans agence choisie")}` : null,
    n(sansDevis) ? `${pl(n(sansDevis), "poste accordé dont le devis n'est pas encore validé", "postes accordés dont le devis n'est pas encore validé")}` : null,
    postes.length === 0 ? "aucun poste" : null,
  ].filter((x): x is string => Boolean(x));
  return {
    total: postes.length,
    valides: valides.length,
    prets: postes.length > 0 && valides.length === postes.length,
    montant: Math.round(valides.reduce((t, p) => t + toNumber(p.amountGranted ?? p.amountEstimated ?? 0) * 100, 0)) / 100,
    blocages,
    brouillons,
  };
}

/** Un devis VIVANT : sa pièce n'est pas annulée. Une ligne validée sur un devis annulé ne valide plus rien. */
const DEVIS_VIVANT = { devis: { legalDocument: { status: { not: "CANCELLED" as const } } } };

const PIECE_QUI_ARRETE_LE_DEVIS: Prisma.AdProItemPieceWhereInput = {
  legalDocument: { status: { not: "CANCELLED" } },
  OR: [{ nature: "BON_DE_COMMANDE" }, { nature: "DEVIS", voyageur: { is: { retenuLe: { not: null } } } }],
};

const CHOIX_POSTE = {
  status: true, kind: true, voie: true, amountGranted: true, amountEstimated: true,
  execution: { select: { agenceRetenueAt: true } },
  lignesDevisValidees: { where: DEVIS_VIVANT, select: { id: true }, take: 1 },
  // LE DEVIS VALIDÉ AUTREMENT QUE LIGNE À LIGNE (recette 24/11/2026) : un BC joint tel quel (ou demandé au secrétariat), ou le
  // devis de billetterie RETENU pour un voyageur, disent aussi que le devis du poste est arrêté — sans eux, ces postes auraient
  // retenu la déclaration pour toujours.
  pieces: { where: PIECE_QUI_ARRETE_LE_DEVIS, select: { id: true }, take: 1 },
} as const;

type PosteBrut = {
  status: unknown; kind: unknown; voie: unknown; amountGranted: unknown; amountEstimated: unknown;
  execution: { agenceRetenueAt: Date | null } | null; lignesDevisValidees: readonly unknown[]; pieces: readonly unknown[];
};
const lu = (p: PosteBrut): PosteLu => ({
  status: String(p.status), kind: String(p.kind), voie: p.voie ? String(p.voie) : null,
  amountGranted: p.amountGranted, amountEstimated: p.amountEstimated, execution: p.execution,
  devisValide: p.lignesDevisValidees.length > 0 || p.pieces.length > 0,
});

/** Où en sont les postes d'une demande, au regard de la déclaration. */
export async function postesPourDeclaration(type: EntityType | string, id: string): Promise<PostesPourDeclaration> {
  if (!estSourceDeclaree(type)) return lirePostesPourDeclaration([]);
  const postes = await prisma.adProItem.findMany({ where: { [PARENT_COLONNE[type]]: id }, select: CHOIX_POSTE });
  return lirePostesPourDeclaration(postes.map(lu));
}

/**
 * CE POSTE EST-IL DÉCLARÉ — prêt, et donc compté dans le montant de la déclaration ? Lu AVANT un geste (la validation des
 * lignes d'un devis) pour savoir, après, s'il vient de rejoindre la déclaration (recette 24/11/2026).
 */
export async function posteCompteDansLaDeclaration(itemId: string): Promise<boolean> {
  const p = await prisma.adProItem.findUnique({ where: { id: itemId }, select: CHOIX_POSTE });
  return p ? estPret(lu(p)) : false;
}

/**
 * « À VENIR » (23/11/2026) — les demandes ACCORDÉES dont la déclaration n'est pas encore ouverte, avec ce qui la retient :
 * le pharmacien voit venir son travail au lieu de le découvrir. Celles sans aucun poste ne sont pas listées, sauf si elles
 * s'ouvrent à la main (ancienne règle, ordre déjà parti). En lot : une requête par table.
 */
export async function declarationsAVenir(): Promise<{ type: AdProParent; id: string; postes: PostesPourDeclaration; ouvrable: boolean }[]> {
  const circuits = await prisma.workflowInstance.findMany({
    where: { entityType: { in: EVENT_SOURCES as EntityType[] }, status: "APPROVED" }, select: { entityType: true, entityId: true },
  });
  if (circuits.length === 0) return [];
  const ouvertes = new Set((await prisma.medicalInfoDeclaration.findMany({
    where: { sourceType: { in: EVENT_SOURCES as EntityType[] }, sourceId: { in: circuits.map((c) => c.entityId) } }, select: { sourceType: true, sourceId: true },
  })).map((d) => `${d.sourceType}:${d.sourceId}`));
  const attente = circuits.filter((c) => !ouvertes.has(`${c.entityType}:${c.entityId}`) && estSourceDeclaree(c.entityType));
  if (attente.length === 0) return [];
  const ids = attente.map((c) => c.entityId);
  const [postes, ordres] = await Promise.all([
    prisma.adProItem.findMany({
      where: { OR: (["SPONSORING", "CONGRESS_NATIONAL", "CONGRESS_INTERNATIONAL", "EVENT"] as const).map((t) => ({ [PARENT_COLONNE[t]]: { in: ids } })) },
      select: { ...CHOIX_POSTE, sponsoringId: true, congressNationalId: true, congressInternationalId: true, eventId: true },
    }),
    prisma.expenseOrder.findMany({ where: { sourceType: { in: EVENT_SOURCES as EntityType[] }, sourceId: { in: ids } }, select: { sourceType: true, sourceId: true } }),
  ]);
  const avecOrdre = new Set(ordres.map((o) => `${o.sourceType}:${o.sourceId}`));
  return attente.flatMap((c) => {
    const type = c.entityType as AdProParent;
    const siens = postes.filter((p) => p[PARENT_COLONNE[type] as "sponsoringId" | "congressNationalId" | "congressInternationalId" | "eventId"] === c.entityId);
    const lus = lirePostesPourDeclaration(siens.map(lu));
    // La règle de `declarationOuvrable` : tous prêts — ou l'ancienne règle, sans poste, son ordre déjà parti.
    const ouvrable = lus.prets || (siens.length === 0 && avecOrdre.has(`${c.entityType}:${c.entityId}`));
    if (siens.length === 0 && !ouvrable) return [];
    return [{ type, id: c.entityId, postes: lus, ouvrable }];
  });
}

/**
 * LA DÉCLARATION PEUT-ELLE S'OUVRIR ? Tous les postes prêts — ou une demande de l'ANCIENNE règle (montant global) : sans
 * poste, son ordre de dépense déjà parti ; elle n'aura jamais de postes à attendre, et le pharmacien l'ouvre à la main.
 */
export async function declarationOuvrable(type: EntityType | string, id: string): Promise<{ ouvrable: boolean; postes: PostesPourDeclaration }> {
  const postes = await postesPourDeclaration(type, id);
  if (postes.prets) return { ouvrable: true, postes };
  if (postes.total > 0 || !estSourceDeclaree(type)) return { ouvrable: false, postes };
  const ancienneRegle = await prisma.expenseOrder.count({ where: { sourceType: type as EntityType, sourceId: id } });
  return { ouvrable: ancienneRegle > 0, postes };
}

/**
 * OUVRIR LE DOSSIER SI LE DERNIER POSTE VIENT D'ÊTRE PRÊT — appelé après chaque changement de poste (décision, refus,
 * retrait, révision), après le choix d'une agence et après la validation des lignes d'un devis (recette 24/11/2026 : c'est
 * d'ordinaire ce geste-là, celui de la Direction Marketing, qui l'ouvre). Idempotent : un dossier existant n'est pas rouvert ;
 * une demande dont le circuit n'est pas conclu (pré-validation) n'en ouvre pas. Rend l'identifiant du dossier ouvert, sinon `null`.
 */
export async function ouvrirDeclarationSiPostesValides(type: EntityType | string, id: string): Promise<string | null> {
  if (!estSourceDeclaree(type)) return null;
  const entite = type as EntityType;
  const existe = await prisma.medicalInfoDeclaration.findUnique({ where: { sourceType_sourceId: { sourceType: entite, sourceId: id } }, select: { id: true } });
  if (existe) return null;
  const circuit = await prisma.workflowInstance.findUnique({
    where: { entityType_entityId: { entityType: entite, entityId: id } }, select: { status: true, budgetCategoryId: true },
  });
  if (!circuit || circuit.status !== "APPROVED") return null;
  const postes = await postesPourDeclaration(type, id);
  if (!postes.prets) return null;
  const resume = await loadEntity(entite, id);
  if (!resume) return null;
  const decl = await createMedicalInfoDeclaration({
    sourceType: entite, sourceId: id, label: resume.label, beneficiary: resume.beneficiary,
    amount: montantDeclare(postes), requesterId: resume.requesterId, budgetCategoryId: circuit.budgetCategoryId ?? null,
  });
  return decl.id;
}

/** Le montant que porte la déclaration : ce que portent ses postes prêts — `null` s'ils ne portent rien. */
const montantDeclare = (postes: PostesPourDeclaration): number | null => (postes.montant > 0 ? postes.montant : null);

/** Une déclaration FIGÉE : validée par la Direction (ordre au comptable), ou rattachée à un ordre déjà émis. */
const figee = (d: { status: string; expenseOrderId: string | null }) => d.status === "VALIDATED" || d.expenseOrderId !== null;

/**
 * LE MONTANT DÉCLARÉ SUIT LES POSTES PRÊTS (recette 24/11/2026) — la même lecture qu'à l'ouverture (`postesPourDeclaration`
 * → `montant`), réécrite après chaque changement de poste : un poste tardif s'y ajoute quand il est prêt (accordé, son devis
 * validé), pas avant. Seulement tant que la déclaration n'est pas FIGÉE — écriture CONDITIONNELLE : une validation passée
 * entre la lecture et l'écriture garde son montant.
 *
 * SANS POSTE (le dernier refusé ou retiré), et pour une source qui ne se déclare pas ici, la règle d'avant
 * (`reporterLesPostesSurLaDeclaration`, §118.191) : le montant redevient celui que le circuit a fixé (ADPRO-03).
 */
export async function reporterLesPostesDeclares(type: EntityType | string, id: string): Promise<void> {
  if (!estSourceDeclaree(type)) {
    await reporterLesPostesSurLaDeclaration(type as EntityType, id);
    return;
  }
  const entite = type as EntityType;
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: entite, sourceId: id } }, select: { id: true, status: true, expenseOrderId: true },
  });
  if (!decl || figee(decl)) return;
  const postes = await postesPourDeclaration(type, id);
  if (postes.total === 0) {
    await reporterLesPostesSurLaDeclaration(entite, id);
    return;
  }
  await prisma.medicalInfoDeclaration.updateMany({
    where: { id: decl.id, status: { not: "VALIDATED" }, expenseOrderId: null },
    data: { amount: montantDeclare(postes) },
  });
}

/**
 * UN POSTE REJOINT UNE DÉCLARATION DÉJÀ OUVERTE (recette 24/11/2026) — appelé quand un poste est AJOUTÉ à une demande
 * déclarée (`AJOUT`), et quand le DEVIS d'un poste tardif est validé (`DEVIS` : lignes validées, ou agence choisie). Sans
 * déclaration, rien : elle s'ouvrira d'elle-même (`ouvrirDeclarationSiPostesValides`).
 *
 *   • le montant déclaré est remis aux postes prêts (`reporterLesPostesDeclares`) — sauf déclaration FIGÉE (validée, ou son
 *     ordre émis) : elle n'est pas réécrite en silence, son montant reste celui validé, et la notification le dit ;
 *   • le pharmacien est prévenu, avec le lien du dossier. Au `DEVIS`, seulement pour un poste désormais PRÊT (il entre dans
 *     ce qui est déclaré) ; l'appelant ne l'appelle que si le poste ne l'était pas avant le geste.
 *
 * Rend `true` si le pharmacien a été prévenu.
 */
export async function signalerPostesALaDeclaration(
  type: EntityType | string, id: string,
  geste: { moment: "AJOUT" | "DEVIS"; ref: string; postes: readonly { id: string; label: string }[] },
): Promise<boolean> {
  if (!estSourceDeclaree(type) || geste.postes.length === 0) return false;
  const entite = type as EntityType;
  const decl = await prisma.medicalInfoDeclaration.findUnique({
    where: { sourceType_sourceId: { sourceType: entite, sourceId: id } }, select: { id: true, reference: true, status: true, expenseOrderId: true },
  });
  if (!decl) return false;
  const postes = geste.moment === "DEVIS"
    ? (await Promise.all(geste.postes.map(async (p) => ((await posteCompteDansLaDeclaration(p.id)) ? p : null)))).filter((p): p is { id: string; label: string } => p !== null)
    : geste.postes;
  if (postes.length === 0) return false;
  const fige = figee(decl);
  if (!fige) await reporterLesPostesDeclares(type, id);
  const montant = fige ? null : (await prisma.medicalInfoDeclaration.findUnique({ where: { id: decl.id }, select: { amount: true } }))?.amount ?? null;
  const noms = postes.map((p) => `« ${p.label} »`).join(", ");
  const quoi = geste.moment === "AJOUT"
    ? `${postes.length > 1 ? "postes ajoutés" : "poste ajouté"} à la demande ${geste.ref} : ${noms}`
    : `devis validé pour ${noms} (demande ${geste.ref})`;
  const suite = fige
    ? decl.status === "VALIDATED"
      ? " — la déclaration est déjà validée : son montant n'est pas modifié."
      : " — la déclaration est déjà rattachée à son ordre de dépense : son montant n'est pas modifié."
    : geste.moment === "AJOUT"
      ? ` — ${postes.length > 1 ? "ils rejoindront la déclaration une fois accordés et leur devis validé" : "il rejoindra la déclaration une fois accordé et son devis validé"} par la Direction Marketing.`
      : ` — ${postes.length > 1 ? "ils sont désormais déclarés" : "il est désormais déclaré"}${montant != null ? ` (montant déclaré : ${toNumber(montant).toLocaleString("fr-FR")} DZD)` : ""}.`;
  await notifyRoles(["MEDICAL_INFO_PHARMACIST"], {
    type: "GENERIC",
    title: "Poste ajouté à une déclaration",
    body: `${decl.reference} — ${quoi}${suite}`,
    link: `/information-medicale/${decl.id}`,
  });
  return true;
}
