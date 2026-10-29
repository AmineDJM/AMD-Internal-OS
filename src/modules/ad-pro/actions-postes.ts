"use server";

import { deposerLettreDevis } from "@/lib/demande-devis-depot";
import { lienPosteAdPro } from "@/lib/chemins/ad-pro";
import { revalidatePath } from "next/cache";
import type { AdProItemKind, AdProItemBudgetKind } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { reporterLesPostesSurLaDeclaration } from "@/lib/workflow/engine";
import { toNumber } from "@/lib/utils";
import { moneyEntityOf } from "@/lib/company";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { canSubmitItem, canRequestPurchaseOrder, canRemoveItem, budgetKindLocked, ITEM_KINDS, ITEM_KIND_LABELS, PIECE_SECRETARIAT, NATURES_PIECE_SECRETARIAT, peutDemanderPiece, titrePiece, TITRE_BC_A_ETABLIR, type NaturePieceSecretariat, siegeAuCentreAdPro, REFUS_BC_CENTRE_AD_PRO, lireRepartition, ecrireRepartition, VERSEMENT_SANS_BC, LIBELLE_JUSTIFICATIF_DIRECT, nomComplet, porteDesVoyageurs, refusChangementNatureFiches, gesteVisaPoste, memePrestataire, opsFranchiALaSoumission, libelleTemps } from "@/modules/ad-pro/partage";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { refusSiPorteDgFermee, signalerPorteDgSiBesoin, lireLaMarcheDuBC, notificationDuCentreBC, REFUS_MARCHE_PRISE, assistantesDeDirection, demandesBCDesPostes, creerPosteEtFiches, lireFichesDuFormulaire, bcEtablisDuPoste, refusCategoriePourLaDemande } from "@/modules/ad-pro/api";
import { getAppSettings } from "@/lib/settings";
import { motifSousLeSeuil } from "@/lib/bons-de-commande/regle";
import { signalerSiASigner } from "@/lib/bons-de-commande/etat";
import { CHEMIN_BC_A_SIGNER } from "@/lib/bons-de-commande/aiguillage";
import { faitDeStock, refusArgentSurPosteStock, refusChangementNature } from "@/lib/promo/reservations";
import { Prisma } from "@prisma/client";
import { ecrireDansLeSujet } from "@/lib/dossiers-core";
import { annulerOrdreNonRegle } from "@/modules/finances/api";
import { prevenirLeSecretariat } from "@/lib/secretariat/annulation";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { apercuSuppression } from "@/lib/admin-delete-registry";
import { sansBloquer } from "@/lib/journal";
import { PARENTS, isParent, revalidate, canEditItems, canAllocate, valideursDuPoste, demandeurDe, peutTrancherSur, prevenirLeTemps, audit, refusSiClos, refusDemandeFermee, refusAvantPrevalidation, refusPostesClos, reprojeterMontantDemande, demandeVisible, loadItem, REFUS_HISTORIQUE, compterFichesPersonnes, priseEnChargeIndirecte, etatBcDe, appliquerGesteVisa, cloreDemandesAuBureau, resumeRepartition, postesRepartis, recordDecision, piecesOuvertes, envoyerDemandeBC, pieceComptee, depassementDuPoste } from "./infra/postes/commun";

/**
 * POSTES D'UNE DEMANDE AD & PRO — le poste et ses demandes : ajouter, modifier, retirer, rattacher un matériel
 * promotionnel, soumettre, choisir son budget ; demander un devis ou une facture au secrétariat, demander le BC
 * (assistante → centre) et le viser — ce que le demandeur et le centre font d'un poste, et ce qu'Adam appelle.
 *
 * Clé historique `ad-pro-item-actions` (`src/lib/actions/parc.ts`), portée avec ses morceaux :
 * `actions-postes-decision` (répartir, décider, corriger le BC), `actions-postes-paiement` (devis, paiement,
 * facture, BC signé), `actions-postes-materiel` (matériel du stock), `actions-postes-voyageurs` (billetterie,
 * hôtellerie), `actions-postes-lignes` (lignes des devis, BC généré, aperçu). Le socle commun (table `PARENTS`,
 * chargement d'un poste, refus) : `infra/postes/commun.ts`. Le BC de la billetterie vit ici parce qu'il passe
 * son formulaire à `requestAdProItemOrder`.
 */

// ───────────────────────────── Ajouter / modifier / retirer ─────────────────────────────

export async function addAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const parentRaw = fdStr(formData, "parent") ?? "";
  if (!isParent(parentRaw)) return { ok: false, error: "Opération inconnue." };
  const parentId = fdStr(formData, "parentId");
  const label = fdStr(formData, "label");
  if (!parentId || !label) return { ok: false, error: "Le libellé du poste est obligatoire." };
  if (!canEditItems(user, parentRaw)) return { ok: false, error: "Non autorisé." };

  const info = await PARENTS[parentRaw].load(parentId);
  // Hors de la portée de la personne, la demande est introuvable — la même phrase que l'absence.
  if (!info || !(await demandeVisible(user, parentRaw, parentId))) return { ok: false, error: "Opération introuvable." };
  const clos = refusPostesClos(info);
  if (clos) return { ok: false, error: clos };
  // AUCUN POSTE AVANT LA PRÉVALIDATION (Direction, 27/10/2026 — décision #11) : « tant qu'on n'a pas la
  // prévalidation de la Direction Marketing, aucun budget ne peut être ouvert, rien ».
  const avant = refusAvantPrevalidation(info);
  if (avant) return { ok: false, error: avant };

  const kind = (fdStr(formData, "kind") ?? "OTHER") as AdProItemKind;
  if (!(kind in ITEM_KIND_LABELS)) return { ok: false, error: "Nature de poste inconnue." };

  const amountEstimated = fdNum(formData, "amountEstimated");
  if (amountEstimated != null && amountEstimated < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  // UN POSTE « MATÉRIEL DU STOCK » NE PORTE PAS DE MONTANT (§118.167) : son matériel sort du
  // magasin, il ne s'achète pas. Un montant saisi y serait additionné au montant de la demande.
  const sansMontant = amountEstimated != null && amountEstimated > 0 ? refusArgentSurPosteStock(kind, "un montant") : null;
  if (sansMontant) return { ok: false, error: sansMontant };
  // « Ce poste est-il DANS le budget accordé, ou EN PLUS ? » — question posée dès l'ajout : sans
  // elle, une rallonge assumée serait lue comme un dépassement subi.
  const budgetKind = (fdStr(formData, "budgetKind") === "ADDITIONAL" ? "ADDITIONAL" : "INCLUDED") as AdProItemBudgetKind;

  // UN SPONSORING INDIRECT NAÎT RÉPARTI PAR NATURE (§118.175) — « 1 000 000 DZD répartis en
  // 400 000 d'imprimerie et 600 000 d'hôtellerie ». Il ne devient pas UN poste « sponsoring
  // indirect » qu'on ne pourrait payer qu'à un seul fournisseur : chaque nature devient un poste,
  // avec sa chaîne, et `repartitionId` les relie. Sans répartition, le refus nomme ce qui manque.
  if (kind === "INDIRECT_SUPPORT") {
    const lue = lireRepartition(fdStr(formData, "repartition"));
    if (!lue.ok) return { ok: false, error: lue.error };
    try {
      const ids = await prisma.$transaction((tx) => ecrireRepartition(tx, {
        rattachement: { [PARENTS[parentRaw].column]: parentId }, lignes: postesRepartis(lue.lignes), premierId: null, userId: user.id,
        base: { label, notes: fdStr(formData, "notes"), budgetKind, addedAfterDecision: info.tardif },
      }));
      await audit(user, parentRaw, parentId, "CREATE",
        `Sponsoring indirect « ${label} » réparti en ${lue.lignes.length} poste(s) — ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD${info.tardif ? " — APRÈS la décision définitive" : ""}.`);
      await signalerPorteDgSiBesoin(parentRaw, parentId);
      revalidate(parentRaw, parentId);
      return { ok: true, id: ids[0], message: `Sponsoring indirect réparti en ${lue.lignes.length} poste(s) : ${resumeRepartition(lue.lignes)} — total ${lue.total.toLocaleString("fr-FR")} DZD.` };
    } catch (err) {
      console.error("[ad-pro-item] répartition impossible", err);
      return { ok: false, error: "La répartition n'a pas pu être enregistrée : aucun poste n'a été créé. Réessayez dans un instant." };
    }
  }

  // LES FICHES SAISIES AVEC LE POSTE (Direction, 10/2026) — billetterie : ses voyageurs ; hôtellerie : ses
  // personnes logées. Toutes lues (et leurs pièces contrôlées) AVANT d'écrire : une fiche refusée, aucun poste.
  const fichesLues = await lireFichesDuFormulaire(formData, kind);
  if (!fichesLues.ok) return { ok: false, error: fichesLues.error };
  const fiches = fichesLues.fiches;

  try {
    // Un poste ajouté APRÈS la décision est autorisé — c'est le choix retenu — mais il est
    // marqué. C'est ce marqueur qui expliquera un dépassement d'enveloppe à l'écran, au lieu
    // de laisser croire à une erreur de saisie.
    const late = info.tardif;
    const where = { [PARENTS[parentRaw].column]: parentId } as Record<string, string>;
    const last = await prisma.adProItem.findFirst({ where, orderBy: { position: "desc" }, select: { position: true } });

    const data = {
      ...where,
      kind,
      label,
      notes: fdStr(formData, "notes"),
      supplier: fdStr(formData, "supplier"),
      amountEstimated: kind === "STOCK_MATERIAL" ? null : amountEstimated ?? null,
      budgetKind,
      addedAfterDecision: late,
      position: (last?.position ?? 0) + 1,
      createdById: user.id,
      updatedById: user.id,
    } as Prisma.AdProItemUncheckedCreateInput;
    let detailFiches = "";
    let created: { id: string };
    if (fiches.length > 0) {
      // LE POSTE ET SES FICHES ENSEMBLE — rien de partiel : un échec défait tout (`creerPosteEtFiches`).
      const r = await creerPosteEtFiches(data, fiches, user.id);
      if (!r.ok) return { ok: false, error: r.error };
      created = { id: r.itemId };
      const quoi = porteDesVoyageurs(kind) ? "voyageur" : "fiche hôtellerie";
      detailFiches = ` — ${fiches.length} ${quoi}${fiches.length > 1 ? "s" : ""}${r.pieces > 0 ? `, ${r.pieces} document${r.pieces > 1 ? "s" : ""} joint${r.pieces > 1 ? "s" : ""}` : ""}`;
    } else {
      created = await prisma.adProItem.create({ data, select: { id: true } });
    }

    await audit(user, parentRaw, parentId, "CREATE",
      `Poste ajouté — ${ITEM_KIND_LABELS[kind]} « ${label} » (${budgetKind === "ADDITIONAL" ? "budget supplémentaire" : "inclus dans le budget accordé"})${late ? " — APRÈS la décision définitive" : ""}${detailFiches}.`);
    // UN POSTE HORS BUDGET OU APRÈS LA DÉCISION SE DIT, EN LECTURE, À CEUX QUI DÉCIDENT (§118.200) :
    // il n'est pas encore à valider (la validation partira à sa soumission), mais il change ce que
    // la demande coûtera. Le dire seulement là : un poste inclus avant la décision est le détail
    // ordinaire du besoin, et une notification par ligne serait du bruit qu'on cesse de lire.
    if (budgetKind === "ADDITIONAL" || late) {
      await notifyRoles(valideursDuPoste(parentRaw), {
        type: "GENERIC",
        title: budgetKind === "ADDITIONAL" ? "Poste hors budget ajouté" : "Poste ajouté après la décision",
        body: `${info.ref} — ${ITEM_KIND_LABELS[kind]} « ${label} »${amountEstimated != null ? ` (${amountEstimated.toLocaleString("fr-FR")} DZD)` : ""} — pour information ; la validation vous parviendra à sa soumission.`,
        link: lienPosteAdPro(parentRaw, parentId, created.id),
      }).catch(sansBloquer("ad-pro-item-actions.addAdProItem.notifyRoles"));
    }
    // Le poste ajouté change l'estimation que porte la déclaration d'information médicale (§118.191).
    await reporterLesPostesSurLaDeclaration(parentRaw, parentId)
      .catch((err) => console.error("[ad-pro] montant de la déclaration non reporté (non bloquant)", err));
    // UN POSTE AJOUTÉ CHANGE LE TOTAL (27/10/2026) : s'il franchit le seuil — ou dépasse ce que le DG a
    // validé —, la porte se ferme ; le DG est prévenu de ce nouveau total, comme pour tout changement de montant.
    await signalerPorteDgSiBesoin(parentRaw, parentId);
    revalidate(parentRaw, parentId);
    return { ok: true, id: created.id, ...(detailFiches ? { message: `Poste ajouté${detailFiches}.` } : {}) };
  } catch (err) {
    console.error("[ad-pro-item] création impossible", err);
    return { ok: false, error: "Le poste n'a pas pu être ajouté. Réessayez dans un instant." };
  }
}

export async function updateAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };

  // Le montant affecté engage l'argent : il ne se modifie pas avec les mêmes droits que le libellé.
  const wantsAllocate = formData.get("amountGranted") !== null;
  // LE MONTANT ACCORDÉ se fixe au second temps de la validation (§118.204) : par qui le tient.
  if (wantsAllocate && !(await peutTrancherSur(user, owner)).marketing) {
    return { ok: false, error: "Le montant accordé se fixe par la Direction Marketing, qui valide le poste et choisit son budget." };
  }
  // Une pièce comptable a été émise sur ce montant : le changer en silence ferait diverger
  // l'opération et l'ordre de dépense. On refuse plutôt que de créer un écart invisible.
  if (wantsAllocate && item.expenseOrderId) {
    return { ok: false, error: "Un ordre de dépense a déjà été émis sur ce poste : son montant ne peut plus changer." };
  }

  const amountGranted = wantsAllocate ? fdNum(formData, "amountGranted") : undefined;
  if (amountGranted != null && amountGranted < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };
  const amountEstimated = fdNum(formData, "amountEstimated");
  if (amountEstimated != null && amountEstimated < 0) return { ok: false, error: "Un montant ne peut pas être négatif." };

  const label = fdStr(formData, "label");

  // LE BON DE COMMANDE EN COURS (§118.187). Retirer le montant d'un poste dont le BC est demandé ou
  // visé laisserait une demande sans chiffre au centre ou aux Finances : le refus nomme le geste qui
  // le précède. Et un prestataire ne change pas sous un ordre déjà émis à l'ancien : l'ordre s'annule
  // d'abord, puis se réémet — sinon l'ordre et le poste diraient deux bénéficiaires.
  const bcEnCours = item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK";
  if (wantsAllocate && amountGranted == null && bcEnCours) {
    return { ok: false, error: "Une demande de bon de commande est en cours sur ce montant : retirez-la d'abord (« Annuler la demande de BC »), puis retirez le montant." };
  }
  const nouveauFournisseur = formData.has("supplier") ? fdStr(formData, "supplier") : item.supplier;
  if (item.expenseOrderId && !memePrestataire(nouveauFournisseur, item.supplier)) {
    return { ok: false, error: "Un ordre de dépense a déjà été émis pour ce poste : pour changer de prestataire, annulez d'abord l'ordre (« Annuler l'ordre émis »), puis réémettez-le." };
  }

  // CLÔTURÉE : ce qui DÉCRIT la dépense (libellé, précisions, fournisseur) se corrige encore — le
  // fournisseur sert au BC qui peut rester à émettre. Ce qui la CHIFFRE ou la QUALIFIE non : la
  // clôture a arrêté ces valeurs, et le total de la demande en est la somme.
  if (wantsAllocate || formData.has("amountEstimated") || fdStr(formData, "kind") || fdStr(formData, "budgetKind")) {
    const clos = await refusSiClos(owner.parent, owner.id);
    if (clos) return { ok: false, error: clos };
  }

  // NATURE et NATURE DE BUDGET — modifiables aussi, mais pas n'importe quand.
  // La nature (stand, prestation…) décrit la dépense : elle se corrige à tout moment.
  // La nature de BUDGET (inclus / rallonge) est ce sur quoi la Direction s'est prononcée :
  // une fois tranchée, la changer réécrirait sa décision.
  const kindRaw = fdStr(formData, "kind");
  const kind = kindRaw && (ITEM_KINDS as readonly string[]).includes(kindRaw) ? (kindRaw as AdProItemKind) : null;
  const budgetKindRaw = fdStr(formData, "budgetKind");
  const budgetKind = budgetKindRaw === "INCLUDED" || budgetKindRaw === "ADDITIONAL" ? budgetKindRaw : null;
  const budgetDecided = budgetKindLocked(item);

  // LA NATURE « MATÉRIEL DU STOCK » ne se gagne ni ne se perd hors d'un brouillon vierge
  // (§118.167) : elle change ce que le poste EST, pas seulement ce qu'il décrit.
  if (kind && kind !== item.kind) {
    const refus = refusChangementNature(item.kind, kind, {
      statut: item.status,
      lignesStock: await prisma.adProStockLine.count({ where: { itemId: id } }),
      argentEngage: item.amountEstimated != null || item.amountGranted != null || item.budgetCategoryId != null
        || item.expenseOrderId != null || item.orderStage !== "NONE" || item.adminRequestId != null || item.promoMaterialId != null,
    });
    if (refus) return { ok: false, error: refus };
    // LES FICHES PAR PERSONNE (Direction, 06/10) : une billetterie qui a des voyageurs, une hôtellerie
    // qui a des fiches ne changent pas de nature — les fiches deviendraient invisibles, sans être perdues.
    const [voyageurs, hebergements] = await Promise.all([
      prisma.adProVoyageur.count({ where: { itemId: id } }),
      prisma.adProHebergement.count({ where: { itemId: id } }),
    ]);
    const refusFiches = refusChangementNatureFiches(item.kind, kind, { voyageurs, hebergements });
    if (refusFiches) return { ok: false, error: refusFiches };
  }
  if ((wantsAllocate && amountGranted != null && amountGranted > 0) || (amountEstimated != null && amountEstimated > 0)) {
    const refus = refusArgentSurPosteStock(kind ?? item.kind, "un montant");
    if (refus) return { ok: false, error: refus };
  }

  try {
    await prisma.adProItem.update({
      where: { id },
      data: {
        ...(label ? { label } : {}),
        ...(kind ? { kind } : {}),
        ...(budgetKind && !budgetDecided ? { budgetKind } : {}),
        ...(formData.has("notes") ? { notes: fdStr(formData, "notes") } : {}),
        ...(formData.has("supplier") ? { supplier: fdStr(formData, "supplier") } : {}),
        ...(formData.has("amountEstimated") ? { amountEstimated: amountEstimated ?? null } : {}),
        ...(wantsAllocate ? { amountGranted: amountGranted ?? null } : {}),
        updatedById: user.id,
      },
    });
    await audit(user, owner.parent, owner.id, "UPDATE",
      wantsAllocate
        ? `Poste « ${label ?? item.label} » — montant affecté : ${amountGranted != null ? `${amountGranted.toLocaleString("fr-FR")} DZD` : "retiré"}.`
        : `Poste « ${label ?? item.label} » modifié.`);
    // MÊME PORTE QUE LA DÉCISION : le montant d'une rallonge accordée se corrige aussi ici, et
    // sa nature de budget peut encore changer tant qu'elle n'est pas tranchée. Laisser cette
    // porte-là sans reprojection, c'est la porte ouverte à côté de la porte gardée (§118.71).
    await reprojeterMontantDemande(owner.parent, owner.id);
    // LE VISA NE COUVRE QUE CE QU'IL A VU (§118.187, audit R05) : un montant relevé ou un prestataire
    // changé après le visa le rouvre ; un BC en attente que le montant fait passer sous le seuil part
    // aux Finances.
    let phraseVisa: string | null = null;
    if (bcEnCours) {
      const apres = {
        montant: wantsAllocate ? (amountGranted ?? null) : (item.amountGranted != null ? toNumber(item.amountGranted) : null),
        fournisseur: nouveauFournisseur,
      };
      const geste = gesteVisaPoste(etatBcDe(item), apres, (await getAppSettings()).bcValidationThreshold);
      if (geste.geste !== "RIEN") {
        const info = await PARENTS[owner.parent].load(owner.id);
        phraseVisa = await appliquerGesteVisa(item, geste, apres, { user, owner, ref: info?.ref ?? null });
      }
    }
    revalidate(owner.parent, owner.id);
    return phraseVisa ? { ok: true, id, message: `Poste modifié. ${phraseVisa}` } : { ok: true, id };
  } catch (err) {
    console.error("[ad-pro-item] mise à jour impossible", err);
    return { ok: false, error: "Le poste n'a pas pu être modifié." };
  }
}

export async function deleteAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  // LE MATÉRIEL DU STOCK (§118.167) : réservé, il est dehors et effacer le poste l'y laisserait ;
  // remis, abîmé ou perdu, le poste est la cause de ces sorties. La MÊME règle que la corbeille
  // (`faitDeStock`) — sinon une demande qu'elle refuse se viderait poste par poste (§118.71).
  const faitStock = (await prisma.adProStockLine.findMany({
    where: { itemId: id }, select: { statut: true, utilisee: true, abimee: true, perdue: true },
  })).map((l) => faitDeStock(l)).find((f) => f != null);
  if (faitStock) return { ok: false, error: `Ce poste ne se retire pas : ${faitStock}.` };

  // UN POSTE PAYÉ NE S'EFFACE PAS EN SILENCE — mais il doit pouvoir être retiré.
  //
  // Le refus pur et simple créait une impasse : un poste émis par erreur (mauvais fournisseur,
  // doublon) restait à l'écran pour toujours. On garde donc la protection pour les éditeurs
  // ordinaires, et on l'ouvre à la DIRECTION — celle qui a signé l'ordre est celle qui peut le
  // défaire. L'ordre de dépense est alors ANNULÉ, pas orphelin : la trace comptable subsiste,
  // marquée annulée, au lieu de pointer vers un poste disparu.
  const order = item.expenseOrderId
    ? await prisma.expenseOrder.findUnique({ where: { id: item.expenseOrderId }, select: { status: true, reference: true } })
    : null;
  const removable = canRemoveItem(
    { expenseOrderId: item.expenseOrderId, expenseOrderStatus: order?.status ?? null },
    { canAllocate: canAllocate(user, owner.parent) },
  );
  if (!removable.ok) return { ok: false, error: removable.reason ?? "Ce poste ne peut pas être retiré." };
  // CE QUE LA CORBEILLE REFUSERAIT, lu AVANT d'annuler quoi que ce soit — une pièce signée par les
  // Finances, le paiement réglé d'une demande au secrétariat : sans cette lecture, l'ordre serait
  // annulé pour rien, et le poste resterait là (§118.53 : on lit l'empreinte avant d'écrire).
  const apercu = await apercuSuppression("AD_PRO_ITEM", id);
  if (apercu.refus) return { ok: false, error: apercu.refus };
  // Les demandes au secrétariat ENCORE OUVERTES partent avec le poste (le lot les emporte, et les rend
  // à la restauration) : l'assistante qui y travaillait doit l'apprendre — elle disparaît de sa liste.
  const ouvertes = await prisma.administrativeRequest.findMany({
    where: { linkedEntityType: "AD_PRO_ITEM", linkedEntityId: id, deletedAt: null, status: { notIn: ["DONE", "CANCELLED"] } },
    select: { reference: true, title: true, assignedToId: true },
  });
  // Et les demandes de PIÈCE ouvertes chez l'assistante (le BC à déposer, §118.204) : elle doit
  // l'apprendre aussi, sinon elle dépose un BC pour un poste qui n'existe plus.
  const piecesOuvertes = await prisma.documentRequest.findMany({
    where: { entityType: "AD_PRO_ITEM", entityId: id, status: { in: ["PENDING", "SUBMITTED", "DECLINED"] } },
    select: { id: true, reference: true, label: true, askedToId: true },
  });

  // 1) L'ORDRE ÉMIS S'ANNULE PAR L'ÉCRIVAIN COMMUN (§118.185) — conditionnel : un règlement survenu
  //    entre la lecture et l'annulation ne se défait pas, et le poste reste alors (il justifie un
  //    paiement réellement sorti). L'écriture d'avant était un `update` sec, qui pouvait marquer
  //    « annulé » un ordre que le centre venait de payer.
  let ordreAnnule: string | null = null;
  if (item.expenseOrderId) {
    const a = await annulerOrdreNonRegle(item.expenseOrderId, { acteurId: user.id, motif: `le poste « ${item.label} » a été retiré` });
    if (!a.ok) return { ok: false, error: a.error };
    ordreAnnule = a.reference;
    // Le poste QUITTE l'ordre annulé avant de partir à la corbeille, comme « Annuler l'ordre émis » :
    // restauré, il pointerait sinon vers un ordre annulé, « émis » pour toujours et impossible à réémettre.
    await prisma.adProItem.updateMany({
      where: { id, expenseOrderId: item.expenseOrderId },
      data: { expenseOrderId: null, orderStage: item.orderRequestedAt ? "DIRECTION_OK" : "NONE", updatedById: user.id },
    });
  }

  // 2) LE POSTE PART À LA CORBEILLE, EN LOT (§118.187, audit R11) — avec ses décisions, ses voyageurs,
  //    ses pièces, ses demandes au secrétariat et le BC non signé qu'elles ont fait naître, et il revient
  //    avec eux. « Retirer le poste » l'effaçait définitivement, et l'historique des décisions partait
  //    en cascade. Le matériel promotionnel rattaché n'est PAS supprimé : il a sa vie propre et son circuit.
  // LE RACCOURCI VERS LA DEMANDE DE DEVIS (`adminRequestId`) désigne une demande que le lot EMPORTE
  // comme branche du poste (son `linkedEntityId`) : la tête dépendrait de sa propre branche, et la
  // corbeille refusait (« ordre de recréation impossible »). Le raccourci est redondant avec le lien
  // canonique de la demande : on le vide avant le lot, et on le repose si le retrait échoue. Restauré,
  // le poste retrouve sa demande par le lien canonique.
  const raccourci = item.adminRequestId;
  if (raccourci) await prisma.adProItem.update({ where: { id }, data: { adminRequestId: null } });
  const r = await supprimerReversible("AD_PRO_ITEM", id, user.id,
    `Poste « ${item.label} » retiré${item.promoMaterialId ? " (le matériel promotionnel rattaché est conservé)" : ""}.`);
  if (!r.ok && raccourci) await prisma.adProItem.updateMany({ where: { id }, data: { adminRequestId: raccourci } }).catch(sansBloquer("ad-pro-item-actions.deleteAdProItem.adProItem"));
  if (!r.ok) {
    return {
      ok: false,
      error: ordreAnnule
        ? `L'ordre ${ordreAnnule} a été annulé, mais le poste n'a pas pu être retiré : ${r.error ?? "erreur inconnue"}`
        : (r.error ?? "Le poste n'a pas pu être retiré."),
    };
  }
  await audit(user, owner.parent, owner.id, "DELETE",
    `Poste « ${item.label} » retiré (restaurable depuis la corbeille)${ordreAnnule ? ` — ordre de dépense ${ordreAnnule} annulé` : ""}${item.promoMaterialId ? " — le matériel promotionnel rattaché est conservé" : ""}.`);

  // 3) CE QUI TRAVAILLAIT POUR LUI (audit R10) : ses demandes au secrétariat sont parties AVEC lui —
  //    leur assistante l'apprend (la demande disparaît de sa liste, elle reviendrait avec le poste) —
  //    et le sujet de réservation d'une billetterie l'apprend aussi : l'assistante ne réserve plus des
  //    billets pour un poste qui n'existe plus. Les clore d'abord ferait revenir un poste dont la
  //    demande de BC vit encore, avec un « BC à établir » annulé (§118.141c) : le lot les garde telles
  //    qu'elles étaient.
  for (const d of ouvertes) {
    await prevenirLeSecretariat(d.assignedToId, {
      type: "GENERIC", title: "Demande au secrétariat retirée avec son poste",
      body: `${d.reference} — ${d.title} : le poste « ${item.label} » a été retiré (restaurable depuis la corbeille).`, link: "/demandes",
    }, user.id);
  }
  if (ouvertes.length > 0) revalidatePath("/demandes");
  for (const d of piecesOuvertes) {
    await notifyUser({
      userId: d.askedToId, type: "GENERIC", title: "Demande de pièce retirée avec son poste",
      body: `${d.reference} — ${d.label} : le poste « ${item.label} » a été retiré (restaurable depuis la corbeille).`, link: "/pieces",
    }).catch(sansBloquer("ad-pro-item-actions.deleteAdProItem.notifyUser"));
  }
  if (piecesOuvertes.length > 0) revalidatePath("/pieces");
  if (item.reservationDossierId) {
    await ecrireDansLeSujet({ dossierId: item.reservationDossierId, authorId: user.id, body: `${item.label} — poste retiré : la réservation n'a plus d'objet.` }).catch(sansBloquer("ad-pro-item-actions.deleteAdProItem.ecrireDansLeSujet", false));
  }
  // Une rallonge accordée qu'on retire doit QUITTER le montant de la demande : sinon la fiche
  // porterait pour toujours un budget accordé à un poste qui n'existe plus.
  await reprojeterMontantDemande(owner.parent, owner.id);
  revalidate(owner.parent, owner.id);
  return {
    ok: true,
    message: `Poste retiré — restaurable depuis la corbeille${ordreAnnule ? ` ; l'ordre ${ordreAnnule} est annulé` : ""}.`
      + (ouvertes.length > 0 ? ` ${ouvertes.length} demande${ouvertes.length > 1 ? "s" : ""} au secrétariat ${ouvertes.length > 1 ? "sont parties" : "est partie"} avec lui, l'assistante prévenue.` : ""),
  };
}

// ───────────────────────────── Matériel promotionnel ─────────────────────────────

/**
 * Rattache un matériel promotionnel EXISTANT à un poste.
 *
 * On ne recopie jamais son état ici : le matériel suit son propre circuit et l'opération en lit
 * l'avancement. Deux vérités sur le même objet finiraient toujours par diverger.
 */
export async function linkPromoMaterial(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();

  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  // Rattacher un dossier d'ACHAT ferait de ce poste un poste « Matériel promotionnel » (la nature
  // change ci-dessous) — et laisserait ses lignes de stock à une nature qui ne sait plus les rendre.
  const refusStock = refusArgentSurPosteStock(item.kind, "un dossier d'achat de matériel promotionnel");
  if (refusStock) return { ok: false, error: refusStock };

  const promoMaterialId = fdStr(formData, "promoMaterialId");
  if (promoMaterialId) {
    const pm = await prisma.promoMaterial.findUnique({ where: { id: promoMaterialId }, select: { reference: true } });
    if (!pm) return { ok: false, error: "Matériel promotionnel introuvable." };
    await prisma.adProItem.update({ where: { id }, data: { promoMaterialId, kind: "PROMO_MATERIAL", updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » rattaché au matériel ${pm.reference}.`);
  } else {
    await prisma.adProItem.update({ where: { id }, data: { promoMaterialId: null, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » détaché de son matériel promotionnel.`);
  }

  revalidate(owner.parent, owner.id);
  return { ok: true, id };
}

/** Les matériels promotionnels rattachables — pour le sélecteur, sans exposer tout le module. */
export async function promoMaterialOptions(): Promise<{ id: string; reference: string; title: string; status: string }[]> {
  const user = await requireUser();
  if (!canEditItems(user, "SPONSORING") && !canEditItems(user, "CONGRESS_NATIONAL")) return [];
  const rows = await prisma.promoMaterial.findMany({
    where: { status: { not: "CANCELLED" } },
    orderBy: { createdAt: "desc" },
    take: 60,
    select: { id: true, reference: true, title: true, status: true },
  });
  return rows.map((r) => ({ ...r, status: String(r.status) }));
}

/**
 * SOUMET un poste à la Direction. Le demandeur décrit, chiffre, joint ses devis, puis envoie —
 * poste par poste. Un poste en « budget à revoir » se resoumet autant de fois qu'il le faut.
 */
export async function submitAdProItem(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const clos = await refusSiClos(owner.parent, owner.id, { partir: true });
  if (clos) return { ok: false, error: clos };

  const info = await PARENTS[owner.parent].load(owner.id);
  const avant = info ? refusAvantPrevalidation(info) : null;
  if (avant) return { ok: false, error: avant };
  const check = canSubmitItem({
    status: item.status,
    amountEstimated: item.amountEstimated != null ? toNumber(item.amountEstimated) : null,
    amountGranted: item.amountGranted != null ? toNumber(item.amountGranted) : null,
    kind: item.kind,
    lignesStock: item.kind === "STOCK_MATERIAL" ? await prisma.adProStockLine.count({ where: { itemId: id } }) : 0,
    // UNE FICHE PAR PERSONNE (Direction, 06/10) — facultative dans un sponsoring indirect.
    fichesPersonnes: await compterFichesPersonnes(item),
    priseEnChargeIndirecte: priseEnChargeIndirecte(item, info),
  });
  if (!check.ok) return { ok: false, error: check.reason ?? "Soumission impossible." };

  const note = fdStr(formData, "note");
  const amount = item.amountGranted ?? item.amountEstimated;
  const corps = `${info?.ref ?? "Opération"} — ${ITEM_KIND_LABELS[item.kind]} « ${item.label} »${amount != null ? ` (${toNumber(amount).toLocaleString("fr-FR")} DZD)` : ""}`;
  const lien = lienPosteAdPro(owner.parent, owner.id, item.id);

  // LE MATÉRIEL DU STOCK garde sa décision UNIQUE (§118.167) : il n'engage pas d'argent.
  if (item.kind === "STOCK_MATERIAL") {
    await prisma.adProItem.update({
      where: { id },
      data: { status: "PENDING", submittedAt: new Date(), decisionNote: null, updatedById: user.id },
    });
    await recordDecision(id, "PENDING", note, amount != null ? toNumber(amount) : null, user.id);
    await notifyRoles(valideursDuPoste(owner.parent), { type: "VALIDATION_REQUIRED", title: "Poste à valider", body: corps, link: lien }).catch(sansBloquer("ad-pro-item-actions.submitAdProItem.notifyRoles"));
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » soumis à la Direction.`);
    revalidate(owner.parent, owner.id);
    return { ok: true, id };
  }

  // UN SEUL ACCORD, CELUI DE LA DIRECTION MARKETING (27/10/2026). Le Directeur des opérations a déjà
  // validé la DEMANDE avant sa prévalidation : son ancien « premier temps » est franchi d'office à la
  // soumission, et la trace le dit.
  const demandeur = await demandeurDe(info?.requesterId);
  const opsDOffice = opsFranchiALaSoumission(demandeur);
  const maintenant = new Date();
  await prisma.adProItem.update({
    where: { id },
    data: {
      status: "PENDING", submittedAt: maintenant, decisionNote: null, updatedById: user.id,
      opsDecidedAt: opsDOffice ? maintenant : null,
      opsDecidedById: null,
      opsDecisionNote: opsDOffice ? "Demande prévalidée (N+1, Directeur des opérations, Direction Marketing) : la Direction Marketing accepte le poste." : null,
    },
  });
  await recordDecision(id, "PENDING", note, amount != null ? toNumber(amount) : null, user.id);
  const temps = opsDOffice ? "MARKETING" as const : "OPERATIONS" as const;
  await prevenirLeTemps(temps, demandeur, "Poste à valider", corps, lien);
  await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » soumis — en attente de ${libelleTemps(temps, demandeur)}.`);
  revalidate(owner.parent, owner.id);
  return { ok: true, id, message: `Poste soumis — en attente de ${libelleTemps(temps, demandeur)}.` };
}

/** Choix du BUDGET qui portera un poste accordé (catégorie d'enveloppe) — « comme d'habitude ». */
export async function setAdProItemBudget(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  const refusStock = refusArgentSurPosteStock(item.kind, "un budget");
  // La NATURE d'abord : un poste du stock n'a jamais de budget, quel que soit qui le demande.
  if (refusStock) return { ok: false, error: refusStock };
  // LE BUDGET EST CHOISI PAR QUI TIENT LE SECOND TEMPS (§118.204) — la Direction Marketing, ou la
  // Direction des opérations quand la demande vient de la Direction Marketing.
  const droits = await peutTrancherSur(user, owner);
  if (!droits.marketing) return { ok: false, error: `Le budget d'un poste se choisit par ${libelleTemps("MARKETING", droits.demandeur)}.` };
  if (refusStock) return { ok: false, error: refusStock };
  const clos = await refusSiClos(owner.parent, owner.id);
  if (clos) return { ok: false, error: clos };
  if (item.status !== "APPROVED") return { ok: false, error: "Le poste doit d'abord être accordé." };

  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  if (budgetCategoryId) {
    const cat = await prisma.budgetCategoryLine.findUnique({
      where: { id: budgetCategoryId },
      select: { name: true, envelope: { select: { name: true } } },
    });
    if (!cat) return { ok: false, error: "Catégorie budgétaire introuvable." };
    const refusCat = await refusCategoriePourLaDemande(budgetCategoryId, owner.parent, owner.id);
    if (refusCat) return { ok: false, error: refusCat };
    await prisma.adProItem.update({ where: { id }, data: { budgetCategoryId, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » imputé au budget ${cat.envelope.name} › ${cat.name}.`);
  } else {
    await prisma.adProItem.update({ where: { id }, data: { budgetCategoryId: null, updatedById: user.id } });
    await audit(user, owner.parent, owner.id, "UPDATE", `Poste « ${item.label} » : imputation budgétaire retirée.`);
  }
  revalidate(owner.parent, owner.id);
  return { ok: true, id };
}

/** Référence d'une demande administrative — même forme que le module (DEM-année-n). */
async function nextAdminRequestRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "AdministrativeRequest", prefixe: "DEM", annee: year,
    existantes: async () => (await prisma.administrativeRequest.findMany({ where: { reference: { startsWith: `DEM-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

/**
 * DEMANDER UNE PIÈCE COMMERCIALE AU BUREAU DU SECRÉTARIAT — un seul écrivain, deux natures.
 *
 * « On peut demander un devis pas que un BC […] après le BC, une facture. » Le devis et la
 * facture sont la MÊME démarche — une demande au secrétariat, avec un message qui porte le
 * contenu et les références — et ce message est ce que le dirigeant a nommé le premier. Le
 * bon de commande, lui, garde son circuit : il ENGAGE, donc il porte un visa (§118.5).
 *
 * Le rattachement se fait par le lien CANONIQUE (`linkedEntityType` / `linkedEntityId`), pas par
 * une colonne dédiée : c'est lui que l'écran des demandes lit déjà pour savoir qu'une dépense
 * vient d'Ad & Pro et ne doit PAS être imputée une seconde fois au budget d'un département.
 * Mesuré : la demande de devis d'un poste ne le posait pas, donc l'assistante pouvait imputer
 * chez elle une dépense que l'enveloppe de l'opération porte déjà — un double comptage sans
 * aucune erreur visible.
 */
export async function demanderPieceSecretariat(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const brut = fdStr(formData, "nature") ?? "DEVIS";
  const nature = (NATURES_PIECE_SECRETARIAT as string[]).includes(brut)
    ? (brut as NaturePieceSecretariat)
    : null;
  if (!id) return { ok: false, error: "Poste non précisé." };
  if (!nature) return { ok: false, error: `Nature de pièce inconnue : ${brut}. Attendu : ${NATURES_PIECE_SECRETARIAT.join(", ")}.` };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un devis, un bon de commande ou une facture");
  if (refusStock) return { ok: false, error: refusStock };

  const garde = peutDemanderPiece(nature, {
    ouvertes: await piecesOuvertes(id),
    bcDemande: item.orderStage !== "NONE",
  });
  if (!garde.ok) return { ok: false, error: garde.raison };

  const info = await PARENTS[owner.parent].load(owner.id);
  if (!info) return { ok: false, error: "Opération introuvable." };
  const spec = PIECE_SECRETARIAT[nature];
  // LE MESSAGE DE LA PERSONNE EN TÊTE : c'est ce qu'elle a écrit, et ce que l'assistante lit en
  // premier. Les rappels du moteur (prestataire, enveloppe) viennent après, jamais à sa place.
  const note = fdStr(formData, "note");

  try {
    // La série DEM est PARTAGÉE avec le bureau du secrétariat, qui réessayait sous collision ; ce
    // chemin-ci non, et deux demandes à la même seconde faisaient échouer la seconde (§118.175).
    const request = await createWithRetry(async () => prisma.administrativeRequest.create({
      data: {
        reference: await nextAdminRequestRef(),
        type: spec.type,
        title: titrePiece(nature, `${ITEM_KIND_LABELS[item.kind]} : ${item.label}`, info.ref),
        description: [
          note,
          `Poste de l'opération ${info.ref}.`,
          item.supplier ? `Prestataire pressenti : ${item.supplier}.` : null,
          item.amountEstimated != null ? `Enveloppe estimée : ${toNumber(item.amountEstimated).toLocaleString("fr-FR")} DZD.` : null,
        ].filter(Boolean).join("\n"),
        priority: "HIGH",
        requesterId: user.id,
        // La société de l'OPÉRATION, sinon celle où travaille son demandeur (`moneyEntityOf`) : une
        // opération d'avant le rattachement a `companyId` nul, et sa pièce naîtrait invisible du
        // bureau du secrétariat, cloisonné par société (§118.154).
        companyId: info.companyId ?? (await moneyEntityOf(info.requesterId ?? user.id)),
        status: "NEW",
        linkedEntityType: "AD_PRO_ITEM",
        linkedEntityId: item.id,
      },
      select: { id: true, reference: true },
    }));
    // `adminRequestId` reste le RACCOURCI du devis (relation `AdProItemQuoteRequest`, posée
    // avant le lien canonique) : on ne le LIT plus nulle part, mais l'écrire garde le
    // `onDelete: SetNull` utile et évite une migration de colonne pour rien.
    if (nature === "DEVIS") {
      await prisma.adProItem.update({ where: { id }, data: { adminRequestId: request.id, updatedById: user.id } });
      // LA LETTRE DE DEMANDE DE DEVIS (Direction, 07/10) — rédigée par Luna, PDF et Word sur papier en-tête, posée sur le
      // poste (étape « Demande de devis ») et sur la demande au secrétariat. Son échec ne retient pas la demande.
      await deposerLettreDevis(user, [{ entityType: "AD_PRO_ITEM", entityId: item.id }, { entityType: "ADMIN_REQUEST", entityId: request.id }], {
        titre: item.label, brief: null, reference: info.ref, societeId: info.companyId ?? null,
        articles: [{ designation: `${ITEM_KIND_LABELS[item.kind]} — ${item.label}`, quantite: null, unite: null, prestations: [], precision: note ?? null, produits: [] }],
      }).catch(sansBloquer("ad-pro-item-actions.demanderPieceSecretariat.deposerLettreDevis", null));
    }
    await notifyRoles(["DIRECTION_ASSISTANT", "SUPER_ADMIN"], {
      type: "ASSIGNMENT",
      title: `Demande de ${spec.libelle.toLowerCase()}`,
      body: `${request.reference} — ${item.label} (${info.ref})`,
      link: `/demandes/${request.id}`,
    }).catch(sansBloquer("ad-pro-item-actions.demanderPieceSecretariat.notifyRoles"));
    await audit(user, owner.parent, owner.id, "UPDATE", `Demande de ${spec.libelle.toLowerCase()} ${request.reference} ouverte pour le poste « ${item.label} ».`);
    revalidate(owner.parent, owner.id);
    revalidatePath("/demandes");
    return { ok: true, id: request.id };
  } catch (err) {
    console.error("[ad-pro-item] demande de pièce impossible", err);
    return { ok: false, error: `La demande de ${spec.libelle.toLowerCase()} n'a pas pu être créée.` };
  }
}

/**
 * L'ASSISTANTE QUI ÉTABLIT LE BC (§118.204) — celle que le formulaire désigne, sinon la seule assistante
 * de direction active. Plusieurs et aucune choisie : on ne choisit pas à la place du demandeur (§118.34),
 * le refus le dit. Lue AVANT toute écriture : un refus ne laisse pas un poste « demandé » sans assistante.
 */
async function assistanteDuBC(formData: FormData): Promise<{ id: string; name: string } | { error: string }> {
  const actives = await assistantesDeDirection();
  if (actives.length === 0) return { error: "Aucune assistante de direction active : demandez à l'administration d'en désigner une avant de demander le bon de commande." };
  const voulue = fdStr(formData, "assistantId");
  if (voulue === null) {
    if (actives.length === 1) return actives[0];
    return { error: "Choisissez l'assistante de direction qui établira le bon de commande." };
  }
  const trouvee = actives.find((a) => a.id === voulue);
  return trouvee ?? { error: "Cette personne n'est pas une assistante de direction active." };
}

// ───────────────────────── Bon de commande : demande → assistante → centre → signature ─────────────────────────

/**
 * DEMANDER LE BON DE COMMANDE d'un poste accordé (§118.204). La demande part chez l'ASSISTANTE DE
 * DIRECTION comme une demande de pièce : elle y dépose le BC, le demandeur le vérifie, et la pièce
 * REVIENT sur le poste (`classerDansLegal` → `rattacherPieceAuPoste`). Au-dessus du seuil, le centre
 * Ad & Pro vise la demande en parallèle (§118.148) ; la signature des Finances suit la pièce.
 *
 * Jusqu'ici, « Émettre le bon de commande » créait un ordre de dépense et rien d'autre : le BC que
 * l'assistante rédigeait dans une demande au secrétariat ne revenait jamais au poste.
 */
export async function requestAdProItemOrder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil et sans sa validation, rien ne s'engage.
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  const refusStock = refusArgentSurPosteStock(item.kind, "un bon de commande");
  if (refusStock) return { ok: false, error: refusStock };
  if (VERSEMENT_SANS_BC.includes(item.kind)) {
    return { ok: false, error: `Un sponsoring direct n'a pas de bon de commande : joignez la ${LIBELLE_JUSTIFICATIF_DIRECT.toLocaleLowerCase("fr")} puis demandez le paiement (la facture n'est pas exigée).` };
  }
  const demande = await PARENTS[owner.parent].load(owner.id);
  if (!demande) return { ok: false, error: "Opération introuvable." };
  const fermee = refusDemandeFermee(demande);
  if (fermee) return { ok: false, error: fermee };
  const note = fdStr(formData, "note");
  const montantAccorde = item.amountGranted != null ? toNumber(item.amountGranted) : null;

  // UNE DEMANDE D'AVANT LA RÈGLE (§118.204) : le poste est déjà « demandé » ou visé, mais son BC a été
  // demandé au secrétariat et ne reviendra jamais. On ENVOIE la demande de pièce, sans toucher au visa.
  if (item.orderStage === "REQUESTED" || item.orderStage === "DIRECTION_OK") {
    const ouverte = (await demandesBCDesPostes([id])).get(id);
    if (ouverte) return { ok: false, error: `La demande de bon de commande est déjà chez ${ouverte.assistante ?? "l'assistante de direction"}.` };
    const bcs = await bcEtablisDuPoste(id);
    if (bcs.length > 0) return { ok: false, error: "Le bon de commande de ce poste est déjà établi." };
    const assistante = await assistanteDuBC(formData);
    if ("error" in assistante) return { ok: false, error: assistante.error };
    await envoyerDemandeBC({ item, owner, ref: demande.ref, montant: montantAccorde, assistante, demandeurId: user.id, note: note ?? item.orderNote });
    // L'ANCIENNE DEMANDE « BC À ÉTABLIR » AU BUREAU DU SECRÉTARIAT (audit du 04/10, constat 21) : la
    // demande de pièce la REMPLACE. Laissée ouverte, l'assistante avait deux demandes pour le même BC, et
    // déposer dans l'ancienne ne revenait jamais au poste. Elle se clôt par l'annulation commune, avec la
    // trace qui dit par quoi elle est remplacée — APRÈS l'envoi : si l'envoi échoue, l'ancienne reste.
    const anciennes = await cloreDemandesAuBureau(
      id, `le bon de commande se demande désormais à ${assistante.name} comme une pièce, qui reviendra sur le poste`, user, "BC_A_ETABLIR",
      "au profit de la demande de pièce",
    );
    await audit(user, owner.parent, owner.id, "UPDATE", `Demande de bon de commande envoyée à ${assistante.name} pour le poste « ${item.label} »${anciennes.closes > 0 ? ` — l'ancienne demande au secrétariat est close` : ""}.`);
    revalidate(owner.parent, owner.id);
    return {
      ok: true, id,
      message: `Demande envoyée à ${assistante.name}, qui déposera le bon de commande.`
        + (anciennes.closes > 0 ? ` L'ancienne demande « ${TITRE_BC_A_ETABLIR} » au secrétariat est close.` : "")
        + (anciennes.reserve ? ` Attention : ${anciennes.reserve}` : ""),
    };
  }

  const check = canRequestPurchaseOrder({
    status: item.status, amountGranted: montantAccorde, budgetCategoryId: item.budgetCategoryId, orderStage: item.orderStage,
  });
  if (!check.ok) return { ok: false, error: check.reason ?? "Demande impossible." };
  const assistante = await assistanteDuBC(formData);
  if ("error" in assistante) return { ok: false, error: assistante.error };

  // LA MARCHE (`lireLaMarcheDuBC`, la règle partagée avec la génération) : l'écriture et la notification restent ICI, dans le corps.
  const { sousLeSeuil, seuilBC, where, data } = await lireLaMarcheDuBC({ itemId: item.id, montantAccorde: montantAccorde as number, userId: user.id, note, assistantId: assistante.id });
  const posee = await prisma.adProItem.updateMany({ where, data });
  if (posee.count === 0) return { ok: false, error: REFUS_MARCHE_PRISE };
  if (!sousLeSeuil) {
    await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], notificationDuCentreBC({ id: item.id, ref: demande.ref, label: item.label, montantAccorde: montantAccorde as number })).catch(sansBloquer("ad-pro-item-actions.requestAdProItemOrder.notifyRoles"));
  }
  await envoyerDemandeBC({ item, owner, ref: demande.ref, montant: montantAccorde, assistante, demandeurId: user.id, note });
  await audit(user, owner.parent, owner.id, "UPDATE", sousLeSeuil
    ? `Bon de commande demandé à ${assistante.name} pour le poste « ${item.label} » — ${motifSousLeSeuil(seuilBC)}`
    : `Bon de commande demandé à ${assistante.name} pour le poste « ${item.label} » — en validation au centre Ad & Pro.`);
  revalidate(owner.parent, owner.id);
  if (!sousLeSeuil) revalidatePath("/centre-ad-pro");
  return {
    ok: true, id,
    message: sousLeSeuil
      ? `Demande envoyée à ${assistante.name}, qui déposera le bon de commande. ${motifSousLeSeuil(seuilBC)}`
      : `Demande envoyée à ${assistante.name}, qui déposera le bon de commande — le centre de validation Ad & Pro le vise en parallèle.`,
  };
}

/**
 * VISA DU CENTRE DE VALIDATION AD & PRO sur la demande d'émission — puis les Finances émettent.
 * Deux marches, parce que ce sont deux responsabilités : le centre engage, les Finances paient.
 *
 * ── POURQUOI LE CENTRE, ET PLUS « LA DIRECTION » ─────────────────────────────────────────
 *
 * « Concernant les BC, ils doivent tous passer soit par le centre de validation Ad&Pro si la
 * demande est depuis Ad&Pro, soit par le centre de validation normal » (Direction, 09/2026). Le
 * visa était donné par quiconque avait la vue globale ou VALIDATE sur le module — la Direction
 * des opérations, la Direction Marketing : aucun centre ne voyait passer ces BC. Il revient aux
 * SIÈGES du centre (`siegeAuCentreAdPro`), et le centre les LIT (`queries/ad-pro-centre.ts`) :
 * décider depuis la fiche ou depuis le centre appelle la MÊME action, avec la même garde.
 *
 * La note de la Direction a son PROPRE champ. Elle vivait dans `orderNote`, où le demandeur
 * avait écrit le contenu du bon de commande et ses références : chaque visa l'EFFAÇAIT, et
 * personne ne s'en apercevait — mesuré, la colonne avait trois écrivains et aucun lecteur.
 * L'assistante devait donc redemander à la main ce que le circuit avait déjà transporté.
 */
export async function approveAdProItemOrder(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision") ?? "APPROVE";
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  // LA PORTE DU DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil et sans sa validation, rien ne s'engage.
  const porteDg = await refusSiPorteDgFermee(owner.parent, owner.id);
  if (porteDg) return { ok: false, error: porteDg };
  if (!siegeAuCentreAdPro(user)) return { ok: false, error: REFUS_BC_CENTRE_AD_PRO };
  if (item.orderStage !== "REQUESTED") return { ok: false, error: "Aucune demande d'émission en attente sur ce poste." };

  const note = fdStr(formData, "note");
  // CE QUE LE CENTRE A LU (§118.187) : l'écran envoie le montant qu'il affichait. Un montant relevé
  // pendant la lecture serait visé sans avoir été vu — le refus le dit, avec les deux chiffres. Sans
  // ce champ (un appelant qui ne l'envoie pas), rien n'est comparé ici ; l'empreinte, elle, est
  // toujours posée sur la valeur LUE, par une écriture conditionnelle.
  const montantVu = fdNum(formData, "montantVu");
  const montantActuel = item.amountGranted != null ? toNumber(item.amountGranted) : null;
  if (montantVu != null && montantActuel != null && montantVu !== montantActuel) {
    return {
      ok: false,
      error: `Le montant de ce poste a changé pendant que vous lisiez (${montantVu.toLocaleString("fr-FR")} → ${montantActuel.toLocaleString("fr-FR")} DZD) : relisez la demande avant de la viser.`,
    };
  }
  // Le PRESTATAIRE lu, de même : c'est à lui que l'argent partira. Un champ absent n'est pas comparé.
  if (formData.has("prestataireVu") && !memePrestataire(fdStr(formData, "prestataireVu"), item.supplier)) {
    return {
      ok: false,
      error: `Le prestataire de ce poste a changé pendant que vous lisiez (désormais : ${item.supplier?.trim() || "le bénéficiaire de l'opération"}) : relisez la demande avant de la viser.`,
    };
  }
  const info = await PARENTS[owner.parent].load(owner.id);
  const lien = lienPosteAdPro(owner.parent, owner.id, item.id);
  const cible =`${info?.ref ?? ""} — « ${item.label} » (${toNumber(item.amountGranted!).toLocaleString("fr-FR")} DZD)`;
  const changee = "Cette demande vient de changer (retirée, déjà décidée, ou son montant ou son prestataire a bougé) : rouvrez la fiche.";
  if (decision === "REFUSE") {
    // UN REFUS SANS MOTIF EST UNE IMPASSE pour le demandeur — la règle du centre, ici aussi.
    // `=== null` et non `!note` : la dérivation des contrats lit `if (!v)` comme « champ
    // OBLIGATOIRE » pour toute l'action, et le motif n'est exigé que pour un REFUS — l'approbation
    // sans note deviendrait inappelable par le chemin générique (§118.87c, §118.138).
    if (note === null) return { ok: false, error: "Indiquez le motif du refus : sans lui, le demandeur ne sait pas quoi corriger." };
    const refuse = await prisma.adProItem.updateMany({
      where: { id, orderStage: "REQUESTED" },
      data: { orderStage: "REFUSED", orderDecisionNote: note, updatedById: user.id },
    });
    if (refuse.count === 0) return { ok: false, error: changee };
    await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande REFUSÉ par le centre de validation Ad & Pro pour « ${item.label} » — ${note}.`);
    if (item.orderRequestedById) {
      await notifyUser({
        userId: item.orderRequestedById, type: "VALIDATION_REQUIRED",
        title: "Bon de commande refusé par le centre Ad & Pro", body: `${cible} — ${note}`, link: lien,
      }).catch(sansBloquer("ad-pro-item-actions.approveAdProItemOrder.notifyUser"));
    }
    revalidate(owner.parent, owner.id);
    revalidatePath("/centre-ad-pro");
    return { ok: true, id };
  }

  // L'EMPREINTE DU VISA (§118.187) : le montant et le prestataire LUS — et l'écriture n'aboutit que
  // s'ils n'ont pas bougé depuis. Deux sièges qui visent ensemble, ou un retrait qui passe pendant le
  // visa, ne s'appliquent pas deux fois.
  const vise = await prisma.adProItem.updateMany({
    where: { id, orderStage: "REQUESTED", amountGranted: item.amountGranted, supplier: item.supplier },
    data: {
      orderStage: "DIRECTION_OK", orderDirectionAt: new Date(), orderDirectionById: user.id, orderDecisionNote: note,
      orderVisaAmount: item.amountGranted, orderVisaSupplier: item.supplier, updatedById: user.id,
    },
  });
  if (vise.count === 0) return { ok: false, error: changee };
  await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Bon de commande validé — à émettre",
    body: cible,
    link: lien,
  }).catch(sansBloquer("ad-pro-item-actions.approveAdProItemOrder.notifyRoles"));
  if (item.orderRequestedById) {
    await notifyUser({
      userId: item.orderRequestedById, type: "GENERIC",
      title: "Bon de commande validé par le centre Ad & Pro", body: `${cible} — transmis aux Finances.`, link: lien,
    }).catch(sansBloquer("ad-pro-item-actions.approveAdProItemOrder.notifyUser"));
  }
  await audit(user, owner.parent, owner.id, "UPDATE", `Bon de commande validé par le centre de validation Ad & Pro pour « ${item.label} » — transmis aux Finances.`);
  // LA PIÈCE EXISTE PEUT-ÊTRE DÉJÀ (§118.149) : l'assistante l'a établie pendant que le centre
  // tranchait. Le visa du poste EST sa porte (`PorteBC.source = "POSTE"`) — elle passe donc
  // maintenant à la signature des Finances, qui doivent le savoir. Une pièce qui n'existe pas
  // encore les préviendra elle-même en naissant (l'aiguillage lit alors un poste validé).
  const piecesDuPoste = await prisma.adProItemPiece.findMany({
    where: { itemId: id, nature: "BON_DE_COMMANDE" },
    select: { legalDocumentId: true },
  }).catch(sansBloquer("ad-pro-item-actions.approveAdProItemOrder.adProItemPiece", []));
  for (const p of piecesDuPoste) {
    if (p.legalDocumentId) await signalerSiASigner(p.legalDocumentId).catch(sansBloquer("ad-pro-item-actions.approveAdProItemOrder.signalerSiASigner", false));
  }
  revalidate(owner.parent, owner.id);
  revalidatePath("/centre-ad-pro");
  if (piecesDuPoste.length > 0) revalidatePath(CHEMIN_BC_A_SIGNER);
  return { ok: true, id };
}

/**
 * DEMANDER LE BC D'UNE BILLETTERIE — d'après les propositions RETENUES. Exige au moins un devis retenu,
 * écrit la liste dans la demande (l'assistante sait quelles propositions établir), puis passe par la
 * porte du poste (`requestAdProItemOrder`) : mêmes gardes (poste accordé, budget), même chaîne ensuite
 * jusqu'à la facture. Le montant accordé ne bouge pas ; un dépassement se dit.
 */
export async function demanderBCBilletterie(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await loadItem(id, user);
  if (!found) return { ok: false, error: "Poste introuvable." };
  if (found.historique) return { ok: false, error: REFUS_HISTORIQUE };
  const { item, owner } = found;
  if (!canEditItems(user, owner.parent)) return { ok: false, error: "Non autorisé." };
  if (!porteDesVoyageurs(item.kind)) return { ok: false, error: "Seul un poste « billetterie » demande son BC d'après les devis de ses voyageurs." };
  const [retenus, total] = await Promise.all([
    prisma.adProVoyageurDevis.findMany({
      where: { retenuLe: { not: null }, voyageur: { itemId: id }, piece: { legalDocument: { status: { not: "CANCELLED" }, cancelledAt: null } } },
      select: { voyageur: { select: { nom: true, prenom: true, position: true } }, piece: { select: { legalDocument: { select: { id: true, title: true, reference: true, amount: true } } } } },
    }),
    prisma.adProVoyageur.count({ where: { itemId: id } }),
  ]);
  if (retenus.length === 0) {
    return { ok: false, error: "Validez d'abord le devis d'au moins un voyageur : le bon de commande s'établit d'après les propositions retenues." };
  }
  retenus.sort((a, b) => a.voyageur.position - b.voyageur.position);
  // LA MÊME PIÈCE RETENUE POUR PLUSIEURS VOYAGEURS se nomme une fois avec son montant ; les autres la désignent (« même pièce »).
  const piece = await pieceComptee(id);
  const dejaNommee = new Set<string>();
  const liste = retenus.map((r) => {
    const d = r.piece.legalDocument;
    const cle = piece(d.id);
    const montant = dejaNommee.has(cle) ? " (même pièce que ci-dessus, comptée une fois)" : d.amount != null ? ` (${toNumber(d.amount).toLocaleString("fr-FR")} DZD)` : "";
    dejaNommee.add(cle);
    return `• ${nomComplet(r.voyageur)} — ${d.reference ?? d.title}${montant}`;
  }).join("\n");
  const sansDevis = total - retenus.length;
  const note = [fdStr(formData, "note"), `Devis retenus (${retenus.length}/${total} voyageur(s)) :\n${liste}`].filter(Boolean).join("\n\n");
  formData.set("note", note);
  const r = await requestAdProItemOrder(undefined, formData);
  if (!r.ok) return r;
  const depasse = await depassementDuPoste(id, item.amountGranted);
  const reste = sansDevis > 0 ? ` ${sansDevis} voyageur(s) sans devis retenu ne sont pas dans cette demande.` : "";
  return { ...r, message: `${r.message ?? "Bon de commande demandé."}${reste}${depasse ? ` ${depasse}` : ""}` };
}
