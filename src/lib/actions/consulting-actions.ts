"use server";

import type { ConsultingBilling, ConsultingStatus, Prisma } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, getAccess, type SessionUser, type Action } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { lienLigneCentreAdPro } from "@/lib/chemins/ad-pro";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { companyIdForNew } from "@/lib/company";
import { attachFiles } from "@/lib/attach-files";
import { readMultiField, lireMedecinsDemande } from "@/lib/ad-pro/pickers";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { nextConsultingStatus, isContractEditable } from "@/lib/ad-pro/consulting";
import { ajusterVisaAuMontant, phraseGesteVisa, poserVisaAdPro, blocageCentreAdPro, retirerVisaEnAttente } from "@/lib/ad-pro/visa";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { gammeImposee } from "@/lib/ad-pro/business-unit-auto";
import { toNumber, formatDate } from "@/lib/utils";
import { recordEvent } from "@/lib/events/ledger";
import { reaiguillerLesBCDe, LOT_ORIGINE } from "@/lib/bons-de-commande/aiguillage";
import {
  MODULE_DU_POLE, CHEMIN_LISTE_POLE, LIBELLE_POLE, estPoleConsulting, poleDe, poleOppose,
  transfertAutorise, refusTransfert, type PoleConsulting,
} from "@/lib/lecteurs/consulting";

const PATH = "/consulting";

/**
 * LE CONTRAT DE CONSULTING — un engagement entre DEUX PARTIES.
 *
 * Ce n'est pas une demande qu'on approuve puis qu'on oublie : c'est une relation qui court dans
 * le temps. D'où les gestes offerts ici — soumettre à validation, renvoyer pour correction, activer,
 * prolonger ou clore, annuler — et les tâches attendues du prestataire, qui vivent à part parce que « ce qui reste à
 * livrer » est une question qu'on pose au contrat, et qu'un paragraphe ne sait pas y répondre.
 *
 * QUI PEUT QUOI : le porteur mène son contrat jusqu'à la demande de validation ; seul un
 * VALIDATE sur le module (Direction, ou la personne désignée) l'active ou le refuse. Personne ne
 * valide donc son propre engagement sans en avoir reçu le droit.
 */

function isDirection(user: SessionUser): boolean {
  return hasGlobalView(user.role);
}

/**
 * Le porteur du contrat, ou quelqu'un qui a la vue globale.
 *
 * Être le porteur ne suffit plus quand le contrat a changé de MAISON (§118.150) : le porteur
 * d'un contrat passé aux RH qui n'a pas les RH ne le voit plus à l'écran — la fiche lui répond
 * « introuvable ». Lui laisser ici le droit de le soumettre, de le clore ou d'en cocher les tâches
 * ferait de l'action une porte ouverte à côté de la porte fermée (§118.71). La désignation n'est
 * pas une permission qui survit à son motif (§118.136) : on relit le module du pôle.
 */
function owns(user: SessionUser, c: { requesterId: string | null; createdById: string | null; pole: unknown }): boolean {
  if (isDirection(user)) return true;
  return (c.requesterId === user.id || c.createdById === user.id) && peutSurLeContrat(user, c, "VIEW");
}

async function nextRef(): Promise<string> {
  const year = new Date().getFullYear();
  return referenceDeSerie({
    modele: "ConsultingContract", prefixe: "CONS", annee: year,
    existantes: async () => (await prisma.consultingContract.findMany({ where: { reference: { startsWith: `CONS-${year}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  revalidatePath("/ad-pro");
  // Les deux listes : un contrat peut vivre dans l'une ou l'autre (§118.150), et un transfert
  // les touche toutes les deux.
  revalidatePath(CHEMIN_LISTE_POLE.RH);
  if (id) revalidatePath(`${PATH}/${id}`);
}

/**
 * LE MODULE QUI GARDE CE CONTRAT — lu sur son PÔLE (§118.150), jamais `CONSULTING` en dur : une
 * garde qui relirait le module d'Ad & Pro laisserait la promotion modifier le contrat d'un
 * consultant passé aux RH, et en fermerait la gestion aux RH qui le suivent.
 */
function moduleDe(c: { pole: unknown }) {
  return MODULE_DU_POLE[poleDe(c.pole)];
}

/**
 * LE DROIT SUR CE CONTRAT — celui du module de SON pôle, pour ce geste.
 *
 * NOMMÉ, et non `userCan(user, moduleDe(c), …)` écrit en ligne : la dérivation des contrats
 * d'action ne reconnaît une garde que par son NOM ou par un module LITTÉRAL. Un module calculé
 * faisait sortir cinq actions « gardées par rien » sur la carte de confirmation, alors qu'elles
 * le sont — le défaut que §118.136 et §118.140 ont déjà payé. Le préfixe `peut…` est lu.
 */
function peutSurLeContrat(user: SessionUser, c: { pole: unknown }, action: Action): boolean {
  return userCan(user, moduleDe(c), action);
}

async function audit(user: SessionUser, id: string, action: "CREATE" | "UPDATE" | "VALIDATE" | "DELETE", summary: string) {
  await recordAudit({ actorId: user.id, action, module: "Consulting", entityType: "CONSULTING_CONTRACT", entityId: id, summary });
}

function billingOf(raw: string | null): ConsultingBilling {
  const allowed: ConsultingBilling[] = ["ONE_OFF", "MONTHLY", "QUARTERLY", "YEARLY", "ON_DELIVERY"];
  return allowed.includes(raw as ConsultingBilling) ? (raw as ConsultingBilling) : "ONE_OFF";
}

const dateOf = (raw: string | null): Date | null => {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
};

// ───────────────────────── Création ─────────────────────────

export async function createConsultingContract(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUserAuNomDeLaVue();
    // LE PÔLE DE NAISSANCE : Ad & Pro par défaut ; les RH créent leurs contrats de consultant
    // depuis RH › Consultants (§118.150). Le droit est celui du module du pôle choisi — un champ
    // forgé ne fait pas créer un contrat RH à qui n'a pas les RH.
    const poleBrut = fdStr(formData, "pole");
    const pole: PoleConsulting = estPoleConsulting(poleBrut) ? poleBrut : "AD_PRO";
    if (!peutSurLeContrat(user, { pole }, "CREATE")) return { ok: false, error: "Création réservée aux personnes habilitées." };
    // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.

    const title = fdStr(formData, "title");
    const counterparty = fdStr(formData, "counterparty");
    if (!title) return { ok: false, error: "L'intitulé du contrat est obligatoire." };
    // Un contrat sans co-contractant n'est pas un contrat : c'est une note.
    if (!counterparty) return { ok: false, error: "Indiquez le consultant ou le cabinet — un contrat a deux parties." };

    const startDate = dateOf(fdStr(formData, "startDate"));
    const endDate = dateOf(fdStr(formData, "endDate"));
    if (startDate && endDate && endDate < startDate) {
      return { ok: false, error: "La date de fin ne peut pas précéder la date de début." };
    }

    // Les tâches arrivent en une saisie par ligne : c'est ainsi qu'on les dicte, et découper à
    // la main dans un formulaire aurait tout l'air d'une corvée.
    const tasks = (fdStr(formData, "tasks") ?? "")
      .split("\n").map((t) => t.trim()).filter(Boolean).slice(0, 60);

    const companyId = fdStr(formData, "companyId") || (await companyIdForNew(user.id));
    const gammeAImposer = await gammeImposee(user, fdStr(formData, "businessUnitId") || null);
    // LE PRATICIEN ET LE PRODUIT CONCERNÉS — lus par le lecteur canonique des six natures.
    // Facultatifs ici (`REFERENTIELS_PAR_NATURE`) : un accompagnement réglementaire n'a pas de
    // praticien, et exiger un choix qui n'existe pas serait un refus à tort (§118.27).
    const couple = {
      medecins: lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor")),
      produits: readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product")),
    };

    // La référence se recalcule à CHAQUE tentative : c'est ce qui rend le réessai utile quand
    // deux contrats partent en même temps.
    const contract = await createWithRetry(async () =>
      prisma.consultingContract.create({
        data: {
          reference: await nextRef(),
          pole,
          // LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé. Le
          // formulaire l'exigeait depuis que les gammes existent ; ni le modèle ni cette action
          // ne l'avaient, donc le choix imposé au demandeur était JETÉ (§118.140).
          // Côté RH, ni gamme, ni praticien, ni produit : ce sont des faits de PROMOTION, et un
          // contrat RH ne pèse sur aucun budget Ad & Pro.
          // Lue d'abord SUR LE DEMANDEUR (`gammeImposee`) : le champ ne lui est plus proposé quand
          // sa gamme se déduit, et une valeur postée n'entre pas en ligne de compte pour lui.
          businessUnitId: pole === "AD_PRO" ? gammeAImposer : null,
          doctor: pole === "AD_PRO" ? couple.medecins : null,
          product: pole === "AD_PRO" ? couple.produits : null,
          title,
          counterparty,
          counterpartyContact: fdStr(formData, "counterpartyContact"),
          companyId: companyId || null,
          scope: fdStr(formData, "scope"),
          startDate, endDate,
          amount: fdNum(formData, "amount") ?? null,
          billing: billingOf(fdStr(formData, "billing")),
          paymentTerms: fdStr(formData, "paymentTerms"),
          notes: fdStr(formData, "notes"),
          status: "DRAFT",
          requesterId: user.id,
          createdById: user.id,
          updatedById: user.id,
          tasks: { create: tasks.map((label, i) => ({ label, position: i })) },
        },
      }),
    );

    // Les pièces déposées à la saisie sont rattachées tout de suite : un contrat sans son
    // exemplaire signé n'est qu'une note.
    const attached = await attachFiles({
      files: formData.getAll("files").filter((f): f is File => f instanceof File),
      entityType: "CONSULTING_CONTRACT", entityId: contract.id, uploadedById: user.id, category: "CONVENTION",
    });

    await audit(user, contract.id, "CREATE", `Contrat de consulting créé — ${contract.reference} (${counterparty})${attached.saved > 0 ? ` (${attached.saved} pièce(s))` : ""}`);

    // LE FAIT MÉTIER, inscrit au registre transverse — et c'est lui qui règle le défaut réel :
    // une tâche « Déposer le contrat de la consultante dans Ad&Pro > Consulting » est restée
    // « à faire » alors que Yacine AVAIT déposé le contrat, et Adam l'a annoncée en retard.
    //
    // On n'inscrit `CONTRACT_SIGNED` que si une PIÈCE a réellement été jointe : un contrat créé
    // sans son exemplaire n'est qu'une intention, et satisfaire une demande de dépôt avec une
    // intention rendrait le rapprochement faux dans l'autre sens.
    if (attached.saved > 0) {
      await recordEvent({
        type: "CONTRACT_SIGNED",
        sourceDomain: "ADPRO_CONSULTING",
        actorId: user.id,
        entityType: "CONSULTING_CONTRACT",
        entityId: contract.id,
        payload: { reference: contract.reference, counterparty, pieces: attached.saved },
      });
    }

    revalidate(contract.id);
    return { ok: true, id: contract.id };
  } catch (err) {
    console.error("[consulting] createConsultingContract failed", err);
    return { ok: false, error: "Le contrat n'a pas pu être créé. Réessayez dans un instant." };
  }
}

// ───────────────────────── Circuit ─────────────────────────

/** Le porteur demande la validation, et désigne à qui. */
export async function requestConsultingValidation(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Contrat introuvable." };
    const c = await prisma.consultingContract.findUnique({ where: { id } });
    if (!c) return { ok: false, error: "Contrat introuvable." };
    if (!owns(user, c)) return { ok: false, error: "Seul le porteur du contrat peut le soumettre." };

    const next = nextConsultingStatus(c.status, "SUBMIT");
    if (!next) return { ok: false, error: "Ce contrat n'est plus au stade de la soumission." };

    // Ce que le formulaire ne porte pas ne s'écrit pas (§118.152c) : une resoumission venue d'ailleurs que
    // l'écran garde le validateur qui a demandé la correction — c'est à lui de la juger.
    const validatorId = formData.has("validatorId") ? fdStr(formData, "validatorId") : c.validatorId;
    // CONDITIONNELLE (audit 360°, lot C4a) : deux envois simultanés ne font qu'une soumission. Le renvoi
    // pour correction, s'il y en avait un, s'efface ici — il vient d'être traité — et va au fil juste après.
    const ecrite = await prisma.consultingContract.updateMany({
      where: { id, status: "DRAFT" },
      data: { status: next as ConsultingStatus, validatorId, updatedById: user.id, returnedAt: null, returnedById: null, returnNote: null },
    });
    if (ecrite.count === 0) return { ok: false, error: "Ce contrat vient d'être soumis : rouvrez sa fiche." };
    if (c.returnedAt) {
      const renvoyeur = c.returnedById ? (await prisma.user.findUnique({ where: { id: c.returnedById }, select: { name: true } }))?.name : null;
      await ecrireAuFil({
        entityType: "CONSULTING_CONTRACT", entityId: id, authorId: user.id,
        body: `Resoumis après correction. Le renvoi du ${formatDate(c.returnedAt)}${renvoyeur ? ` (${renvoyeur})` : ""} demandait : « ${c.returnNote ?? "—"} ».`,
      });
    }

    // ── LA PORTE DU CENTRE DE VALIDATION AD & PRO ────────────────────────────────────────────
    // Un contrat de consulting n'avait AUCUNE porte au-dessus du seuil : mesuré sur sa machine à
    // états, rien n'y consultait `adProDgThreshold`, donc un engagement de 5 M DZD sortait sans
    // que personne en haut l'ait vu. Un centre qui laisserait passer cette nature serait une
    // porte ouverte à côté d'une porte gardée (§118.71).
    //
    // À la SOUMISSION et pas à la création : un brouillon change de montant jusqu'à la dernière
    // minute, et faire arbitrer le centre sur un chiffre provisoire le ferait travailler sur une
    // demande que son auteur n'a pas encore envoyée.
    // Seulement côté Ad & Pro : un contrat RH ne passe pas par le centre de la PROMOTION (§118.150)
    // — le lui faire arbitrer confierait la rémunération d'un consultant de l'équipe à un centre
    // qui ne voit que les dépenses de promotion, et la bloquerait pour toujours côté RH.
    //
    // À une RESOUMISSION après correction (audit 360°, lot C4a), la porte suit le montant corrigé : elle
    // s'ouvre s'il l'exige désormais, et une autorisation déjà donnée se ROUVRE si le montant la dépasse —
    // un accord ne couvre pas plus que ce qu'il a vu (§118.187).
    const visa = poleDe(c.pole) === "AD_PRO"
      ? await ajusterVisaAuMontant("CONSULTING_CONTRACT", id, c.amount == null ? null : toNumber(c.amount))
      : null;

    const body = `${c.reference} — ${c.title} (${c.counterparty})`;
    if (visa?.etat === "PENDING") {
      // On prévient le CENTRE, pas le validateur : c'est lui qui a la main, et prévenir les deux
      // ferait croire au validateur qu'il peut trancher — il se heurterait au blocage (§118.30).
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — contrat de consulting au-dessus du seuil",
        body, link: lienLigneCentreAdPro(id),
      });
    } else if (visa?.etat === "REFUSED") {
      // Resoumis sous un REFUS du centre : seul un siège peut le réexaminer. Prévenir le validateur, que
      // ce refus bloque, lui demanderait une décision qu'il ne peut pas prendre (§118.30).
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — contrat resoumis : votre refus est à réexaminer",
        body, link: lienLigneCentreAdPro(id),
      });
    } else if (validatorId) {
      await notifyUser({ userId: validatorId, type: "VALIDATION_REQUIRED", title: "Contrat de consulting à valider", body, link: `${PATH}/${id}` });
    } else {
      await notifyRoles(["DIRECTION", "SUPER_ADMIN"], { type: "VALIDATION_REQUIRED", title: "Contrat de consulting à valider", body, link: `${PATH}/${id}` });
    }
    await audit(user, id, "UPDATE", `${c.returnedAt ? "Contrat resoumis après correction" : "Contrat soumis à validation"} — ${c.reference}`);
    revalidate(id);
    // Ce que la soumission a fait AILLEURS — à la porte du centre — se DIT (§118.168), comme à la
    // resoumission d'une « autre demande ».
    const phrase = visa ? phraseGesteVisa(visa.geste, visa.etat) : null;
    return phrase ? { ok: true, id, message: `${c.returnedAt ? "Contrat resoumis" : "Contrat soumis"} — ${phrase}` } : { ok: true, id };
  } catch (err) {
    console.error("[consulting] requestConsultingValidation failed", err);
    return { ok: false, error: "La soumission a échoué." };
  }
}

/**
 * TRANCHER UN CONTRAT — trois issues (audit 360°, R11 et rapport 17 R13) : VALIDER (il devient actif),
 * RENVOYER pour correction (il revient en brouillon chez son porteur, qui le corrige et le resoumet) ou
 * REFUSER (il est annulé). Le motif est EXIGÉ pour renvoyer et pour refuser (R17) : sans lui, le porteur
 * ne sait ni quoi corriger ni pourquoi c'est non. L'ancien champ `approve` reste lu — une carte d'Adam
 * préparée avant ce lot doit encore aboutir.
 */
export async function decideConsultingContract(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const choix = fdStr(formData, "decision");
    const decision: "VALIDER" | "RENVOYER" | "REFUSER" =
      choix === "VALIDER" || choix === "RENVOYER" || choix === "REFUSER" ? choix
        : fdStr(formData, "approve") === "1" ? "VALIDER" : "REFUSER";
    const note = fdStr(formData, "note");
    if (!id) return { ok: false, error: "Contrat introuvable." };
    const c = await prisma.consultingContract.findUnique({ where: { id } });
    if (!c) return { ok: false, error: "Contrat introuvable." };

    // La désignation ne crée pas le droit : elle DÉSIGNE quelqu'un qui l'a déjà. Sans quoi
    // n'importe qui se nommerait validateur de son propre contrat.
    const mayDecide = peutSurLeContrat(user, c, "VALIDATE") && (c.validatorId === null || c.validatorId === user.id || isDirection(user));
    if (!mayDecide) return { ok: false, error: "La décision revient au validateur désigné." };

    // L'ÉTAT D'ABORD, LE MOTIF ENSUITE : demander un motif pour un contrat qui n'attend plus de décision
    // ferait payer un aller-retour à la personne — elle l'écrirait, puis apprendrait que rien ne pouvait
    // se décider (§118.18).
    const next = nextConsultingStatus(c.status, decision === "VALIDER" ? "APPROVE" : decision === "RENVOYER" ? "RETURN" : "REFUSE");
    if (!next) return { ok: false, error: "Ce contrat n'attend pas de décision." };

    // `=== null` et non `!note` : la dérivation des contrats lirait sinon un motif obligatoire pour
    // VALIDER aussi, et la carte refuserait une validation sans commentaire (§118.138).
    if (decision !== "VALIDER" && note === null) {
      return {
        ok: false,
        error: decision === "RENVOYER"
          ? "Dites ce qu'il faut corriger : sans cela, le porteur ne sait pas quoi changer avant de resoumettre."
          : "Indiquez le motif du refus : un refus sans motif ne laisse au porteur rien à quoi se tenir.",
      };
    }

    // LA PORTE DU CENTRE GARDE L'ACCORD — pas les gestes qui RÉDUISENT (§118.15). Sans cette ligne, le
    // validateur désigné trancherait un engagement que le centre n'a pas encore arbitré (§118.14) ;
    // renvoyer ou refuser n'engagent rien, et attendre le centre pour dire « corrigez » ou « non » ne
    // protégerait personne — la porte en attente est retirée juste après.
    if (decision === "VALIDER") {
      const blocage = poleDe(c.pole) === "AD_PRO" ? await blocageCentreAdPro("CONSULTING_CONTRACT", id) : null;
      if (blocage) return { ok: false, error: blocage };
    }

    const maintenant = new Date();
    const data: Prisma.ConsultingContractUpdateManyMutationInput = decision === "RENVOYER"
      ? { status: next as ConsultingStatus, returnedAt: maintenant, returnedById: user.id, returnNote: note, updatedById: user.id }
      : {
          status: next as ConsultingStatus,
          validatedById: user.id,
          validatedAt: maintenant,
          decisionNote: note,
          cancelledAt: decision === "VALIDER" ? null : maintenant,
          updatedById: user.id,
        };
    // CONDITIONNELLE : deux validateurs qui tranchent à la même seconde — la seconde décision trouve le
    // contrat déjà tranché au lieu d'écraser la première (un refus devenu accord sans que personne l'ait vu).
    const ecrite = await prisma.consultingContract.updateMany({ where: { id, status: "AWAITING_VALIDATION" }, data });
    if (ecrite.count === 0) return { ok: false, error: "Ce contrat vient d'être tranché : rouvrez sa fiche pour voir la décision." };

    // RENVOYÉ OU REFUSÉ, IL N'ATTEND PLUS LE CENTRE : la porte en attente est retirée — refusé, le contrat
    // est clos ; renvoyé, elle se reposera à la resoumission, sur le montant CORRIGÉ. Une décision déjà
    // rendue par le centre reste : c'est de l'histoire.
    const portes = decision === "VALIDER" ? 0 : await retirerVisaEnAttente("CONSULTING_CONTRACT", id);

    if (c.requesterId) {
      await notifyUser({
        userId: c.requesterId, type: "GENERIC",
        title: decision === "VALIDER" ? "Contrat de consulting validé"
          : decision === "RENVOYER" ? "Contrat de consulting à corriger" : "Contrat de consulting refusé",
        body: decision === "RENVOYER"
          ? `${c.reference} — à corriger : ${note}. Modifiez-le sur sa fiche, puis renvoyez-le pour validation.`
          : `${c.reference} — ${c.title}${note ? ` · ${decision === "REFUSER" ? "Motif" : "Note"} : ${note}` : ""}`,
        link: `${PATH}/${id}`,
      });
    }
    await audit(user, id, "VALIDATE", `${decision === "VALIDER" ? "Contrat validé (actif)" : decision === "RENVOYER" ? "Contrat renvoyé pour correction" : "Contrat refusé"} — ${c.reference}${note ? ` — ${note}` : ""}${portes ? " (sa demande au centre Ad & Pro est retirée)" : ""}`);
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[consulting] decideConsultingContract failed", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

/**
 * PROLONGER UN CONTRAT EN COURS (audit 360°, rapport 17 R13) — l'en-tête de ce fichier annonçait ce
 * geste depuis le début, et il n'existait pas : un contrat au terme dépassé ne pouvait que s'achever.
 *
 * Réservé à qui peut ACTIVER le contrat : prolonger, c'est accepter un engagement plus long — le droit
 * de la validation, jamais le porteur seul. Ce qui fonde la prolongation (l'avenant, l'accord du
 * consultant) est exigé et va au fil. On PROLONGE, on ne raccourcit pas : une fin anticipée est une
 * annulation ou un terme atteint, deux gestes qui existent et ne disent pas la même chose.
 */
export async function prolongerConsultingContract(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Contrat introuvable." };
    const c = await prisma.consultingContract.findUnique({ where: { id } });
    if (!c) return { ok: false, error: "Contrat introuvable." };
    const mayDecide = peutSurLeContrat(user, c, "VALIDATE") && (c.validatorId === null || c.validatorId === user.id || isDirection(user));
    if (!mayDecide) return { ok: false, error: "Prolonger un contrat revient à qui peut le valider." };
    if (c.status !== "ACTIVE") return { ok: false, error: "Seul un contrat en cours se prolonge." };

    const fin = dateOf(fdStr(formData, "endDate"));
    if (!fin) return { ok: false, error: "Indiquez la nouvelle date de fin." };
    if (c.endDate && fin <= c.endDate) {
      return { ok: false, error: `La nouvelle fin doit suivre l'actuelle (${formatDate(c.endDate)}) : on prolonge, on ne raccourcit pas.` };
    }
    if (c.startDate && fin < c.startDate) return { ok: false, error: "La date de fin ne peut pas précéder la date de début." };
    const note = fdStr(formData, "note");
    if (!note) return { ok: false, error: "Dites ce qui fonde la prolongation — l'avenant, l'accord du consultant : c'est ce qu'on cherchera plus tard." };

    // CONDITIONNELLE sur la fin LUE : deux prolongations croisées ne s'écrasent pas en silence.
    const ecrite = await prisma.consultingContract.updateMany({
      where: { id, status: "ACTIVE", endDate: c.endDate },
      data: { endDate: fin, updatedById: user.id },
    });
    if (ecrite.count === 0) return { ok: false, error: "Ce contrat vient de changer : rouvrez sa fiche." };

    const avant = c.endDate ? `du ${formatDate(c.endDate)} ` : "";
    await ecrireAuFil({
      entityType: "CONSULTING_CONTRACT", entityId: id, authorId: user.id,
      body: `Contrat prolongé ${avant}au ${formatDate(fin)} — ${note}`,
    });
    if (c.requesterId && c.requesterId !== user.id) {
      await notifyUser({
        userId: c.requesterId, type: "GENERIC", title: "Contrat de consulting prolongé",
        body: `${c.reference} — jusqu'au ${formatDate(fin)} · ${note}`, link: `${PATH}/${id}`,
      });
    }
    await audit(user, id, "UPDATE", `Contrat prolongé ${avant}au ${formatDate(fin)} — ${c.reference} — ${note}`);
    revalidate(id);
    return { ok: true, id, message: `Contrat prolongé jusqu'au ${formatDate(fin)}.` };
  } catch (err) {
    console.error("[consulting] prolongerConsultingContract failed", err);
    return { ok: false, error: "La prolongation n'a pas pu être enregistrée." };
  }
}

/** Clore un contrat arrivé à son terme, ou rompre un contrat en cours. */
export async function closeConsultingContract(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const cancel = fdStr(formData, "cancel") === "1";
    if (!id) return { ok: false, error: "Contrat introuvable." };
    const c = await prisma.consultingContract.findUnique({ where: { id } });
    if (!c) return { ok: false, error: "Contrat introuvable." };
    if (!owns(user, c) && !peutSurLeContrat(user, c, "VALIDATE")) {
      return { ok: false, error: "Seuls le porteur du contrat ou un validateur peuvent le clore." };
    }

    const next = nextConsultingStatus(c.status, cancel ? "CANCEL" : "EXPIRE");
    if (!next) return { ok: false, error: "Ce contrat est déjà clos." };
    // ROMPRE UN CONTRAT EST DÉFINITIF : on dit pourquoi (audit 360°, R17). `=== null` : un terme atteint
    // n'a rien à expliquer, et la dérivation ne doit pas rendre le motif obligatoire pour lui (§118.138).
    const note = fdStr(formData, "note");
    if (cancel && note === null) return { ok: false, error: "Dites pourquoi le contrat est annulé : l'annulation est définitive." };

    // CONDITIONNELLE : deux clôtures à la même seconde — la seconde trouve le contrat changé au lieu
    // d'écrire une seconde annulation, un second motif au fil et un second audit.
    const ecrite = await prisma.consultingContract.updateMany({
      where: { id, status: c.status },
      data: {
        status: next as ConsultingStatus,
        cancelledAt: cancel ? new Date() : null,
        decisionNote: note ?? c.decisionNote,
        updatedById: user.id,
      },
    });
    if (ecrite.count === 0) return { ok: false, error: "Ce contrat vient de changer d'état : rouvrez sa fiche." };
    // La note de décision d'hier n'est pas perdue sous le motif d'annulation : il va aussi au fil.
    if (cancel && note) await ecrireAuFil({ entityType: "CONSULTING_CONTRACT", entityId: id, authorId: user.id, body: `Contrat annulé — ${note}` });
    // ANNULÉ, IL N'A PLUS RIEN À FAIRE ARBITRER (audit 360°, lot C3) : la porte qui attendait le centre
    // Ad & Pro est retirée — sans quoi le centre trancherait une demande morte. Une décision déjà
    // RENDUE reste : c'est de l'histoire.
    const portes = cancel ? await retirerVisaEnAttente("CONSULTING_CONTRACT", id) : 0;
    await audit(user, id, "UPDATE", `${cancel ? "Contrat annulé" : "Contrat arrivé à expiration"} — ${c.reference}${portes ? " (sa demande au centre Ad & Pro est retirée)" : ""}`);
    revalidate(id);
    return { ok: true, id };
  } catch (err) {
    console.error("[consulting] closeConsultingContract failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

// ───────────────────────── Tâches attendues ─────────────────────────

export async function addConsultingTask(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const contractId = fdStr(formData, "contractId");
    const label = fdStr(formData, "label");
    if (!contractId || !label) return { ok: false, error: "Décrivez la tâche attendue." };
    const c = await prisma.consultingContract.findUnique({ where: { id: contractId } });
    if (!c) return { ok: false, error: "Contrat introuvable." };
    if (!owns(user, c) && !peutSurLeContrat(user, c, "UPDATE")) return { ok: false, error: "Modification non autorisée." };

    const count = await prisma.consultingTask.count({ where: { contractId } });
    await prisma.consultingTask.create({
      data: { contractId, label, dueDate: dateOf(fdStr(formData, "dueDate")), position: count },
    });
    await audit(user, contractId, "UPDATE", `Tâche ajoutée au contrat ${c.reference}`);
    revalidate(contractId);
    return { ok: true, id: contractId };
  } catch (err) {
    console.error("[consulting] addConsultingTask failed", err);
    return { ok: false, error: "La tâche n'a pas pu être ajoutée." };
  }
}

/** Cocher / décocher une tâche livrée. */
export async function toggleConsultingTask(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const taskId = fdStr(formData, "taskId");
    if (!taskId) return { ok: false, error: "Tâche introuvable." };
    const task = await prisma.consultingTask.findUnique({ where: { id: taskId }, include: { contract: true } });
    if (!task) return { ok: false, error: "Tâche introuvable." };
    if (!owns(user, task.contract) && !peutSurLeContrat(user, task.contract, "UPDATE")) return { ok: false, error: "Modification non autorisée." };

    await prisma.consultingTask.update({ where: { id: taskId }, data: { doneAt: task.doneAt ? null : new Date() } });
    revalidate(task.contractId);
    return { ok: true, id: task.contractId };
  } catch (err) {
    console.error("[consulting] toggleConsultingTask failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

export async function deleteConsultingTask(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const taskId = fdStr(formData, "taskId");
    if (!taskId) return { ok: false, error: "Tâche introuvable." };
    const task = await prisma.consultingTask.findUnique({ where: { id: taskId }, include: { contract: true } });
    if (!task) return { ok: false, error: "Tâche introuvable." };
    if (!owns(user, task.contract) && !peutSurLeContrat(user, task.contract, "UPDATE")) return { ok: false, error: "Suppression non autorisée." };
    if (!isContractEditable(task.contract.status)) return { ok: false, error: "Un contrat clos ne se modifie plus." };

    await prisma.consultingTask.delete({ where: { id: taskId } });
    revalidate(task.contractId);
    return { ok: true, id: task.contractId };
  } catch (err) {
    console.error("[consulting] deleteConsultingTask failed", err);
    return { ok: false, error: "L'opération a échoué." };
  }
}

// ───────────────────────── Le pôle ─────────────────────────

/**
 * TRANSFÉRER UN CONTRAT D'UN PÔLE À L'AUTRE — Ad & Pro ⇄ Ressources humaines (§118.150).
 *
 * « Transfère le consulting de Consultant médical — Atakor Minds, qui est dans Consulting d'Ad&Pro,
 * à un consulting en RH. » Un GESTE et non une migration : c'est une personne habilitée des deux
 * côtés qui décide qu'un contrat relève des RH, pas un déploiement — et le même geste le ramène.
 *
 * Ce qu'il NE fait PAS, et c'est voulu : il ne détruit rien. La gamme, les praticiens et les
 * produits restent sur la ligne (lus seulement côté Ad & Pro) : un transfert se défait par le geste
 * inverse, et un aller-retour ne doit rien avoir perdu. La référence, les tâches, les pièces, la
 * validation et l'historique suivent — c'est le MÊME contrat.
 *
 * Ce qu'il DÉPLACE, parce que chacun le lisait sur l'ancien pôle (§118.61) :
 *   • la porte du centre Ad & Pro encore EN ATTENTE — un contrat RH ne passe pas par le centre
 *     de la promotion ; la laisser ferait arbitrer par ce centre un contrat qui n'en relève plus.
 *     Une décision déjà PRISE reste : c'est de l'histoire, pas une attente. À l'inverse, un contrat
 *     qui ENTRE dans Ad & Pro en attente de validation passe par la porte, comme à sa soumission ;
 *   • le VALIDATEUR désigné qui n'a pas le droit de valider dans la nouvelle maison — sans quoi la
 *     décision reviendrait à quelqu'un que l'action refusera, et à lui seul : une attente sans
 *     pouvoir. La désignation tombe, le journal garde son nom, et la Direction est prévenue ;
 *   • les BONS DE COMMANDE en attente d'un centre qui en descendent — ils suivent la règle « Ad &
 *     Pro si la demande vient d'Ad & Pro, sinon le centre normal », relue par `aiguillerBC`.
 *
 * QUI : il faut MODIFIER des deux côtés (`transfertAutorise`) — retirer un contrat à ceux qui le
 * suivaient et le confier à d'autres n'est ni un geste de la seule promotion, ni des seules RH.
 */
export async function transfererConsulting(formData: FormData): Promise<ActionResult> {
  try {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Contrat introuvable." };
    const c = await prisma.consultingContract.findUnique({ where: { id } });
    if (!c) return { ok: false, error: "Contrat introuvable." };

    const depart = poleDe(c.pole);
    // Sans destination, l'autre pôle : il n'y en a que deux. Une destination ILLISIBLE est
    // refusée, jamais devinée — transférer « quelque part » serait pire que ne rien faire.
    const versBrut = fdStr(formData, "vers");
    if (versBrut !== null && !estPoleConsulting(versBrut)) {
      return { ok: false, error: `Pôle inconnu : « ${versBrut} ». Les deux pôles sont Ad & Pro (AD_PRO) et Ressources humaines (RH).` };
    }
    const vers: PoleConsulting = versBrut !== null && estPoleConsulting(versBrut) ? versBrut : poleOppose(depart);
    if (vers === depart) return { ok: false, error: `Ce contrat relève déjà de ${LIBELLE_POLE[vers]}.` };

    if (!transfertAutorise({
      modifieDepart: peutSurLeContrat(user, { pole: depart }, "UPDATE"),
      modifieArrivee: peutSurLeContrat(user, { pole: vers }, "UPDATE"),
    })) {
      return { ok: false, error: refusTransfert(depart, vers) };
    }

    const moduleArrivee = MODULE_DU_POLE[vers];
    const enAttente = c.status === "AWAITING_VALIDATION";

    // LE VALIDATEUR DÉSIGNÉ, RELU DANS SA NOUVELLE MAISON. La désignation ne crée pas le droit :
    // si la personne n'a pas VALIDATE sur le module d'arrivée, `decideConsultingContract` la
    // refusera — et, la désignation tenant, refusera aussi tout autre validateur de ce module.
    let validateurRetire: string | null = null;
    if (enAttente && c.validatorId) {
      const v = await prisma.user.findUnique({
        where: { id: c.validatorId }, select: { id: true, name: true, role: true, isActive: true },
      });
      const garde = v?.isActive
        ? userCan({ role: v.role, access: await getAccess(v.id, v.role) } as SessionUser, moduleArrivee, "VALIDATE")
        : false;
      if (!garde) validateurRetire = v?.name ?? "le validateur désigné";
    }

    await prisma.consultingContract.update({
      where: { id },
      data: { pole: vers, updatedById: user.id, ...(validateurRetire ? { validatorId: null } : {}) },
    });

    // LA PORTE DU CENTRE AD & PRO — retirée si elle ATTENDAIT, posée si le contrat entre en attente.
    let porte: "RETIREE" | "POSEE" | null = null;
    if (depart === "AD_PRO") {
      if ((await retirerVisaEnAttente("CONSULTING_CONTRACT", id)) > 0) porte = "RETIREE";
    } else if (enAttente) {
      const etat = await poserVisaAdPro("CONSULTING_CONTRACT", id, c.amount == null ? null : toNumber(c.amount));
      if (etat === "PENDING") porte = "POSEE";
    }

    // LES BONS DE COMMANDE qui attendent un centre et descendent de ce contrat.
    const bc = await reaiguillerLesBCDe({ type: "CONSULTING_CONTRACT", id }, user.id);

    const precisions = [
      porte === "RETIREE" ? "sa validation en attente est retirée du centre Ad & Pro" : null,
      porte === "POSEE" ? "il passe par le centre de validation Ad & Pro (au-dessus du seuil)" : null,
      validateurRetire ? `la désignation de ${validateurRetire} comme validateur tombe (pas de droit de validation en ${LIBELLE_POLE[vers]})` : null,
      bc.transferes > 0 ? `${bc.transferes} bon(s) de commande en attente change(nt) de centre` : null,
      // Une lecture BORNÉE qui se tairait se lirait comme exhaustive (§118.60) : le drapeau était
      // calculé par l'aiguillage et lu par personne — un état qu'aucun code ne lit (§118.45).
      bc.tronque
        ? `les files de validation comptent plus de ${LOT_ORIGINE} bons de commande en attente : seuls les plus anciens ont été relus, les autres rejoindront le bon centre à leur prochaine modification`
        : null,
    ].filter((x): x is string => x !== null);
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Consulting", entityType: "CONSULTING_CONTRACT", entityId: id,
      field: "pole", oldValue: depart, newValue: vers,
      summary: `Contrat ${c.reference} transféré de ${LIBELLE_POLE[depart]} vers ${LIBELLE_POLE[vers]}`
        + (precisions.length ? ` — ${precisions.join(" ; ")}.` : "."),
    });

    const body = `${c.reference} — ${c.title} (${c.counterparty})`;
    // LE PORTEUR EST PRÉVENU — sans quoi son contrat disparaît de sa liste sans explication. Le
    // lien n'est donné que s'il mène quelque part : un porteur sans le module d'arrivée ne voit
    // plus la fiche, et un lien vers « introuvable » dit moins que pas de lien du tout.
    const porteurId = c.requesterId ?? c.createdById;
    if (porteurId && porteurId !== user.id) {
      const p = await prisma.user.findUnique({ where: { id: porteurId }, select: { id: true, role: true, isActive: true } });
      if (p?.isActive) {
        const voit = userCan({ role: p.role, access: await getAccess(p.id, p.role) } as SessionUser, moduleArrivee, "VIEW");
        await notifyUser({
          userId: p.id, type: "GENERIC",
          title: `Contrat de consulting transféré vers ${LIBELLE_POLE[vers]}`,
          body: voit ? body : `${body} — il est désormais suivi par ${LIBELLE_POLE[vers]}.`,
          ...(voit ? { link: `${PATH}/${id}` } : {}),
        });
      }
    }
    if (porte === "POSEE") {
      await notifyRoles(["GENERAL_MANAGER", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Centre Ad & Pro — contrat de consulting au-dessus du seuil",
        body, link: lienLigneCentreAdPro(id),
      });
    } else if (validateurRetire) {
      // La désignation tombée, c'est la Direction qui tranche : on la prévient, comme à une
      // soumission sans désignation.
      await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
        type: "VALIDATION_REQUIRED", title: "Contrat de consulting à valider", body, link: `${PATH}/${id}`,
      });
    }

    revalidate(id);
    revalidatePath("/centre-ad-pro");
    return {
      ok: true, id,
      message: `Contrat ${c.reference} transféré vers ${LIBELLE_POLE[vers]}`
        + (precisions.length ? ` — ${precisions.join(" ; ")}.` : "."),
    };
  } catch (err) {
    console.error("[consulting] transfererConsulting failed", err);
    return { ok: false, error: "Le transfert a échoué." };
  }
}
