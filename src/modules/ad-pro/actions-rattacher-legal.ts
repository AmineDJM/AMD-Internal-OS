"use server";

import { revalidatePath } from "next/cache";
import type { EntityType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { natureLegale } from "@/lib/labels";
import { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS } from "@/modules/ad-pro/partage";
import { aiguillerBC } from "@/lib/bons-de-commande/aiguillage";
import { LIBELLE_CENTRE_BC, reserveSansPorte, reserveDeLAiguillage } from "@/lib/bons-de-commande/regle";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * BRANCHER UN DOCUMENT LEGAL EXISTANT SUR UNE FICHE — sans le recréer.
 *
 * ── LE DÉFAUT MESURÉ ────────────────────────────────────────────────────────────────────
 *
 * Le rattachement ne se faisait qu'à la CRÉATION : les boutons du bloc « pièces liées »
 * fabriquent un engagement, une facture ou un courrier DÉJÀ liés, et c'est la bonne façon quand
 * la pièce n'existe pas encore. Mais dans la vraie vie elle existe souvent AVANT : la convention
 * a été enregistrée dans Legal la semaine dernière, le bon de commande est arrivé par le
 * secrétariat. La seule issue offerte était de la RECRÉER depuis la demande — donc deux lignes
 * pour le même engagement, deux montants dans les totaux, et celle qui porte les pièces jointes
 * n'est pas celle qui porte le lien.
 *
 * ── LES DEUX DROITS, ET IL EN FAUT DEUX ─────────────────────────────────────────────────
 *
 * Rattacher, c'est joindre un objet à un autre : la question n'est donc pas « ai-je le droit
 * d'écrire ici ? » mais « ai-je le droit sur LES DEUX ? ». Il faut pouvoir LIRE le document
 * (sans quoi on rattache une pièce qu'on n'a pas le droit de voir, et le bloc de la fiche la
 * rendrait lisible à tout le monde) ET pouvoir MODIFIER la fiche cible (sans quoi n'importe qui
 * ajoute des engagements à la demande d'un autre). Les deux passent par `canAccessEntity`, qui
 * répond par ENREGISTREMENT et non par module — c'est ce qui distingue un accès Legal général du
 * droit sur CE contrat (§118.71).
 *
 * ── ET CE QU'ON NE FAIT PAS ─────────────────────────────────────────────────────────────
 *
 * On ne VOLE pas un rattachement. Un document déjà lié à une autre fiche n'est pas déplacé en
 * silence : le refus NOMME la fiche qui le porte. Déplacer sans le dire retirerait une pièce
 * d'un dossier que quelqu'un d'autre suit, et personne ne saurait où elle est passée. Le geste
 * pour le faire quand même est de détacher depuis la fiche d'origine — il est nommé, lui aussi.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les natures de fiche sur lesquelles un document Legal se rattache — celles qui portent `sourceType`. */
const CIBLES: readonly EntityType[] = [
  "SPONSORING", "CONGRESS_INTERNATIONAL", "CONGRESS_NATIONAL", "EVENT",
  "PROMO_MATERIAL", "AD_PRO_OTHER", "CONSULTING_CONTRACT",
];

/**
 * L'ADRESSE DE CHAQUE FICHE — lue dans le registre des natures, pas recopiée. La table écrite à la
 * main portait « /ad-pro/materiel » pour le matériel promotionnel, une page qui n'existe pas (la
 * fiche vit sous « /promo-material ») : rattacher une pièce ne rafraîchissait jamais cette fiche.
 * `CIBLES`, elle, reste une liste LITTÉRALE : c'est sous cette forme que le contrat de l'action lit
 * les valeurs admises (`enumsLocaux`) — un cliquet exige qu'elle reste égale au registre.
 */
const CHEMIN: Partial<Record<EntityType, string>> = Object.fromEntries(
  AD_PRO_KINDS.map((k) => [AD_PRO_ENTITY_TYPE[k.kind], k.href]),
);

export async function rattacherLegalAFiche(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const legalId = fdStr(formData, "legalId");
  const cible = fdStr(formData, "entityType") as EntityType | null;
  const cibleId = fdStr(formData, "entityId");

  if (!legalId || !cible || !cibleId) return { ok: false, error: "Choisissez le document à rattacher." };
  if (!CIBLES.includes(cible)) return { ok: false, error: "Cette nature de fiche ne porte pas de pièces rattachées." };

  const doc = await prisma.legalDocument.findUnique({
    where: { id: legalId },
    select: { id: true, title: true, reference: true, kind: true, sourceType: true, sourceId: true },
  });
  if (!doc) return { ok: false, error: "Document introuvable." };

  // LES DEUX DROITS — lire la pièce, modifier la cible. L'un sans l'autre ouvre une porte.
  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", legalId, "VIEW"))) {
    return { ok: false, error: "Vous n'avez pas accès à ce document." };
  }
  if (!(await canAccessEntity(user, cible, cibleId, "UPDATE"))) {
    return { ok: false, error: "Vous ne pouvez pas modifier cette fiche." };
  }

  // DÉJÀ RATTACHÉ AILLEURS : on le DIT, on ne déplace pas en silence.
  if (doc.sourceId && doc.sourceId !== cibleId) {
    return {
      ok: false,
      error: `« ${doc.title} » est déjà rattaché à une autre fiche. Détachez-le depuis celle-ci `
        + "avant de le rattacher ici — un déplacement silencieux retirerait la pièce d'un dossier "
        + "que quelqu'un d'autre suit.",
    };
  }
  if (doc.sourceId === cibleId) return { ok: true, message: "Ce document est déjà rattaché à cette fiche." };

  await prisma.legalDocument.update({
    where: { id: legalId },
    data: { sourceType: cible, sourceId: cibleId, updatedById: user.id },
  });

  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: legalId,
    summary: `${natureLegale(doc.kind)} « ${doc.title} » rattaché·e à ${cible} ${cibleId}`,
  });

  // UN BC RATTACHÉ À UNE FICHE AD & PRO VIENT D'AD & PRO (§118.148) : s'il attendait encore au
  // centre de validations, il passe au centre Ad & Pro. Une décision déjà prise ne se re-juge
  // pas parce que la pièce a changé de fiche — la règle pure en décide, pas ce geste.
  const bc = doc.kind === "PURCHASE_ORDER" ? await aiguillerBC(legalId, { acteurId: user.id }) : null;
  const sansPorte = bc ? reserveSansPorte(bc) : null;
  // Sous le seuil (§118.149), aucun centre : la phrase dit qu'il part à la signature des Finances,
  // et seulement quand il vient d'y entrer — une réserve répétée à chaque geste cesse d'être lue.
  const versLesFinances = bc?.versLesFinances ? reserveDeLAiguillage(bc) : null;
  const transfert = sansPorte
    ? ` ${sansPorte}`
    : bc?.geste === "TRANSFEREE" || bc?.geste === "POSEE"
      ? ` Le bon de commande attend désormais la validation du ${LIBELLE_CENTRE_BC[bc.porte?.centre ?? "AD_PRO"]}.`
      : versLesFinances ? ` ${versLesFinances}` : "";

  const base = CHEMIN[cible];
  if (base) {
    revalidatePath(base);
    revalidatePath(`${base}/${cibleId}`);
  }
  revalidatePath(`/legal/${legalId}`);
  return { ok: true, message: `« ${doc.title} » est maintenant rattaché·e à cette fiche.${transfert}` };
}

/**
 * DÉTACHER — le geste symétrique, et il est nécessaire.
 *
 * Sans lui, la règle « on ne vole pas un rattachement » serait une impasse : le refus nommerait
 * un geste qui n'existe pas, ce qui est exactement l'impossibilité artificielle qu'on ferme
 * ailleurs (§118.63). Il exige les mêmes deux droits, dans l'autre sens.
 */
export async function detacherLegalDeFiche(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUser();
  const legalId = fdStr(formData, "legalId");
  if (!legalId) return { ok: false, error: "Document non précisé." };

  const doc = await prisma.legalDocument.findUnique({
    where: { id: legalId },
    select: { id: true, title: true, kind: true, sourceType: true, sourceId: true },
  });
  if (!doc) return { ok: false, error: "Document introuvable." };
  if (!doc.sourceId || !doc.sourceType) return { ok: true, message: "Ce document n'est rattaché à aucune fiche." };

  if (!(await canAccessEntity(user, "LEGAL_DOCUMENT", legalId, "UPDATE"))) {
    return { ok: false, error: "Vous ne pouvez pas modifier ce document." };
  }
  if (!(await canAccessEntity(user, doc.sourceType, doc.sourceId, "UPDATE"))) {
    return { ok: false, error: "Vous ne pouvez pas modifier la fiche qui porte ce document." };
  }

  const ancienType = doc.sourceType;
  const ancienId = doc.sourceId;
  await prisma.legalDocument.update({
    where: { id: legalId },
    data: { sourceType: null, sourceId: null, updatedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Legal",
    entityType: "LEGAL_DOCUMENT", entityId: legalId,
    summary: `« ${doc.title} » détaché·e de ${ancienType} ${ancienId}`,
  });
  // Détaché de sa fiche, un BC qui attendait encore retourne au centre de son origine RESTANTE.
  if (doc.kind === "PURCHASE_ORDER") await aiguillerBC(legalId, { acteurId: user.id });
  const base = CHEMIN[ancienType];
  if (base) {
    revalidatePath(base);
    revalidatePath(`${base}/${ancienId}`);
  }
  revalidatePath(`/legal/${legalId}`);
  return { ok: true, message: `« ${doc.title} » est détaché·e.` };
}
