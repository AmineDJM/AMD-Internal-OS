"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { ROLE_DIRECTION_MARKETING } from "@/lib/personnes/roles-vente";
import { notifyUser, notifyRoles } from "@/lib/notify";
import {
  initialStep, nextStep, canValidate, tracksOpen, allTracksDone, pendingTracks, type PromoStep,
  libelleEtape, libelleChantier, PROMO_TRACKS, piloteLExecution, demandeLesDevis,
  type PromoState, type PromoTrack, type VersionCircuit,
} from "@/lib/promo-material/circuit";
import { promoManagerOf } from "@/lib/queries/promo-material";
import { etatApresRenvoi, attendSaCorrection, refusParLeDemandeur, REFUS_EN_CORRECTION } from "@/lib/promo-material/renvoi";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { envoyerDemandeDeDevis, genererLesBonsDeCommande, joindreLettreDeDevis } from "@/lib/promo-automatismes";
import { phraseDepotLettre } from "@/lib/demande-devis-depot";
import {
  contexteDuDossier, validateursDeLaDemande, validateursMarketing, devisLu, SELECT_DEVIS,
} from "@/lib/queries/promo-circuit";
import { totauxDeLaSelection, formatDzd } from "@/lib/promo-material/devis";
import { executionDuDossier } from "@/lib/queries/promo-execution";
import { refusDuChantierPromo } from "@/lib/promo-cloture";
import { notifierSignatairesBC } from "@/lib/bons-de-commande/signataires";
import { lienBonDeCommande } from "@/lib/chemins/bons-de-commande";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { hasGlobalView } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";

/**
 * LE CIRCUIT DU MATÉRIEL PROMOTIONNEL — les transitions de validation, et les chantiers.
 *
 * Deux versions (`promo-material/circuit.ts`) : le circuit court d'origine, que gardent les
 * dossiers déjà en vol, et le circuit par devis retranscrits (§118.152). Toutes les règles (qui
 * valide quoi, ce qui suit quoi, quand les chantiers s'ouvrent) viennent du module pur ; le
 * contexte d'un dossier est lu par `queries/promo-circuit.ts`, le MÊME chargeur que la fiche.
 * Ces actions vérifient QUI agit, écrivent, et préviennent.
 *
 * `validatePromoStep` est l'UNIQUE écrivain des transitions de validation : le choix des lignes
 * du demandeur (`promo-devis-actions.ts`) lui délègue son avance, et Adam y passe par son op.
 * Deux chemins d'avance finiraient par prévenir des personnes différentes pour la même étape.
 */

const PATH = "/promo-material";
const path = (id: string) => `${PATH}/${id}`;
/** La phrase de toute écriture qui trouve le dossier passé à une autre étape entre sa lecture et son écriture. */
const ETAPE_CHANGEE = "Ce dossier vient de changer d'étape — rechargez la fiche.";
/**
 * Ce que l'écran a envoyé n'est plus la sélection : un autre choix s'est enregistré entre l'envoi et la
 * validation. Valider la sélection du moment ferait valider ce que la personne n'a pas vu (§118.187).
 */
const CHOIX_CHANGE = "La sélection a changé pendant votre validation (un autre onglet, ou un déblocage du Super Admin) : rien n'a été validé — rechargez la fiche, vérifiez les lignes retenues, puis validez.";
/** Le refus d'une écriture qui a perdu la course — levé dans la transaction pour l'annuler entière, rattrapé à sa sortie. */
class RefusEtape extends Error {}

/** Les chantiers clos, lus depuis la colonne (liste séparée par des virgules). */
function readTracks(raw: string | null): PromoTrack[] {
  const set = new Set((raw ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  return PROMO_TRACKS.filter((t) => set.has(t));
}

/**
 * BASCULE un dossier d'avant la réforme sur le circuit ACTUEL (circuit 2, §118.152).
 *
 * Il démarre exactement comme une demande nouvelle : le validateur de la demande est figé
 * maintenant (N+1 plafonné, ou directrice marketing), puis les devis sont demandés et
 * retranscrits. Le dossier ancien n'avait jamais été validé par personne : l'y dispenser le
 * ferait passer, à la bascule, à côté de la seule validation que la nouvelle règle impose avant
 * la dépense. Le champ `hasQuote` n'a plus d'effet — un devis en main se remet à l'assistante,
 * qui le retranscrit comme les autres.
 */
export async function startPromoCircuit(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };

  const item = await prisma.promoMaterial.findUnique({
    where: { id }, select: { id: true, title: true, reference: true, requesterId: true, circuitState: true },
  });
  if (!item) return { ok: false, error: "Dossier introuvable." };
  if (item.circuitState) return { ok: false, error: "Le circuit est déjà lancé sur ce dossier." };
  if (!(user.id === item.requesterId || hasGlobalView(user.role))) {
    return { ok: false, error: "Seuls le demandeur et la Direction basculent ce dossier sur le nouveau circuit." };
  }

  const requesterId = item.requesterId ?? user.id;
  const figes = await validateursDeLaDemande(requesterId);
  const validation = figes.validateur.kind !== "AUCUNE";
  const state = initialStep({ ctx: { version: 2, validationDemande: validation, demandeurEstDirectionMarketing: figes.demandeurEstCheffe, montant: null, seuilDg: null } });
  const managerId = await promoManagerOf(requesterId);

  const bascule = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: null },
    data: {
      circuitState: state, circuitVersion: 2, managerId, requesterId, updatedById: user.id,
      requestValidation: validation,
      requestValidatorId: figes.validateur.kind === "PERSONNE" ? figes.validateur.userId : null,
      marketingValidatorId: figes.directriceId,
    },
  });
  if (bascule.count === 0) return { ok: false, error: "Le circuit vient d'être lancé sur ce dossier." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: `Dossier basculé sur le nouveau circuit — ${libelleEtape(state, 2)}. ${figes.validateur.motif}`,
  });
  // PRÉVENIR CELUI QUI VALIDE LA DEMANDE — la personne figée, ou la Direction des opérations.
  const avis = { type: "VALIDATION_REQUIRED" as const, title: "Matériel promotionnel — demande à valider", body: `${item.reference} — ${item.title}`, link: path(id) };
  if (figes.validateur.kind === "PERSONNE") await notifyUser({ userId: figes.validateur.userId, ...avis });
  else if (figes.validateur.kind === "PLAFOND") await notifyRoles(["DIRECTION"], avis);
  revalidatePath(path(id));
  return { ok: true, message: `Dossier basculé sur le nouveau circuit — ${libelleEtape(state, 2)}.` };
}

/**
 * Le devis est arrivé — l'étape « Devis demandé » se ferme, la validation du demandeur s'ouvre.
 *
 * `canValidate` refuse exprès QUOTE_REQUESTED (« il faut d'abord déposer un devis ») : cette
 * transition-là passe donc par ici, et par personne d'autre que le demandeur, l'assistante
 * assignée, la Direction ou le Super Admin. On demande que le devis soit DÉPOSÉ dans les pièces —
 * fermer l'étape sans devis referait exactement le mensonge de l'ancien circuit.
 */
export async function markQuoteReceived(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };

  const item = await prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, title: true, reference: true, circuitState: true, circuitVersion: true, requesterId: true, assistantId: true },
  });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };
  if (item.circuitState !== "QUOTE_REQUESTED") return { ok: false, error: "Ce dossier n'attend pas de devis." };
  // AU CIRCUIT 2, « devis reçu » n'est pas un clic : c'est la fin de la RETRANSCRIPTION, qui
  // exige le fournisseur, le scan et les lignes de chaque devis (§118.152). Le laisser passer ici
  // ouvrirait le choix du demandeur sur un tableau vide.
  if (item.circuitVersion === 2) {
    return { ok: false, error: "Au nouveau circuit, les devis se RETRANSCRIVENT : l'assistante les saisit ligne à ligne sur la fiche, puis déclare la retranscription terminée." };
  }

  const allowed = user.id === item.requesterId || user.id === item.assistantId
    || user.role === "DIRECTION" || user.role === "SUPER_ADMIN";
  if (!allowed) return { ok: false, error: "Seul le demandeur ou l'assistante peut confirmer la réception du devis." };

  const hasQuoteDoc = await prisma.document.count({
    where: { entityType: "PROMO_MATERIAL", entityId: id },
  });
  if (hasQuoteDoc === 0) {
    return { ok: false, error: "Déposez d'abord le devis dans les documents du dossier — confirmer sans pièce n'avance à rien." };
  }

  // CONDITIONNELLE sur l'étape et la version LUES (vague « restes ») : deux confirmations croisées
  // n'écrivent pas deux fois « devis reçu » ni ne préviennent deux fois le demandeur, et un dossier
  // refusé, annulé ou basculé entre-temps ne repasse pas « au tour du demandeur ».
  const ecrite = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: "QUOTE_REQUESTED", circuitVersion: item.circuitVersion },
    data: { circuitState: "REVIEW_REQUESTER", updatedById: user.id },
  });
  if (ecrite.count === 0) return { ok: false, error: ETAPE_CHANGEE };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: "Devis reçu — au tour du demandeur de le valider",
  });
  if (item.requesterId && item.requesterId !== user.id) {
    await notifyUser({ userId: item.requesterId, type: "VALIDATION_REQUIRED", title: "Devis reçu — à valider", body: `${item.reference} — ${item.title}`, link: path(id) });
  }
  revalidatePath(path(id));
  return { ok: true, message: "Devis enregistré — au tour du demandeur de le valider." };
}


/** Ce que la lecture d'un dossier doit charger pour valider ou refuser son étape. */
const SELECT_ETAPE = {
  id: true, title: true, reference: true, circuitState: true, circuitVersion: true,
  requesterId: true, managerId: true, requestValidatorId: true, requestValidation: true, marketingValidatorId: true,
  chosenAmount: true, amount: true, returnedAt: true, returnNote: true,
} as const;

/**
 * LES VALIDATEURS DE L'ÉTAPE EN COURS, pour `canValidate` — la personne figée de la demande, et,
 * à l'étape de la Direction Marketing du circuit 2, la directrice du demandeur ou les cheffes lues
 * maintenant. Le circuit 1 garde le RÔLE (la décision de 09/2026, §118.138).
 */
async function validateursDeLEtape(
  item: { circuitState: string | null; circuitVersion: number; requesterId: string | null; managerId: string | null; requestValidatorId: string | null; marketingValidatorId: string | null },
  secondaryRole: string | null | undefined,
) {
  return {
    requesterId: item.requesterId,
    managerId: item.managerId,
    requestValidatorId: item.requestValidatorId,
    validateursMarketing: item.circuitVersion === 2 && item.circuitState === "REVIEW_MANAGER" ? await validateursMarketing(item) : null,
    secondaryRole,
  };
}

/**
 * Valide l'étape en cours et passe à la suivante.
 *
 * Le contrôle de QUI peut valider vient du module pur ; le contexte (version, montant, seuil) du
 * MÊME chargeur que la fiche. Au circuit 2, valider le choix du demandeur FIGE le montant retenu
 * (TTC des lignes cochées) et les fournisseurs : c'est ce montant que la Direction Marketing
 * valide, et ce que le seuil du DG juge.
 *
 * La transition est CONDITIONNELLE (`updateMany` sur l'état lu) : deux validateurs qui cliquent
 * ensemble ne font pas avancer le dossier deux fois, ni ne préviennent deux fois l'étape suivante.
 *
 * LE CHOIX DU DEMANDEUR SE LIT SOUS LE VERROU DU DOSSIER (lot D1b). La sélection, le montant qu'on fige et la
 * porte du DG qu'il ouvre se lisaient AVANT l'écriture conditionnelle — qui ne regardait que l'étape : un choix
 * enregistré entre les deux (un autre onglet, un déblocage du Super Admin) faisait partir le dossier avec un
 * montant figé sur une sélection qui n'était plus celle des lignes cochées, donc des bons de commande. La
 * transaction prend le verrou, relit l'étape, puis la sélection ; toute écriture de la sélection prend le même
 * verrou en premier (`choisirLignesPromo`, la correction). `lignesVues` — ce que `choisirLignesPromo` vient
 * d'enregistrer — n'est validé que s'il est encore la sélection : un accord ne couvre pas plus que ce qu'il a
 * vu (§118.187).
 */
export async function validatePromoStep(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };

  const item = await prisma.promoMaterial.findUnique({ where: { id }, select: SELECT_ETAPE });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };

  const state = item.circuitState as PromoState;
  const version: VersionCircuit = item.circuitVersion === 2 ? 2 : 1;
  // RENVOYÉE pour correction à la validation de la demande : la balle est chez le demandeur (§118.190).
  if (state === "REVIEW_REQUEST" && attendSaCorrection(item)) return { ok: false, error: REFUS_EN_CORRECTION };
  if (!canValidate(user, state, await validateursDeLEtape(item, user.secondaryRole))) {
    return { ok: false, error: `Cette étape ne vous revient pas — elle attend : ${libelleEtape(state, version)}.` };
  }

  const choixDuDemandeur = version === 2 && state === "REVIEW_REQUESTER";
  const vues = formData.getAll("lignesVues").map((x) => String(x)).filter(Boolean);
  const lignesVues = vues.length > 0 ? new Set(vues) : null;
  const ctxLu = await contexteDuDossier(item);

  let resultat: { fige: { chosenAmount: number; chosenAgency: string } | null; next: PromoStep };
  try {
    resultat = await prisma.$transaction(async (tx) => {
      let fige: { chosenAmount: number; chosenAgency: string } | null = null;
      let ctx = ctxLu;
      // LE CHOIX DU DEMANDEUR (circuit 2) : sans ligne retenue, il n'y a rien à valider — et le montant
      // retenu devient celui du dossier, avec les fournisseurs dont une ligne est retenue.
      if (choixDuDemandeur) {
        const [etat] = await tx.$queryRaw<{ circuitState: string | null; circuitVersion: number }[]>`
          SELECT "circuitState", "circuitVersion" FROM "PromoMaterial" WHERE id = ${id} FOR UPDATE`;
        // L'ÉTAPE D'ABORD (§118.18) : un dossier reparti chez l'assistante pendant qu'on attendait ne se fait pas
        // répondre « retenez au moins une ligne » parce que la correction a effacé la sélection.
        if (!etat || etat.circuitVersion !== 2 || etat.circuitState !== "REVIEW_REQUESTER") throw new RefusEtape(ETAPE_CHANGEE);
        const devis = (await tx.promoQuote.findMany({
          where: { promoMaterialId: id }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: SELECT_DEVIS,
        })).map(devisLu);
        if (lignesVues) {
          const retenues = devis.flatMap((d) => d.lines.filter((l) => l.selected).map((l) => l.id));
          if (retenues.length !== lignesVues.size || retenues.some((x) => !lignesVues.has(x))) throw new RefusEtape(CHOIX_CHANGE);
        }
        const totaux = totauxDeLaSelection(devis);
        if (totaux.lignes === 0) throw new RefusEtape("Retenez au moins une ligne de devis avant de valider votre choix.");
        const fournisseurs = devis.filter((d) => d.lines.some((l) => l.selected)).map((d) => d.supplierName);
        fige = { chosenAmount: totaux.ttc, chosenAgency: fournisseurs.join(", ") };
        // Le montant du contexte EST celui qu'on fige — la règle de `contexteDuDossier` (le TTC des lignes
        // retenues), appliquée à la sélection lue sous le verrou : lue avant, elle pouvait ouvrir ou fermer la
        // porte du DG sur un autre choix que celui qu'on fige.
        ctx = { ...ctxLu, montant: totaux.ttc };
      }
      const next = nextStep(state as PromoStep, ctx);
      if (!next) throw new RefusEtape("Ce dossier est au bout de son circuit.");
      // AVANCER RÉPOND AU RENVOI (§118.190) : le choix revalidé, la marque et son motif s'effacent — ils
      // restent au fil et au journal. Une avance qui les laisserait ferait relire « À corriger » à
      // chaque étape suivante, sur un dossier que plus personne n'a à corriger.
      const avance = await tx.promoMaterial.updateMany({
        where: { id, circuitState: state },
        data: {
          circuitState: next, updatedById: user.id, ...(fige ?? {}),
          returnedAt: null, returnedById: null, returnNote: null, returnedFrom: null,
        },
      });
      if (avance.count === 0) throw new RefusEtape(ETAPE_CHANGEE);
      return { fige, next };
    }, { timeout: 15_000, maxWait: 15_000 });
  } catch (e) {
    if (e instanceof RefusEtape) return { ok: false, error: e.message };
    throw e;
  }
  const { fige, next } = resultat;
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: `${libelleEtape(state, version)} — validé${fige ? ` (montant retenu ${formatDzd(fige.chosenAmount)} TTC — ${fige.chosenAgency})` : ""}. Étape suivante : ${libelleEtape(next, version)}`,
  });

  // LES AUTOMATISMES (§118.204) — la demande de devis part quand la demande est validée, et les bons de
  // commande sont générés quand la DERNIÈRE validation du choix tombe. Après l'avance, jamais avant : un
  // automatisme qui échoue ne retire pas la validation qu'on vient de donner, il le DIT, et le repli (la
  // rubrique « Articles demandés », la carte « Exécution ») reste là pour le rattraper.
  let suiteAuto: string | null = null;
  let devisPartis = false;
  if (version === 2 && next === "QUOTE_TO_REQUEST") {
    const envoi = await envoyerDemandeDeDevis(user.id, id);
    if (envoi.ok) {
      devisPartis = true;
      if (envoi.assistantId) await notifyUser({ userId: envoi.assistantId, ...envoi.avis });
      else await notifyRoles(["DIRECTION_ASSISTANT"], envoi.avis);
      // LA LETTRE (Direction, 07/10) — rédigée par Luna, en PDF et Word : son échec ne retient pas la demande, il se dit.
      const lettre = await joindreLettreDeDevis(user, id, envoi.demande.id).catch(sansBloquer("promo-circuit-actions.validatePromoStep.joindreLettreDeDevis", null));
      suiteAuto = `La demande de devis est partie au secrétariat (${envoi.demande.reference}).${lettre?.ok ? ` ${phraseDepotLettre(lettre)}` : ""}`;
    } else {
      suiteAuto = `La demande de devis n'est pas partie d'elle-même : ${envoi.error} Le demandeur l'envoie depuis « Articles demandés ».`;
    }
  }
  let bilanBC: Awaited<ReturnType<typeof genererLesBonsDeCommande>> | null = null;
  if (version === 2 && next === "IN_EXECUTION") {
    bilanBC = await genererLesBonsDeCommande(user, id, { livraison: { adresse: null, delai: null }, notes: null, taxe: undefined, automatique: true });
    suiteAuto = bilanBC.ok
      ? bilanBC.message
      : `Les aperçus des bons de commande n'ont pas pu être préparés automatiquement : ${bilanBC.error} Ils se préparent depuis « Bons de commande, réception, factures ».`;
  }

  // On prévient CELUI QUI DOIT AGIR ENSUITE, pas tout le monde.
  const avis = { type: "VALIDATION_REQUIRED" as const, body: `${item.reference} — ${item.title}`, link: path(id) };
  if (next === "QUOTE_TO_REQUEST" && item.requesterId) {
    await notifyUser({
      userId: item.requesterId, ...avis, type: "GENERIC",
      title: devisPartis
        ? "Demande validée — la demande de devis est partie au secrétariat"
        : "Demande validée — envoyez la demande de devis depuis « Articles demandés »",
    });
  } else if (next === "REVIEW_MANAGER") {
    // UNE PERSONNE quand on la sait (la directrice du demandeur, ou les cheffes) ; sinon le RÔLE.
    const nommees = version === 2 ? await validateursMarketing(item) : null;
    if (nommees) {
      for (const userId of nommees) await notifyUser({ userId, ...avis, title: "Devis à valider (Direction Marketing)" });
    } else {
      await notifyRoles([ROLE_DIRECTION_MARKETING], { ...avis, title: "Devis à valider (Direction Marketing)" });
    }
  } else if (next === "REVIEW_DG") {
    await notifyRoles(["GENERAL_MANAGER"], { ...avis, title: "Devis à valider (Directeur Général)" });
  } else if (next === "REVIEW_EXECUTIVE") {
    await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { ...avis, title: "Devis à valider (direction)" });
  } else if (next === "REVIEW_MEDICAL_INFO") {
    await notifyRoles(["MEDICAL_INFO_PHARMACIST"], { ...avis, title: "Matériel à valider" });
  } else if (next === "IN_EXECUTION" && item.requesterId) {
    // Les TROIS chantiers s'ouvrent d'un coup : c'est le moment où le circuit cesse d'être une file.
    await notifyUser({
      userId: item.requesterId, type: "GENERIC",
      title: version === 2 && bilanBC?.ok ? "Validations obtenues — bons de commande à vérifier et valider" : "Validations obtenues — vous pouvez lancer",
      body: version === 2
        ? `${item.reference} — ${suiteAuto ?? "les bons de commande se préparent depuis la fiche du dossier."}`
        : `${item.reference} — bon de commande, demande de paiement et demande de visa peuvent partir en parallèle.`,
      link: path(id),
    });
  }

  revalidatePath(path(id));
  return {
    ok: true,
    message: `Validé. ${next === "IN_EXECUTION"
      ? (version === 2 ? `Les validations sont obtenues. ${suiteAuto ?? ""}`.trim() : "Les trois chantiers sont ouverts.")
      : suiteAuto ?? `Au tour de : ${libelleEtape(next, version)}.`}`,
  };
}

/** Refuse le dossier — le circuit s'arrête, avec son motif. */
export async function refusePromoStep(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };

  // L'ÉTAT D'ABORD, LE MOTIF ENSUITE (§118.18, §118.189) : on ne demande pas pourquoi refuser ce
  // qui ne se refuse pas d'ici — la personne écrirait son motif pour apprendre ensuite que rien ne
  // pouvait partir.
  const item = await prisma.promoMaterial.findUnique({ where: { id }, select: SELECT_ETAPE });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };
  const state = item.circuitState as PromoState;
  const version: VersionCircuit = item.circuitVersion === 2 ? 2 : 1;
  const propre = refusParLeDemandeur(user, item);
  if (propre) return { ok: false, error: propre };
  if (state === "REVIEW_REQUEST" && attendSaCorrection(item)) return { ok: false, error: REFUS_EN_CORRECTION };
  if (!canValidate(user, state, await validateursDeLEtape(item, user.secondaryRole))) {
    return { ok: false, error: "Cette étape ne vous revient pas." };
  }
  const reason = (fdStr(formData, "reason") ?? "").trim();
  if (!reason) return { ok: false, error: "Dites pourquoi : un refus sans motif fait recommencer à l'identique." };

  const refus = await prisma.promoMaterial.updateMany({ where: { id, circuitState: state }, data: { circuitState: "REFUSED", updatedById: user.id } });
  if (refus.count === 0) return { ok: false, error: "Ce dossier vient de changer d'étape — rechargez la fiche." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: `Refusé à l'étape « ${libelleEtape(state, version)} » — ${reason.slice(0, 200)}`,
  });
  if (item.requesterId) {
    await notifyUser({ userId: item.requesterId, type: "GENERIC", title: "Matériel promotionnel refusé", body: `${item.reference} — ${reason.slice(0, 200)}`, link: path(id) });
  }
  revalidatePath(path(id));
  return { ok: true, message: "Refus enregistré." };
}

/**
 * RENVOYER LE DOSSIER POUR CORRECTION (audit 360°, lot C4b, R05) — la troisième issue, entre valider
 * et refuser. Ouverte là où le refus l'est (`canValidate`), à une étape qu'un AUTRE que le demandeur
 * tranche (`renvoiPossible`) ; le motif est exigé, APRÈS les refus d'état (§118.18).
 *
 * La validation de la DEMANDE se corrige sur place (la marque dit que la balle a changé de camp) ; une
 * validation du CHOIX renvoie au choix des lignes, et revalider repasse par toutes les validations —
 * un accord ne couvre pas plus que ce qu'il a vu (§118.187).
 *
 * L'écriture est CONDITIONNELLE sur l'étape lue (et, à l'étape 0, sur l'absence de marque) : deux
 * validateurs qui renvoient ensemble n'écrivent qu'un motif, et un renvoi croisé avec une validation
 * n'en garde qu'un — c'est la condition, pas l'ordre des clics, qui tranche.
 */
export async function renvoyerPromoStep(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  const item = await prisma.promoMaterial.findUnique({ where: { id }, select: SELECT_ETAPE });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };
  const state = item.circuitState as PromoState;
  const version: VersionCircuit = item.circuitVersion === 2 ? 2 : 1;
  if (state === "REVIEW_REQUEST" && attendSaCorrection(item)) return { ok: false, error: REFUS_EN_CORRECTION };
  const cible = etatApresRenvoi(state);
  if (!cible) {
    return { ok: false, error: `L'étape « ${libelleEtape(state, version)} » ne se renvoie pas : seule une validation tranchée par quelqu'un d'autre que le demandeur se renvoie pour correction.` };
  }
  if (!canValidate(user, state, await validateursDeLEtape(item, user.secondaryRole))) {
    return { ok: false, error: "Cette étape ne vous revient pas." };
  }
  const motif = fdStr(formData, "motif");
  if (motif === null) return { ok: false, error: "Dites ce qu'il faut corriger : un renvoi sans motif fait deviner le demandeur." };

  const renvoi = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: state, ...(state === "REVIEW_REQUEST" ? { returnedAt: null } : {}) },
    data: { circuitState: cible, returnedAt: new Date(), returnedById: user.id, returnNote: motif, returnedFrom: state, updatedById: user.id },
  });
  if (renvoi.count === 0) return { ok: false, error: "Ce dossier vient de changer d'étape — rechargez la fiche." };
  await ecrireAuFil({
    entityType: "PROMO_MATERIAL", entityId: id, authorId: user.id,
    body: `Renvoyé pour correction à l'étape « ${libelleEtape(state, version)} » : ${motif}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: `Renvoyé pour correction à l'étape « ${libelleEtape(state, version)} » — ${motif.slice(0, 200)}`,
  });
  if (item.requesterId && item.requesterId !== user.id) {
    await notifyUser({
      userId: item.requesterId, type: "GENERIC", title: "Matériel promotionnel — à corriger",
      body: `${item.reference} — ${motif.slice(0, 200)}`, link: path(id),
    });
  }
  revalidatePath(path(id));
  return {
    ok: true,
    message: cible === "REVIEW_REQUEST"
      ? "Renvoyé au demandeur : il corrige sa demande, puis vous la resoumet."
      : "Renvoyé au demandeur : il refait son choix de lignes, qui repassera par les validations.",
  };
}

/**
 * RESOUMETTRE LA DEMANDE CORRIGÉE (étape 0 du circuit 2, §118.190) — au validateur qui l'a renvoyée.
 *
 * Son demandeur seul (ou la Direction en suppléance, `demandeLesDevis`), en disant ce qui a changé :
 * sans cela, le validateur relirait tout pour trouver la différence. La marque s'efface ; le renvoi et
 * la correction vont au fil, où ils restent. L'écriture est conditionnelle : deux resoumissions
 * simultanées n'en font qu'une.
 */
export async function resoumettrePromoDemande(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  const item = await prisma.promoMaterial.findUnique({ where: { id }, select: { ...SELECT_ETAPE, returnedFrom: true } });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };
  if (!demandeLesDevis({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) }, item)) {
    return { ok: false, error: "Seul le demandeur (ou la Direction) resoumet ce dossier." };
  }
  if (item.circuitState !== "REVIEW_REQUEST" || !attendSaCorrection(item)) {
    return { ok: false, error: "Ce dossier n'est pas à corriger : il n'y a rien à resoumettre." };
  }
  const correction = fdStr(formData, "note");
  if (correction === null) return { ok: false, error: "Dites ce qui a changé : le validateur relirait sinon toute la demande pour le trouver." };

  const reprise = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: "REVIEW_REQUEST", returnedAt: { not: null } },
    data: { returnedAt: null, returnedById: null, returnNote: null, returnedFrom: null, updatedById: user.id },
  });
  if (reprise.count === 0) return { ok: false, error: "Ce dossier vient de changer : rouvrez sa fiche." };
  const quand = item.returnedAt ? new Date(item.returnedAt).toLocaleDateString("fr-FR") : null;
  await ecrireAuFil({
    entityType: "PROMO_MATERIAL", entityId: id, authorId: user.id,
    body: `Resoumis après correction.${quand ? ` Le renvoi du ${quand} demandait : « ${item.returnNote ?? ""} ».` : ""} Ce qui a changé : ${correction}`,
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id, summary: `Resoumis après correction — ${correction.slice(0, 200)}`,
  });
  const avis = { type: "VALIDATION_REQUIRED" as const, title: "Matériel promotionnel — demande corrigée, à valider", body: `${item.reference} — ${correction.slice(0, 200)}`, link: path(id) };
  if (item.requestValidatorId) await notifyUser({ userId: item.requestValidatorId, ...avis });
  else await notifyRoles(["DIRECTION"], avis);
  revalidatePath(path(id));
  return { ok: true, message: "Demande resoumise : elle revient à la personne qui l'a renvoyée." };
}

/**
 * Clôt l'un des trois chantiers parallèles.
 *
 * Ils avancent indépendamment — c'est tout l'intérêt. Mais le dossier n'est terminé que lorsque
 * le DERNIER l'est : sans cette règle, on classerait une commande dont le visa n'est jamais arrivé.
 */
export async function completePromoTrack(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const track = fdStr(formData, "track") ?? "";
  if (!id) return { ok: false, error: "Dossier introuvable." };
  if (!(PROMO_TRACKS as readonly string[]).includes(track)) return { ok: false, error: "Chantier inconnu." };

  const item = await prisma.promoMaterial.findUnique({
    where: { id },
    select: { id: true, title: true, reference: true, circuitState: true, circuitVersion: true, tracksDone: true, requesterId: true },
  });
  if (!item || !item.circuitState) return { ok: false, error: "Le circuit n'est pas lancé sur ce dossier." };
  const version: VersionCircuit = item.circuitVersion === 2 ? 2 : 1;
  // QUI PILOTE LES CHANTIERS — la même règle que l'écran (`canDrive` de la fiche) : le demandeur,
  // l'assistante de direction, la Direction. Cette action ne vérifiait QUE la session : n'importe
  // quel compte pouvait clore le chantier « paiement » d'un dossier qui n'était pas le sien, et
  // l'op d'Adam annonçait « revérifié par l'action » sur une vérification qui n'existait pas.
  const pilote = piloteLExecution({ id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) }, item);
  if (!pilote) return { ok: false, error: "Seuls le demandeur, l'assistante de direction et la Direction pilotent les chantiers de ce dossier." };
  if (!tracksOpen(item.circuitState as PromoState)) {
    return { ok: false, error: "Les chantiers ne s'ouvrent qu'une fois toutes les validations obtenues." };
  }

  const done = readTracks(item.tracksDone);
  if (done.includes(track as PromoTrack)) return { ok: true, message: "Ce chantier est déjà clos." };

  // AU CIRCUIT 2, CHAQUE CHANTIER SE CONSTATE SUR SES PIÈCES (§118.152) ; puis les gardes communes :
  // un BC VALIDÉ PAR SON CENTRE et SIGNÉ (§118.148/149), un paiement RÉGLÉ par le centre de paiement
  // (§118.148). Les MÊMES vérifications que la clôture automatique (`promo-cloture.ts`).
  const refus = await refusDuChantierPromo(id, track as PromoTrack, version);
  if (refus) return { ok: false, error: refus };
  const nextDone = [...done, track as PromoTrack];
  const finished = allTracksDone(nextDone);

  // CONDITIONNELLE SUR CE QUI A ÉTÉ LU (lot D1b) : l'étape ET les chantiers déjà clos. Deux chantiers clos à
  // la même seconde lisaient la même liste et le second effaçait le premier — un chantier clos redevenait
  // ouvert sans que personne l'ait rouvert ; un dossier annulé pendant qu'on clôturait son dernier chantier
  // repassait « terminé ». Les verdicts lus plus haut (BC signés, paiements réglés) portent sur d'autres
  // pièces : leur course est d'une autre nature, et n'est pas fermée ici.
  const ecrit = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: item.circuitState, tracksDone: item.tracksDone },
    data: {
      tracksDone: nextDone.join(","),
      ...(finished ? { circuitState: "COMPLETED" } : {}),
      updatedById: user.id,
    },
  });
  if (ecrit.count === 0) return { ok: false, error: "Ce dossier vient de changer — un autre chantier vient d'être clos, ou son étape a changé : rechargez la fiche." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel",
    entityType: "PROMO_MATERIAL", entityId: id,
    summary: finished
      ? `${libelleChantier(track as PromoTrack, version)} clos — dossier TERMINÉ`
      : `${libelleChantier(track as PromoTrack, version)} clos — reste : ${pendingTracks(nextDone).map((t) => libelleChantier(t, version)).join(", ")}`,
  });

  revalidatePath(path(id));
  return {
    ok: true,
    message: finished
      ? "Dernier chantier clos — le dossier est terminé."
      : `Clos. Reste : ${pendingTracks(nextDone).map((t) => libelleChantier(t, version)).join(", ")}.`,
  };
}

/** Une relance par jour au plus : au-delà, une notification qui revient sans cesse cesse d'être lue (§118.32). */
const DELAI_RELANCE_MS = 24 * 60 * 60 * 1000;

/**
 * RELANCER — la fiche dit « En attente — chez X » ; la personne (ou le service) attendue reçoit un rappel, nommé, avec
 * le lien du dossier. Une fois par jour au plus, par le demandeur, l'assistante, les pilotes de l'exécution ou la Direction.
 * Le destinataire se lit sur l'étape, par les MÊMES règles que les avis du circuit : le validateur de la demande, l'assistante,
 * la Direction Marketing, le Directeur Général ; en exécution, les signataires des BC, le centre, les Finances ou le demandeur.
 */
export async function relancerPromo(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Dossier introuvable." };
  const pm = await prisma.promoMaterial.findUnique({ where: { id } });
  if (!pm || pm.circuitVersion !== 2 || !pm.circuitState) return { ok: false, error: "Ce dossier ne se relance pas d'ici." };
  if (pm.status === "CANCELLED" || pm.circuitState === "REFUSED" || pm.circuitState === "COMPLETED") return { ok: false, error: "Ce dossier n'attend plus personne." };
  const acteur = { id: user.id, role: user.role, secondaryRole: user.secondaryRole, vueGlobale: hasGlobalView(user.role) };
  if (!(pm.requesterId === user.id || pm.assistantId === user.id || piloteLExecution(acteur, pm))) {
    return { ok: false, error: "Seuls le demandeur, l'assistante et la Direction relancent ce dossier." };
  }

  let ids: string[] = [];
  let roles: Parameters<typeof notifyRoles>[0] = [];
  let signataires = false;
  /** Le BC à signer dont on relance la signature : la relance arrive sur sa ligne. */
  let bcASigner: string | null = null;
  let qui = "";
  const etat = pm.circuitState as PromoState;
  if (attendSaCorrection({ circuitState: etat, returnedAt: pm.returnedAt })) {
    ids = pm.requesterId ? [pm.requesterId] : []; qui = "le demandeur";
  } else if (etat === "REVIEW_REQUEST") {
    if (pm.requestValidatorId) { ids = [pm.requestValidatorId]; qui = "le validateur de la demande"; } else { roles = ["DIRECTION"]; qui = "la Direction des opérations"; }
  } else if (etat === "QUOTE_TO_REQUEST" || etat === "REVIEW_REQUESTER") {
    ids = pm.requesterId ? [pm.requesterId] : []; qui = "le demandeur";
  } else if (etat === "QUOTE_REQUESTED") {
    if (pm.assistantId) ids = [pm.assistantId]; else roles = ["DIRECTION_ASSISTANT"];
    qui = "l'assistante de direction";
  } else if (etat === "REVIEW_MANAGER") {
    const nommees = await validateursMarketing(pm);
    if (nommees) ids = nommees; else roles = [ROLE_DIRECTION_MARKETING];
    qui = "la Direction Marketing";
  } else if (etat === "REVIEW_DG") {
    roles = ["GENERAL_MANAGER"]; qui = "le Directeur Général";
  } else if (etat === "IN_EXECUTION") {
    const execution = await executionDuDossier(id);
    const bcs = execution.filter((e) => e.lignesRetenues > 0 && e.bc);
    const factures = execution.flatMap((e) => e.factures);
    if (bcs.some((e) => e.bc?.etape === "A_SIGNER")) { signataires = true; bcASigner = bcs.find((e) => e.bc?.etape === "A_SIGNER")?.bc?.id ?? null; qui = "les Finances (signature des BC)"; }
    else if (bcs.some((e) => e.bc?.etape === "A_VALIDER" || e.bc?.etape === "SANS_PORTE")) { roles = ["GENERAL_MANAGER", "SUPER_ADMIN"]; qui = "le centre de validation"; }
    else if (factures.some((f) => f.paiementDemande && !f.reglee)) { roles = ["FINANCE_BUDGET_MANAGER"]; qui = "les Finances (paiement)"; }
    else { ids = pm.requesterId ? [pm.requesterId] : []; qui = "le demandeur"; }
  } else {
    return { ok: false, error: "Cette étape ne se relance pas d'ici." };
  }
  ids = ids.filter((x) => x !== user.id);
  if (ids.length === 0 && roles.length === 0 && !signataires) return { ok: false, error: "Personne d'autre à relancer : c'est à vous d'agir." };

  // UNE PAR JOUR, ÉCRITE SUR CE QUI A ÉTÉ LU : deux clics croisés ne font pas deux relances.
  const pris = await prisma.promoMaterial.updateMany({
    where: { id, circuitState: pm.circuitState, OR: [{ financeReminderAt: null }, { financeReminderAt: { lt: new Date(Date.now() - DELAI_RELANCE_MS) } }] },
    data: { financeReminderAt: new Date(), financeReminderCount: { increment: 1 } },
  });
  if (pris.count === 0) return { ok: false, error: "Ce dossier a déjà été relancé aujourd'hui, ou vient de changer d'étape." };

  const avis = { type: "LATE" as const, title: `Relance — ${pm.reference}`, body: `${user.name ?? "Le demandeur"} relance : ${pm.title}`, link: path(id) };
  for (const userId of ids) await notifyUser({ userId, ...avis });
  if (roles.length) await notifyRoles(roles, avis);
  if (signataires) await notifierSignatairesBC({ ...avis, link: lienBonDeCommande(bcASigner) });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Matériel promotionnel", entityType: "PROMO_MATERIAL", entityId: id,
    summary: `Relance envoyée à ${qui} (${libelleEtape(etat, 2)}).`,
  });
  revalidatePath(path(id));
  return { ok: true, message: `Relance envoyée à ${qui}.` };
}
