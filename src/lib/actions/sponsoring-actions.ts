"use server";

import { revalidatePath } from "next/cache";
import type { AdProItemKind, Priority, SponsoringNature, SponsoringStatus } from "@prisma/client";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, anyRoleFilter, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { moneyEntityOf } from "@/lib/company";
import { readMultiField, lireMedecinsDemande } from "@/lib/ad-pro/pickers";
import { businessUnitDuDemandeur } from "@/lib/ad-pro/business-unit-auto";
import { normalizeCity } from "@/lib/geo/algeria";
import { buildRef, createWithRetry } from "@/lib/refs";
import { recordAudit } from "@/lib/audit";
import { attachFiles, validateAttachments } from "@/lib/attach-files";import { notifyRoles, notifyUser } from "@/lib/notify";
import { involveThirdParty } from "@/lib/third-party";
import { reopenInstance } from "@/lib/workflow/engine";
import { adProInit, PRODUCT_MANAGER_ROLES } from "@/lib/workflow/origin";
import { referentAInscrire } from "@/lib/ad-pro/referent-de-la-gamme";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { ITEM_KIND_LABELS } from "@/lib/ad-pro-items";
import { toNumber } from "@/lib/utils";
import { porteLeRoleQuiTranche } from "@/lib/personnes/referents-gamme";
import { bilanCloture, peutCloturer, quiCloture, refusCloture, type QuiCloture } from "@/lib/ad-pro/cloture-sponsoring";
import { postesPourCloture } from "@/lib/queries/ad-pro-items";

const PATH = "/sponsoring";

/**
 * LES FORMATS D'UNE DEMANDE DU MÉDECIN — un scan ou un courrier, rien d'autre.
 *
 * La liste est FERMÉE et vit à côté de son refus : l'`accept` du formulaire ne fait que guider
 * le sélecteur de fichiers et ne s'applique pas à un envoi qui ne vient pas de cet écran.
 */
const FORMATS_DEMANDE_MEDECIN = /\.(pdf|doc|docx)$/i;

/**
 * LA NATURE D'UN SPONSORING DÉCIDE LE POSTE QUI NAÎT AVEC LUI (§118.151).
 *
 * « Ce sponsoring s'ajoute automatiquement dans un poste, car dans les postes on voit tous les
 * postes relatifs à cette demande ; on précisera si c'est un sponsoring direct (à l'association)
 * ou indirect (prise en charge de prestations / de médecins) » (Direction, 09/2026).
 *
 * La table est FERMÉE et exhaustive (`Record<SponsoringNature, …>`) : une troisième nature ajoutée
 * au schéma ne compile pas tant que personne n'a dit quel poste elle ouvre.
 */
const POSTE_DE_LA_NATURE: Record<SponsoringNature, AdProItemKind> = {
  DIRECT: "ASSOCIATION_SUPPORT",
  INDIRECT: "INDIRECT_SUPPORT",
};
const NATURES_SPONSORING = Object.keys(POSTE_DE_LA_NATURE) as SponsoringNature[];

const dzd = (n: number) => `${n.toLocaleString("fr-FR")} DZD`;

/** Approbation préliminaire Ad & Pro : **réservée au National Sales** (la demande
 *  émane d'un délégué). Il approuve/refuse et désigne le référent Direction Marketing — la
 *  décision définitive reste à la Direction. Ni la Direction ni la Direction
 *  Marketing n'interviennent à l'étape préliminaire. */
function canDoPreliminary(user: SessionUser): boolean {
  return hasRole(user, "NATIONAL_SALES") || user.role === "SUPER_ADMIN";
}

function revalidate(id: string) {
  revalidatePath(PATH);
  revalidatePath(`${PATH}/${id}`);
}

// ───────────────────────────── Création (→ pré-validation Direction) ─────────────────────────────

export async function createSponsoring(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUserAuNomDeLaVue();
  if (!userCan(user, "SPONSORING", "CREATE")) return { ok: false, error: "Non autorisé." };
  // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.

  const institution = fdStr(formData, "institution");
  if (!institution) return { ok: false, error: "L'institution est obligatoire." };

  // ─── LES CHAMPS QUE LA DIRECTION A RENDUS OBLIGATOIRES ────────────────────────────────
  //
  // Le formulaire les marque `required`, et ce n'est PAS la garde : un champ de formulaire se
  // forge, et l'écran n'est pas la seule porte (le chemin générique d'Adam poste la même action).
  // C'est ici que l'obligation est tenue — et elle NOMME ce qui manque en une fois, pas champ par
  // champ : un refus par aller-retour ferait ressaisir six fois un formulaire de quinze champs
  // (§118.18).
  // LES CLÉS SONT LITTÉRALES, et elles le restent : la dérivation des contrats d'action ne
  // lit pas les clés d'un délégué IMPORTÉ, et un champ non déclaré est un champ que le chemin
  // générique d'Adam se fait refuser (§118.87c). Le NOM est partagé et tenu par un cliquet.
  const medecins = lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor"));
  const produits = readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product"));
  const natureLue = fdStr(formData, "nature") as SponsoringNature | null;
  const nature = natureLue && NATURES_SPONSORING.includes(natureLue) ? natureLue : null;
  const demandeParLeMedecin = fdNum(formData, "amountRequested");
  const suggereParLeDelegue = fdNum(formData, "amountProposed");
  const manquants = [
    !medecins ? "le ou les médecins concernés" : null,
    !produits ? "le ou les produits concernés" : null,
    !fdStr(formData, "city") ? "la ville (wilaya)" : null,
    !fdStr(formData, "specialty") ? "la spécialité" : null,
    !fdStr(formData, "type") ? "le type" : null,
    // Les deux montants que la Direction a nommés — ceux d'une DEMANDE, pas d'un budget : le
    // budget se décide poste par poste puis à la clôture (§118.151).
    demandeParLeMedecin == null ? "le sponsoring demandé par le médecin (DZD)" : null,
    suggereParLeDelegue == null ? "le sponsoring suggéré par le délégué (DZD)" : null,
    !nature ? "la nature du sponsoring (direct à l'association, ou indirect — prise en charge)" : null,
    !fdStr(formData, "strategicImportance") ? "l'importance stratégique" : null,
  ].filter((x): x is string => x !== null);
  if (manquants.length > 0) {
    return { ok: false, error: `Demande incomplète — il manque : ${manquants.join(", ")}.` };
  }
  if ((demandeParLeMedecin ?? 0) < 0 || (suggereParLeDelegue ?? 0) < 0) {
    return { ok: false, error: "Un montant de sponsoring ne peut pas être négatif." };
  }

  // ─── LA DEMANDE DU MÉDECIN : UNE PIÈCE, ET UN SCAN ────────────────────────────────────
  //
  // C'est le document que tout le circuit lit — le National Sales pour juger l'opportunité,
  // Direction Marketing pour arbitrer le budget. Les formats admis sont ceux d'un scan ou d'un
  // courrier ; on refuse une image brute non pas par principe mais parce que la Direction a
  // demandé un PDF ou un Word, et qu'un `accept` de formulaire ne s'applique qu'au sélecteur.
  const pieces = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (pieces.length === 0) {
    return {
      ok: false,
      error: "La demande du médecin est obligatoire : joignez-la scannée (PDF ou Word). "
        + "Le document original doit par ailleurs être déposé au bureau du secrétariat.",
    };
  }
  const horsFormat = pieces.filter((f) => !FORMATS_DEMANDE_MEDECIN.test(f.name)).map((f) => f.name);
  if (horsFormat.length > 0) {
    return {
      ok: false,
      error: `La demande du médecin doit être un scan PDF ou un Word (.pdf, .doc, .docx) — reçu : ${horsFormat.join(", ")}.`,
    };
  }

  // Routage intelligent : on saute les étapes d'approbation au niveau/en dessous du créateur.
  const pmId = fdStr(formData, "productManagerId");
  if (pmId) {
    const okPm = await prisma.user.count({ where: { id: pmId, isActive: true, ...anyRoleFilter(PRODUCT_MANAGER_ROLES) } });
    if (!okPm) return { ok: false, error: "Le référent Direction Marketing sélectionné est introuvable." };
  }
  // La Direction peut demander l'avis de la Direction Marketing avant de trancher — ou trancher tout
  // de suite. `adProInit` ignore ce drapeau pour les autres rangs : le choix ne s'attrape pas en
  // forgeant un champ de formulaire.
  const init = adProInit(user, "SPONSORING", pmId);
  /*
   * LA GAMME SE LIT UNE FOIS, ET LE RÉFÉRENT VIENT DE CELLE QU'ON ÉCRIT.
   *
   * La première version lisait la gamme DEUX fois : la ligne recevait `gammeDeduite ?? le
   * formulaire` (la gamme d'un KAM est IMPOSÉE côté serveur, §118.108) et le référent était
   * cherché sur le FORMULAIRE seul. Les deux lectures pouvaient donc désigner des gammes
   * différentes, et l'on inscrivait l'arbitre de la gamme A sur une demande déposée sous la
   * gamme B — le défaut de §104.7 appliqué à une personne : la carte annonce une chose, la base
   * en porte une autre. Trouvé en RELISANT le diff de l'artefact régénéré (§118.137), pas à la
   * relecture du code.
   */
  const gammeDeduite = await businessUnitDuDemandeur(user);
  const gammeDeLaDemande = gammeDeduite?.id ?? (fdStr(formData, "businessUnitId") || null);
  const referentGamme = await referentAInscrire(gammeDeLaDemande);
  const now = new Date();

  // LES PIÈCES SE JUGENT AVANT LA DEMANDE (audit du 04/10, constat 7). Refusées après, elles
  // laissaient la demande créée : la personne corrigeait son fichier, renvoyait, et le sponsoring
  // existait deux fois.
  // Les AUTRES pièces (un Excel de participants, un programme…) : tout type sauf ce qui s'exécute,
  // jugées avec la demande du médecin, avant d'écrire quoi que ce soit.
  // Nom LITTÉRAL (= `CHAMP_PIECES_COMPLEMENTAIRES`) : le contrat des actions lit les champs dans la source.
  const annexes = formData.getAll("annexes").filter((f): f is File => f instanceof File);
  const piecesRefusees = await validateAttachments([...pieces, ...annexes]);
  if (piecesRefusees) return { ok: false, error: `${piecesRefusees} Aucune demande n'a été créée.` };

  // LA RÉFÉRENCE SE RECALCULE À CHAQUE ESSAI (§118.175). Elle se dérive du MAXIMUM existant :
  // deux dépôts à la même seconde lisaient le même, calculaient la même, et le second tombait sur
  // la contrainte d'unicité — une erreur brute, après avoir rempli le formulaire et choisi sa pièce.
  // Le consulting, « autre demande » et le matériel promotionnel réessayaient depuis toujours ; le
  // sponsoring, non. Le banc FORCE l'entrelacement (deux dépôts bloqués à l'insertion, relâchés
  // ensemble), sans quoi il passerait sans le filet (§118.65).
  const year = new Date().getFullYear();
  const referenceSuivante = async () => buildRef("SPO", year,
    (await prisma.sponsoringRequest.findMany({ where: { reference: { startsWith: `SPO-${year}-` } }, select: { reference: true } })).map((r) => r.reference));

  const created = await createWithRetry(async () => prisma.sponsoringRequest.create({
    data: {
      // LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé.
      //
      // Là où elle se LIT sur la personne (un KAM par sa fiche force de vente, un superviseur
      // national par la gamme qu'il supervise), le champ posté n'entre pas en ligne de compte :
      // il se forge, et une gamme forgée fait peser la dépense sur le budget d'une autre équipe.
      // Là où elle ne se lit pas, la saisie reste souveraine.
      businessUnitId: gammeDeLaDemande,
      reference: await referenceSuivante(),
      institution,
      // PLUSIEURS MÉDECINS, PLUSIEURS PRODUITS. Le formulaire envoie une entrée par case cochée ;
      // la colonne, elle, est un texte lu partout (liste, fiche, libellé de l'ordre de dépense,
      // notification). On joint donc les noms choisis — et la saisie libre reste acceptée pour les
      // écrans anciens et pour le cas où le référentiel est vide : refuser une valeur qu'on n'a
      // pas su proposer, c'est bloquer une demande légitime pour un défaut de table.
      doctor: medecins,
      specialty: fdStr(formData, "specialty"),
      // La ville vient du référentiel des wilayas ; `normalizeCity` remet une saisie ancienne dans
      // sa forme officielle sans jamais effacer ce qu'elle ne sait pas rattacher.
      city: normalizeCity(fdStr(formData, "city")),
      type: fdStr(formData, "type") ?? "Sponsoring",
      description: fdStr(formData, "description"),
      comments: fdStr(formData, "comments"),
      amountRequested: demandeParLeMedecin,
      amountProposed: suggereParLeDelegue,
      nature,
      product: produits,
      strategicImportance: (fdStr(formData, "strategicImportance") as Priority) ?? "MEDIUM",
      status: init.status as SponsoringStatus,
      requesterId: user.id,
      createdById: user.id,
      // Entité : la portée en cours, à défaut la société d'appartenance du créateur.
      // L'ENTITÉ QUI PAIERA suit la PERSONNE (sa fiche employé, à défaut son
      // département), pas la portée sélectionnée dans la barre : un délégué de Pharmagène qui
      // consulte Adventum ne doit pas imputer sa demande à Adventum. La Direction corrige en
      // validant, au seul moment où quelqu'un a le dossier entier sous les yeux.
      companyId: await moneyEntityOf(user.id),
      // LE RÉFÉRENT DE LA GAMME, quand la gamme n'en a qu'UN (§118.144).
      //
      // `productManagerId` a sept lecteurs — droits de la fiche, déclaration d'information
      // médicale, garde de l'analyse — et n'avait plus AUCUN écrivain depuis que le menu de
      // création a été retiré : un champ que tout le monde lit et que personne n'écrit. Il vient
      // désormais de la configuration de la gamme, et SEULEMENT quand elle désigne une personne
      // à coup sûr : plusieurs référents n'en désignent aucun, parce que collapser choisirait
      // l'arbitre d'un budget par l'ordre d'insertion en base (§118.34).
      //
      // Le ROUTAGE n'est pas touché : la demande part où le tamis dit qu'elle part, elle porte
      // simplement le nom de son référent.
      ...(init.productManagerId || referentGamme ? { productManagerId: init.productManagerId || referentGamme! } : {}),
      ...(init.preliminaryBySelf ? { preliminaryById: user.id, preliminaryAt: now } : {}),
      // LE POSTE NAÎT AVEC LA DEMANDE, dans la MÊME écriture (§118.151).
      //
      // Créé à part, il pourrait manquer : une demande sans son poste est exactement ce que la
      // Direction ne veut plus voir — « dans les postes on voit tous les postes relatifs à cette
      // demande », et le sponsoring lui-même en est le premier. Une création imbriquée est
      // atomique : les deux lignes existent ensemble, ou aucune.
      //
      // Chiffré à ce que SUGGÈRE LE DÉLÉGUÉ — c'est une recommandation, et c'est la Direction
      // Marketing qui accordera ; la demande du médecin est dite dans le poste pour que l'écart se
      // lise sans ouvrir la demande. Un sponsoring direct se verse à l'association : elle est le
      // bénéficiaire du poste. Un sponsoring indirect paie des prestataires que personne ne connaît
      // encore : le bénéficiaire reste vide plutôt que deviné.
      items: {
        create: {
          kind: POSTE_DE_LA_NATURE[nature!],
          label: `${ITEM_KIND_LABELS[POSTE_DE_LA_NATURE[nature!]]} — ${institution}`,
          notes: `Sponsoring demandé par le médecin : ${dzd(demandeParLeMedecin!)} · suggéré par le délégué : ${dzd(suggereParLeDelegue!)}.`,
          supplier: nature === "DIRECT" ? institution : null,
          amountEstimated: suggereParLeDelegue,
          budgetKind: "INCLUDED",
          position: 1,
          createdById: user.id,
          updatedById: user.id,
        },
      },
    },
  }));

  // Les demandes du médecin, jointes DÈS la création : c'est la pièce que tout le circuit va
  // lire, et la faire ajouter « à l'écran suivant » revient à la voir manquer une fois sur deux.
  // Les pièces ont passé le contrôle plus haut : ce qui peut encore échouer ici, c'est l'écriture.
  // La demande EXISTE — rendre un échec ferait recréer un sponsoring au second essai. Le manque
  // est dit (dans la réponse et dans la cloche) et la pièce se rejoint depuis la fiche.
  const attached = await attachFiles({
    files: pieces, entityType: "SPONSORING", entityId: created.id, uploadedById: user.id, category: "REQUEST_LETTER",
  });
  const annexesJointes = await attachFiles({
    files: annexes, entityType: "SPONSORING", entityId: created.id, uploadedById: user.id, category: "SUPPORTING_DOC",
  });
  const nbPieces = attached.saved + annexesJointes.saved;
  const manque = [attached.error, annexesJointes.error].filter(Boolean).join(" ");

  await recordAudit({ actorId: user.id, action: "CREATE", module: "Sponsoring", entityType: "SPONSORING", entityId: created.id, summary: `Demande ${created.reference} — ${institution} — sponsoring ${nature === "DIRECT" ? "direct" : "indirect"}, poste créé avec la demande${nbPieces > 0 ? ` (${nbPieces} pièce(s) jointe(s))` : ""}` });
  await notifyAdProCreation(init, created.id, `${created.reference} — ${institution}`);

  revalidatePath(PATH);
  // Le tableau « Toutes les demandes » et « Mon espace » lisent aussi la demande qui vient de naître.
  revalidatePath("/ad-pro");
  revalidatePath("/mon-espace");
  return { ok: true, id: created.id, ...(manque ? { message: `Demande créée. ${manque}` } : {}) };
}

/** Notifie l'acteur de l'étape de DÉPART d'un sponsoring, selon le routage à la création. */
async function notifyAdProCreation(init: ReturnType<typeof adProInit>, id: string, body: string) {
  const link = `${PATH}/${id}`;
  if (init.stage === "ANALYSIS" && init.productManagerId) {
    await notifyUser({ userId: init.productManagerId, type: "ASSIGNMENT", title: "Sponsoring à analyser", body, link });
    return;
  }
  if (init.stage === "FINAL") {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "SPONSORING_VALIDATION", title: "Sponsoring — validation définitive", body, link });
    return;
  }
  await notifyRoles(["NATIONAL_SALES", "SUPER_ADMIN"], { type: "SPONSORING_VALIDATION", title: "Sponsoring — à attribuer (National Sales)", body, link });
}

// ───────────────────────── Validation finale et clôture (§118.151) ─────────────────────────

/**
 * QUI TIENT LA CLÔTURE DE CETTE DEMANDE — lu sur le parcours GELÉ de son instance.
 *
 * La borne `finalSlug` dit où la chaîne s'est arrêtée : à la Direction des opérations quand la
 * demande venait de la Direction Marketing elle-même, à la Direction Marketing sinon. Une demande
 * sans instance (antérieure au moteur) retombe sur la Direction Marketing, la règle générale.
 */
async function quiClotureLaDemande(id: string): Promise<QuiCloture> {
  const instance = await prisma.workflowInstance.findUnique({
    where: { entityType_entityId: { entityType: "SPONSORING", entityId: id } },
    select: { finalSlug: true },
  });
  return quiCloture(instance?.finalSlug ?? null);
}

function faitsCloturant(user: SessionUser, requesterId: string | null) {
  return {
    estSuperAdmin: user.role === "SUPER_ADMIN",
    porteLeRoleQuiTranche: porteLeRoleQuiTranche(user),
    aLaVueGlobale: hasGlobalView(user),
    estLeDemandeur: requesterId != null && requesterId === user.id,
  };
}

/**
 * VALIDER ET CLÔTURER — « une fois l'événement complété, la Direction Marketing valide tout, met
 * chaque poste dans un budget, valide et clôture » (Direction, 09/2026).
 *
 * Le geste ne décide aucun poste à la place de personne : il VÉRIFIE que tout l'a été
 * (`bilanCloture`, qui dit tout ce qui manque en une fois), puis FIGE — le total des postes
 * accordés devient le montant accordé de la demande, et ses postes ne se réécrivent plus
 * (`refusSiClos`, côté postes). Ce qui a été validé continue de s'exécuter : un BC encore à
 * émettre, une facture encore à recevoir ne sont pas bloqués par la clôture.
 *
 * L'écriture est CONDITIONNELLE (`status: PRE_VALIDATED`) : deux clics simultanés ne clôturent
 * qu'une fois, et une demande rouverte ou modifiée entre la lecture et l'écriture n'est pas
 * clôturée sur un bilan périmé.
 */
export async function cloturerSponsoring(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande non précisée." };
  const req = await prisma.sponsoringRequest.findUnique({
    where: { id },
    select: { id: true, reference: true, institution: true, status: true, requesterId: true },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };

  const qui = await quiClotureLaDemande(id);
  if (!peutCloturer(faitsCloturant(user, req.requesterId), qui)) return { ok: false, error: refusCloture(qui) };

  // Les postes TELS QUE LA CLÔTURE LES JUGE — nature et matériel réservé compris (§118.167) : la
  // même lecture que la page et que l'op d'Adam.
  const bilan = bilanCloture(req.status, await postesPourCloture(id));
  if (!bilan.cloturable) return { ok: false, error: `Clôture impossible — ${bilan.manques.join(" ; ")}.` };

  const note = fdStr(formData, "note");
  const now = new Date();
  const fait = await prisma.sponsoringRequest.updateMany({
    where: { id, status: "PRE_VALIDATED" },
    data: {
      status: "CLOSED",
      amountGranted: bilan.total,
      closedAt: now,
      closedById: user.id,
      closingNote: note,
      validatedBy: user.name ?? null,
      validationDate: now,
      updatedById: user.id,
    },
  });
  if (fait.count === 0) return { ok: false, error: "La demande a changé entre-temps (déjà clôturée ?) : rechargez la fiche." };

  const montant = `${bilan.total.toLocaleString("fr-FR")} DZD`;
  const detail = `${bilan.accordes} poste(s) accordé(s)${bilan.refuses > 0 ? `, ${bilan.refuses} refusé(s)` : ""} — total ${montant}`;
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({
      userId: req.requesterId, type: "SPONSORING_VALIDATION",
      title: bilan.total > 0 ? "Sponsoring validé et clôturé" : "Sponsoring clôturé sans dépense",
      body: `${req.reference} — ${req.institution} : ${detail}`,
      link: `${PATH}/${id}`,
    }).catch(() => undefined);
  }
  await recordAudit({
    actorId: user.id, action: "VALIDATE", module: "Sponsoring", entityType: "SPONSORING", entityId: id,
    summary: `Validation finale et clôture — ${req.reference} : ${detail}${note ? ` (${note})` : ""}`,
  });
  revalidate(id);
  return { ok: true, id };
}

/**
 * ROUVRIR UNE DEMANDE CLÔTURÉE — le remède que le refus des postes nomme.
 *
 * Une facture arrive pour un autre montant, un poste a été oublié : sans ce geste, la clôture
 * serait une impasse, et « corrigez » renverrait vers une action qui n'existe pas (§118.63). Même
 * autorité que la clôture, et un MOTIF obligatoire : défaire une validation se justifie.
 *
 * Le montant accordé et la validation sont RETIRÉS, pas conservés : rouverte, la demande revient
 * à l'état où l'argent se décide encore, et afficher l'ancien total à côté de postes qu'on est en
 * train de modifier ferait lire un accord qui n'existe plus. L'historique garde tout (audit).
 * Une demande close par un TRANSFERT ne se rouvre pas ici : elle vit dans un autre module.
 */
export async function rouvrirSponsoring(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Demande non précisée." };
  const motif = fdStr(formData, "reason");
  if (!motif) return { ok: false, error: "Le motif de la réouverture est obligatoire." };
  const req = await prisma.sponsoringRequest.findUnique({
    where: { id },
    select: { id: true, reference: true, institution: true, status: true, requesterId: true, closedAt: true, amountGranted: true },
  });
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (req.status !== "CLOSED" || req.closedAt == null) {
    return { ok: false, error: "Seule une demande clôturée par sa validation finale se rouvre." };
  }
  const qui = await quiClotureLaDemande(id);
  if (!peutCloturer(faitsCloturant(user, req.requesterId), qui)) return { ok: false, error: refusCloture(qui) };

  const fait = await prisma.sponsoringRequest.updateMany({
    where: { id, status: "CLOSED", closedAt: { not: null } },
    data: {
      status: "PRE_VALIDATED",
      amountGranted: null, closedAt: null, closedById: null, closingNote: null,
      validatedBy: null, validationDate: null,
      updatedById: user.id,
    },
  });
  if (fait.count === 0) return { ok: false, error: "La demande a changé entre-temps : rechargez la fiche." };

  const ancien = req.amountGranted != null ? ` (montant clôturé : ${toNumber(req.amountGranted).toLocaleString("fr-FR")} DZD)` : "";
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Sponsoring", entityType: "SPONSORING", entityId: id,
    summary: `Clôture rouverte — ${req.reference}${ancien} — motif : ${motif}`,
  });
  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({
      userId: req.requesterId, type: "SPONSORING_VALIDATION", title: "Sponsoring rouvert",
      body: `${req.reference} — ${req.institution} : ${motif}`, link: `${PATH}/${id}`,
    }).catch(() => undefined);
  }
  revalidate(id);
  return { ok: true, id };
}

// ─────────────── Les anciennes décisions HORS circuit ont disparu (§118.151) ───────────────
//
// `sponsoringPreliminary`, `sponsoringAnalysis` et `sponsoringFinal` écrivaient le statut d'un
// sponsoring DIRECTEMENT, sans le moteur de circuit : préliminaire, analyse, puis un accord avec
// montant global et déclaration. Seul Adam les atteignait encore (aucun écran). Depuis que la
// Direction Marketing PRÉ-VALIDE la tenue et que l'argent se décide poste par poste puis à la
// clôture, `sponsoringFinal` était une porte ouverte à côté de la porte gardée (§118.71) : un
// accord global qui sautait la pré-validation, les postes et la clôture, et payait la dépense une
// seconde fois à côté des postes. Adam conduit le circuit par `advance_workflow` — le moteur, ses
// gardes, son tamis — et clôture par `close_sponsoring`.

// ─────────────────── Implication d'une tierce personne (via son espace) ───────────────────

/**
 * Implique une tierce personne (ex. l'assistante de direction) dans le circuit
 * SANS lui donner accès au module : on crée une **demande de validation directe**
 * (cf. module « Demandes de validations ») qu'elle traite depuis SON espace.
 */
export async function requestThirdPartyInput(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const personId = fdStr(formData, "personId");
  if (!id || !personId) return { ok: false, error: "Indiquez la personne à impliquer." };
  const req = await prisma.sponsoringRequest.findUnique({ where: { id } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  const isActor = hasGlobalView(user) || canDoPreliminary(user) || req.productManagerId === user.id || req.requesterId === user.id;
  if (!isActor) return { ok: false, error: "Non autorisé." };

  // Espace de la personne : demande de validation + dossier de suivi indiquant
  // l'événement (SANS budget). Elle traite sans accès au module Ad & Pro.
  const res = await involveThirdParty({
    actorId: user.id,
    personId,
    eventLabel: `Sponsoring ${req.reference} — ${req.institution}`,
    moduleLabel: "Ad & Pro",
    note: fdStr(formData, "note"),
    sourceType: "SPONSORING",
    sourceId: id,
  });
  if (!res.ok) return { ok: false, error: res.error };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sponsoring", entityType: "SPONSORING", entityId: id, summary: `Tierce personne impliquée — ${req.reference}` });
  revalidate(id);
  return { ok: true };
}

// ───────────────────────────── Appel du délégué (→ nouvel avis Direction Marketing) ─────────────────────────────

export async function sponsoringAppeal(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const req = await prisma.sponsoringRequest.findUnique({ where: { id } });
  if (!req) return { ok: false, error: "Demande introuvable." };
  // L'appel est ouvert au demandeur (délégué) une fois la décision rendue.
  if (req.requesterId !== user.id && !hasGlobalView(user)) return { ok: false, error: "Seul le demandeur peut faire appel." };
  if (req.status !== "APPROVED" && req.status !== "REFUSED") return { ok: false, error: "L'appel n'est possible qu'après la décision de la Direction." };

  const reason = fdStr(formData, "reason");
  if (!reason) return { ok: false, error: "Précisez le motif de votre appel." };

  // L'APPEL REVIENT À L'ÉTAPE QUI A TRANCHÉ (audit 360°, R04 — §118.186). Le circuit rouvrait sur sa
  // deuxième étape — la porte du DG depuis l'inversion du circuit —, sans notification, pendant que
  // l'écran promettait un nouvel examen de la Direction Marketing. Le moteur rouvre sur l'étape qui
  // a rendu la décision contestée, la prévient (rôle et référents de la gamme), et dit laquelle.
  //
  // Le circuit d'ABORD : s'il ne se rouvre pas (un autre appel vient de passer, ou la décision n'est
  // pas celle qu'on a lue), la demande n'est pas marquée « en appel » pour un réexamen qui n'aura
  // pas lieu.
  const { etape, rolesPrevenus } = await reopenInstance("SPONSORING", id, { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name }, reason);
  if (!etape) return { ok: false, error: "Le circuit de cette demande n'a pas pu être rouvert (un appel vient peut-être d'être déposé) : rouvrez la fiche." };
  await prisma.sponsoringRequest.update({
    where: { id },
    data: { status: "APPEAL_PENDING", appealById: user.id, appealAt: new Date(), appealReason: reason, appealCount: { increment: 1 }, updatedById: user.id },
  });
  // LA DIRECTION EST INFORMÉE de tout appel, comme avant ce lot — sauf les rôles que l'étape qui
  // tranche vient déjà de prévenir (une demande déposée par la Direction Marketing est tranchée
  // par la Direction : elle ne reçoit pas deux fois le même appel).
  const informes = (["DIRECTION", "SUPER_ADMIN"] as const).filter((r) => !rolesPrevenus.includes(r));
  if (informes.length > 0) {
    await notifyRoles(informes, { type: "SPONSORING_VALIDATION", title: "Sponsoring — appel du demandeur", body: `${req.reference} — ${req.institution} (réexamen : ${etape})`, link: `${PATH}/${id}` });
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: "Sponsoring", entityType: "SPONSORING", entityId: id, summary: `Appel du délégué — ${req.reference} (réexamen : ${etape})` });
  revalidate(id);
  return { ok: true, message: `Appel envoyé — « ${etape} » réexamine la demande.` };
}
