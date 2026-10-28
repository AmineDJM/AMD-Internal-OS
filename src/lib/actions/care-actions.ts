"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type CareCellKind, type CareCellStatus, type CareOpinion, type CareServiceKind } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, type SessionUser, anyRoleFilter } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/lib/expense-orders";
import { defaultCells, piecesADemander, OPINION_LABELS, SERVICE_KIND_LABELS } from "@/lib/care";
import {
  deviseDuPoste, etapesDuBillet, lireDetailsTrajets, peutTeleverserBillet, libelleNouveauPoste, lireMontant,
  lirePosteSaisi, montantLisible, typePoste, versDzd, peutMarquerRealisee,
} from "@/lib/care-fiches";
import { envoiAuxFinances, ENVOI_FINANCES_CHAMP, ENVOI_FINANCES_RESUME } from "@/lib/care-realisation";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { peutSaisirLesDevis } from "@/lib/care-devis-acces";
import { creerProfilMedecin } from "@/lib/medical/profil-rapide";
import { persistUploadedDocument } from "@/lib/documents";
import { deleteFileByKey } from "@/lib/storage";
import { deposerFichiersSurLaPiece, retirerFichierDeLaPiece } from "@/lib/care-pieces-db";
import { phraseDepot } from "@/lib/care-pieces";
import { createDossierRecord, ecrireDansLeSujet } from "@/lib/dossiers-core";
import { noterModificationFiche } from "@/lib/reservation-fiche/serveur";
import { demandePrevalidee, refusEngagementPriseEnCharge, REFUS_NON_PREVALIDEE } from "@/lib/care-engagement";
import { refusSiPorteDgFermee, signalerPorteDgSiBesoin } from "@/lib/ad-pro/porte-dg";
import { relierALaPersonne } from "@/modules/referentiels/api";
import { sansBloquer } from "@/lib/journal";
import {
  SPEC, canDecide, canEdit, chargerPosteGroupe, isScope, loadRequest, nameOf, parentWhere, revalidate, rolesDe,
  scopeOfBeneficiary, tauxDe, type Scope,
} from "@/lib/actions/internes/care/demande";
import { versCellRow, CELL_FICHE_SELECT } from "@/lib/actions/internes/care/fiches";
import {
  fichierEtSaPiece, hotelDeLaPersonne, materielsRattachables, posteFusionne, praticiensDeLAnnuaire,
} from "@/lib/actions/internes/care/postes";
import {
  casesDeLaCategorieDemandee, chiffrerLeDevis, conflitDeCouverture, demandeDeBc, devisATrancher, devisRetenus,
  devisRivaux, marquerBcDemande, rattacherLOrdre, refuserLeDevis, rendreLaReserveDuDevis, reserverLeDevis,
  retenirALaPlace,
} from "@/lib/actions/internes/care/devis";
import {
  creerPosteGroupe, etatPourLesFinances, exclureOuReinclure, poserLaFin,
} from "@/lib/actions/internes/care/demande-suite";
// Découpé par responsabilité (lot V4) : aides, lectures et corps internes dans `actions/internes/care/{demande,fiches,postes,devis,demande-suite}` — les actions restent ici (leur clé de contrat).

/**
 * PRISE EN CHARGE — actions serveur (nationale et internationale).
 *
 * Ce que ce fichier tient, et qui n'existait pas :
 *   • une **décision par personne** — sur une même demande, l'une est accordée et l'autre
 *     écartée, sans qu'on ait à refuser l'ensemble ;
 *   • une **liste de besoins propre à chaque personne** — l'une a besoin d'un visa et pas
 *     l'autre ;
 *   • des **devis qui couvrent ce qu'ils couvrent réellement** : une agence chiffre le groupe,
 *     on ne lui demande pas de découper en dix lignes.
 *
 * ⚠️ Le garde-fou central : **une case déjà couverte par un devis accepté ne peut pas être
 * couverte par un second**. C'est la seule façon de ne pas payer deux fois le même hôtel — et
 * personne ne s'en apercevrait avant la facture.
 */

async function audit(user: SessionUser, scope: Scope, id: string, action: "CREATE" | "UPDATE" | "DELETE", detail: string) {
  await recordAudit({
    actorId: user.id, module: SPEC[scope].module, entityType: SPEC[scope].module, entityId: id, action, summary: detail,
  }).catch(sansBloquer("care-actions.audit.recordAudit"));
}

/**
 * OUVRIR LA FICHE D'UNE PERSONNE — sa billetterie et son hôtellerie, ouvertes par défaut (Direction, 10/2026).
 * Idempotent : une personne qui a déjà un billet (ou un hôtel) n'en reçoit pas un second. L'hôtel prend la
 * ville de l'événement ; ses dates viendront du billet.
 */
async function ouvrirFiche(tx: Prisma.TransactionClient, scope: Scope, beneficiaryId: string, city: string | null, userId: string) {
  const deja = await tx.careCell.findMany({ where: { beneficiaryId, kind: "SERVICE", serviceKind: { in: ["TICKET", "HOTEL"] } }, select: { serviceKind: true } });
  const last = await tx.careCell.findFirst({ where: { beneficiaryId }, orderBy: { position: "desc" }, select: { position: true } });
  let pos = last?.position ?? 0;
  const data: Prisma.CareCellCreateManyInput[] = [];
  if (!deja.some((c) => c.serviceKind === "TICKET")) {
    data.push({ beneficiaryId, kind: "SERVICE", serviceKind: "TICKET", label: "Billetterie", currency: deviseDuPoste(scope, "TICKET"), requestedById: userId, position: ++pos });
  }
  if (!deja.some((c) => c.serviceKind === "HOTEL")) {
    data.push({ beneficiaryId, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city, currency: deviseDuPoste(scope, "HOTEL"), requestedById: userId, position: ++pos });
  }
  if (data.length) await tx.careCell.createMany({ data });
}

/**
 * LE SUJET DE L'ASSISTANTE DE DIRECTION pour cette prise en charge — celui déjà ouvert (on y écrit), sinon un
 * nouveau. Même règle qu'au sponsoring : une seule assistante active en est responsable ; plusieurs, toutes
 * participantes ; aucune, la demande n'a personne à qui partir, et on le dit.
 */
async function ecrireAAssistante(
  scope: Scope, req: NonNullable<Awaited<ReturnType<typeof loadRequest>>>, user: SessionUser, titre: string, corps: string,
): Promise<{ ok: true; id: string; reference: string; nouveau: boolean } | { ok: false; error: string }> {
  if (req.careReservationDossierId) {
    const ecrit = await ecrireDansLeSujet({ dossierId: req.careReservationDossierId, authorId: user.id, body: `${titre}\n${corps}` });
    if (ecrit) {
      const d = await prisma.dossier.findUnique({ where: { id: req.careReservationDossierId }, select: { reference: true } });
      return { ok: true, id: req.careReservationDossierId, reference: d?.reference ?? "", nouveau: false };
    }
  }
  const assistantes = await prisma.user.findMany({
    where: { isActive: true, ...anyRoleFilter(["DIRECTION_ASSISTANT"]) },
    select: { id: true }, orderBy: { createdAt: "asc" },
  });
  if (assistantes.length === 0) {
    return { ok: false, error: "Aucune assistante de direction active : la demande n'a personne à qui partir (Administration › Comptes)." };
  }
  const seule = assistantes.length === 1 ? assistantes[0]!.id : null;
  const sujet = await createDossierRecord({
    title: `Prise en charge — ${req.name}`,
    description: `${titre}\n${corps}`,
    category: "Billets",
    priority: "HIGH",
    assignedToId: seule,
    participantIds: [...(seule ? [] : assistantes.map((a) => a.id)), ...(req.requesterId ? [req.requesterId] : [])],
    sourceType: SPEC[scope].module,
    sourceId: req.id,
    companyId: req.companyId ?? null,
  }, user.id);
  if (scope === "NATIONAL") await prisma.congressNational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  else await prisma.congressInternational.update({ where: { id: req.id }, data: { careReservationDossierId: sujet.id } });
  return { ok: true, id: sujet.id, reference: sujet.reference, nouveau: true };
}

// ───────────────────────────── Les personnes ─────────────────────────────

/**
 * Ajoute un PROFESSIONNEL PROPOSÉ pour la prise en charge — la source UNIQUE de « qui est pris en
 * charge » (décision du 04/10/2026). Trois façons, un seul écrivain :
 *   • depuis l'annuaire (`doctorId`) ;
 *   • en CRÉANT son profil de médecin (`createDoctor` : `doctorName`, spécialité, établissement,
 *     secteur) — la fiche entre dans l'annuaire et la ligne la désigne ;
 *   • en profil libre (`lastName`…) — on ne crée pas une fiche médecin permanente pour un
 *     intervenant vu une seule fois.
 *
 * Chaque personne ajoutée est une PROPOSITION (`PROPOSED`) : la Direction tranche, personne par
 * personne. La porte est celle de la FICHE (`canAccessEntity`), pas le seul droit de module : un
 * délégué n'ajoute pas une personne au congrès d'un collègue (§118.71).
 */
export async function addCareBeneficiary(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  if (!isScope(scopeRaw)) return { ok: false, error: "Périmètre inconnu." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };

  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande non précisée." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const creer = fdStr(formData, "createDoctor") === "on";
  const doctorName = fdStr(formData, "doctorName");
  let doctorId = creer ? null : fdStr(formData, "doctorId");
  const lastName = fdStr(formData, "lastName");
  if (creer && !doctorName) return { ok: false, error: "Le nom du médecin est obligatoire." };
  if (!creer && !doctorId && !lastName) return { ok: false, error: "Choisissez une personne dans l'annuaire, créez son profil, ou saisissez au moins son nom." };
  if (doctorId) {
    const ok = await prisma.medicalDoctor.count({ where: { id: doctorId } });
    if (!ok) return { ok: false, error: "Personne introuvable dans l'annuaire." };
    const deja = await prisma.careBeneficiary.count({ where: { ...parentWhere(scopeRaw, requestId), doctorId } });
    if (deja) return { ok: false, error: "Ce praticien est déjà proposé sur cette demande." };
  }

  try {
    if (creer) {
      const profil = await creerProfilMedecin(user.id, {
        name: doctorName ?? "",
        specialtyId: fdStr(formData, "specialtyId"),
        institutionId: fdStr(formData, "institutionId"),
        sector: fdStr(formData, "sector"),
      }, `la prise en charge « ${req.name} »`);
      if (!profil.ok) return profil;
      doctorId = profil.id;
    }
    const last = await prisma.careBeneficiary.findFirst({
      where: parentWhere(scopeRaw, requestId), orderBy: { position: "desc" }, select: { position: true },
    });
    // LA FICHE NAÎT OUVERTE (Direction, 10/2026) : la personne et, avec elle, sa billetterie et son hôtellerie.
    const created = await prisma.$transaction(async (tx) => {
      const b = await tx.careBeneficiary.create({
        data: {
          ...parentWhere(scopeRaw, requestId),
          doctorId: doctorId ?? null,
          firstName: doctorId ? null : fdStr(formData, "firstName"),
          lastName: doctorId ? null : lastName,
          jobTitle: fdStr(formData, "jobTitle"),
          institution: fdStr(formData, "institution"),
          position: (last?.position ?? 0) + 1,
          createdById: user.id,
          updatedById: user.id,
        },
        select: { id: true, doctorId: true, firstName: true, lastName: true },
      });
      await ouvrirFiche(tx, scopeRaw, b.id, req.city ?? null, user.id);
      // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne (celle du praticien, s'il vient de l'annuaire), derrière son interrupteur.
      await relierALaPersonne(tx, "CareBeneficiary", b.id, user.id);
      return b;
    });

    await audit(user, scopeRaw, requestId, "CREATE", `Professionnel proposé pour la prise en charge : ${await nameOf(created)}.`);
    revalidate(scopeRaw, requestId);
    return { ok: true, id: created.id };
  } catch (err) {
    console.error("[care] ajout de personne impossible", err);
    return { ok: false, error: "La personne n'a pas pu être ajoutée." };
  }
}

/**
 * CRÉER LE PROFIL D'UN MÉDECIN AVANT QUE LA DEMANDE EXISTE — depuis le formulaire de création.
 *
 * La demande n'a pas encore d'identifiant : on ne peut pas y ajouter une ligne. Le profil entre dans
 * l'annuaire tout de suite, et le formulaire le coche parmi les professionnels proposés ; c'est
 * `createCongressRequest` qui en fait une ligne de la demande. Ouvert à qui peut CRÉER une prise en
 * charge de ce périmètre — exactement ceux qui voient ce formulaire.
 */
export async function creerProfilProfessionnel(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  if (!isScope(scopeRaw)) return { ok: false, error: "Périmètre inconnu." };
  if (!userCan(user, SPEC[scopeRaw].module, "CREATE")) return { ok: false, error: "Non autorisé." };
  const r = await creerProfilMedecin(user.id, {
    name: fdStr(formData, "doctorName") ?? "",
    specialtyId: fdStr(formData, "specialtyId"),
    institutionId: fdStr(formData, "institutionId"),
    sector: fdStr(formData, "sector"),
  }, "une demande de prise en charge");
  if (!r.ok) return r;
  return { ok: true, id: r.id, message: r.name };
}

/** L'avis du demandeur SUR CETTE PERSONNE. « Pas d'avis » est une réponse valable. */
export async function setCareOpinion(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Personne non précisée." };
  const found = await scopeOfBeneficiary(id);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

  const opinion = (fdStr(formData, "opinion") ?? "NONE") as CareOpinion;
  if (!(opinion in OPINION_LABELS)) return { ok: false, error: "Avis inconnu." };

  await prisma.careBeneficiary.update({
    where: { id },
    data: { requesterOpinion: opinion, requesterNote: fdStr(formData, "note"), updatedById: user.id },
  });
  await audit(user, found.scope, found.requestId, "UPDATE",
    `Avis « ${OPINION_LABELS[opinion]} » porté sur ${await nameOf(found.beneficiary)}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id };
}

/**
 * La décision de la Direction, PERSONNE PAR PERSONNE.
 *
 * Accorder une personne crée d'office sa pièce d'identité à fournir : c'est le point de départ
 * du dossier, et l'oublier revient à découvrir le manque à l'aéroport. Le reste (hôtel, billet,
 * visa) s'ajoute au cas par cas — pré-remplir dix cases qu'il faudra effacer coûte plus cher.
 */
export async function decideCareBeneficiary(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || (decision !== "APPROVED" && decision !== "REJECTED")) return { ok: false, error: "Décision non précisée." };

  const found = await scopeOfBeneficiary(id);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canDecide(user, found.scope)) return { ok: false, error: "Seule la Direction tranche." };

  const name = await nameOf(found.beneficiary);
  try {
    await prisma.careBeneficiary.update({
      where: { id },
      data: {
        status: decision, decidedById: user.id, decidedAt: new Date(),
        decisionNote: fdStr(formData, "note"), updatedById: user.id,
      },
    });

    if (decision === "APPROVED") {
      // Idempotent : re-accorder une personne ne recrée pas sa pièce d'identité en double. Seules les PIÈCES
      // comptent : la fiche naît avec sa billetterie et son hôtellerie, qui ne sont pas des pièces.
      const existing = await prisma.careCell.count({ where: { beneficiaryId: id, kind: "DOCUMENT" } });
      if (existing === 0) {
        await prisma.careCell.createMany({
          data: defaultCells(found.scope === "NATIONAL" ? "NATIONAL" : "INTERNATIONAL").map((c, i) => ({
            beneficiaryId: id, kind: c.kind, serviceKind: c.serviceKind, label: c.label,
            requestedById: user.id, position: i + 1,
          })),
        });
      }
    }

    await audit(user, found.scope, found.requestId, "UPDATE",
      `${name} : ${decision === "APPROVED" ? "prise en charge ACCORDÉE" : "prise en charge ÉCARTÉE"}${fdStr(formData, "note") ? ` — ${fdStr(formData, "note")}` : ""}.`);
    revalidate(found.scope, found.requestId);
    return { ok: true, id };
  } catch (err) {
    console.error("[care] décision impossible", err);
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

export async function removeCareBeneficiary(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Personne non précisée." };
  const found = await scopeOfBeneficiary(id);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

  // Une personne dont une prestation est déjà engagée ne se retire pas : la dépense, elle,
  // resterait. On l'écarte (décision tracée) plutôt que de l'effacer.
  const engaged = await prisma.careCell.count({ where: { beneficiaryId: id, expenseOrderId: { not: null } } });
  if (engaged > 0) {
    return { ok: false, error: "Une dépense a déjà été engagée pour cette personne : écartez-la plutôt que de la retirer." };
  }

  const name = await nameOf(found.beneficiary);
  await prisma.careBeneficiary.delete({ where: { id } });
  await audit(user, found.scope, found.requestId, "DELETE", `${name} retirée de la prise en charge.`);
  revalidate(found.scope, found.requestId);
  return { ok: true };
}

// ───────────────────────────── Les pièces de chaque professionnel ─────────────────────────────

/**
 * DEMANDER LES PIÈCES — ce que le bloc « Personnes prises en charge » faisait d'un seul bouton, mais
 * PAR PERSONNE et SUIVI : chaque professionnel proposé ou accordé reçoit une case par pièce attendue
 * (national : passeport ; international : passeport, visa, informations de voyage — `piecesAttendues`),
 * et le demandeur est prévenu. Une pièce déjà demandée, reçue ou déclarée sans objet n'est jamais
 * redemandée ; un professionnel écarté ou retiré ne reçoit rien.
 *
 * Deux clics simultanés ne doublent rien : le calcul et l'écriture se font sous un verrou consultatif
 * propre à la demande, et le second relit les cases que le premier vient d'écrire.
 */
export async function demanderPiecesPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  if (!isScope(scopeRaw)) return { ok: false, error: "Périmètre inconnu." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  const requestId = fdStr(formData, "requestId");
  if (!requestId) return { ok: false, error: "Demande non précisée." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const bilan = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('care-pieces'), hashtext(${requestId}))`;
    const personnes = await tx.careBeneficiary.findMany({
      where: { ...parentWhere(scopeRaw, requestId), status: { in: ["PROPOSED", "APPROVED"] } },
      select: { id: true, cells: { select: { kind: true, label: true, position: true } } },
    });
    let cases = 0;
    let concernees = 0;
    for (const p of personnes) {
      const manquent = piecesADemander(scopeRaw, p.cells);
      if (manquent.length === 0) continue;
      concernees += 1;
      const pos = p.cells.reduce((m, c) => Math.max(m, c.position), 0);
      await tx.careCell.createMany({
        data: manquent.map((m, i) => ({
          beneficiaryId: p.id, kind: "DOCUMENT" as const, serviceKind: null, label: m.label,
          requestedById: user.id, position: pos + i + 1,
        })),
      });
      cases += manquent.length;
    }
    return { cases, concernees, personnes: personnes.length };
  });

  if (bilan.personnes === 0) return { ok: false, error: "Aucun professionnel proposé : ajoutez d'abord les personnes à prendre en charge." };
  if (bilan.cases === 0) return { ok: true, message: "Rien à demander : toutes les pièces attendues sont déjà demandées, reçues ou sans objet." };

  if (req.requesterId && req.requesterId !== user.id) {
    await notifyUser({
      userId: req.requesterId, type: "ASSIGNMENT", title: "Pièces demandées — prise en charge",
      body: `${req.name} — ${bilan.cases} pièce(s) à joindre pour ${bilan.concernees} professionnel(s).`,
      link: `${SPEC[scopeRaw].path}/${requestId}`,
    }).catch(sansBloquer("care-actions.demanderPiecesPriseEnCharge.notifyUser"));
  }
  await audit(user, scopeRaw, requestId, "UPDATE", `Pièces demandées : ${bilan.cases} pour ${bilan.concernees} professionnel(s).`);
  revalidate(scopeRaw, requestId);
  return { ok: true, message: `${bilan.cases} pièce(s) demandée(s) pour ${bilan.concernees} professionnel(s).` };
}

/**
 * DÉPOSER LA PIÈCE D'UN PROFESSIONNEL — le fichier rejoint les documents de la demande (catégorie
 * « pièce d'identité », rattaché à SA case par `stepKey`), et la case passe « reçue ». Le téléverseur
 * générique d'avant déposait les pièces en vrac : « Pièces d'identité reçues 2/5 » ne disait ni
 * lesquelles ni de qui.
 *
 * Une pièce déjà VALIDÉE ou déclarée SANS OBJET ne se remplace pas d'ici : l'état se rouvre d'abord
 * depuis la case. L'écriture de l'état est conditionnelle ; perdue, le fichier déposé est retiré.
 *
 * PLUSIEURS FICHIERS (Direction, 10/2026) : recto, verso, pages, visa — `file` peut se répéter, en un
 * geste ou en plusieurs ; chaque fichier s'ajoute aux autres (`lib/care-pieces`). Le lot est contrôlé
 * entier AVANT d'écrire (limites des réglages).
 */
export async function deposerPiecePriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const cellId = fdStr(formData, "cellId");
  if (!cellId) return { ok: false, error: "Pièce non précisée." };
  const cell = await prisma.careCell.findUnique({ where: { id: cellId }, select: { id: true, kind: true, label: true, status: true, beneficiaryId: true, documentId: true } });
  if (!cell || cell.kind !== "DOCUMENT") return { ok: false, error: "Pièce introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const module = SPEC[found.scope].module;
  if (!(await canAccessEntity(user, module, found.requestId, "UPLOAD"))) return { ok: false, error: "Vous n'êtes pas autorisé à déposer une pièce sur cette demande." };
  if (cell.status === "SETTLED") return { ok: false, error: `« ${cell.label} » est déjà validée : rouvrez son état avant d'en déposer une autre.` };
  if (cell.status === "WAIVED") return { ok: false, error: `« ${cell.label} » est déclarée sans objet : rouvrez son état avant de la déposer.` };
  const fichiers = formData.getAll("file").filter((v): v is File => v instanceof File);
  if (fichiers.length === 0) return { ok: false, error: "Aucun fichier sélectionné." };

  const r = await deposerFichiersSurLaPiece(user.id, cell, { entityType: module, entityId: found.requestId }, fichiers);
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${await nameOf(found.beneficiary)} — « ${cell.label} » reçue${r.ids.length > 1 ? ` (${r.ids.length} fichiers)` : ""}.`);
  revalidate(found.scope, found.requestId);
  const manques = r.echecs.length > 0 ? ` Non joint : ${r.echecs.join(" ")}` : "";
  return { ok: true, id: cell.id, message: `${phraseDepot(cell.label, r.ids.length)}${manques}` };
}

/**
 * RETIRER UN FICHIER D'UNE PIÈCE (Direction, 10/2026) — la page en trop, le scan illisible. Le dernier
 * retiré, la pièce redevient attendue : « passeport manquant » revient, sans qu'on le déclare.
 *
 * Signature `(id, path?)` : celle que l'aperçu des documents (`DocumentPreview.supprimer`) appelle — son
 * bouton, sa confirmation et son rafraîchissement sont ceux de tous les documents. Le fichier doit être
 * celui d'une pièce de CETTE demande (la case désignée par le fichier, sur l'entité de la demande) ; la
 * porte est celle du dépôt. Une pièce validée ou sans objet ne se touche pas d'ici.
 */
export async function retirerFichierPiecePriseEnCharge(documentId: string, _path?: string): Promise<ActionResult> {
  const user = await requireUser();
  if (!documentId) return { ok: false, error: "Fichier non précisé." };
  const lu = await fichierEtSaPiece(documentId);
  if (!lu.ok) return { ok: false, error: lu.error };
  const { doc, cell } = lu;
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const module = SPEC[found.scope].module;
  if (doc.entityType !== module || doc.entityId !== found.requestId) return { ok: false, error: "Ce fichier n'appartient pas à cette demande." };
  if (!(await canAccessEntity(user, module, found.requestId, "UPLOAD"))) return { ok: false, error: "Vous n'êtes pas autorisé à retirer une pièce de cette demande." };
  if (cell.status === "SETTLED") return { ok: false, error: `« ${cell.label} » est validée : rouvrez son état avant d'en retirer un fichier.` };
  if (cell.status === "WAIVED") return { ok: false, error: `« ${cell.label} » est déclarée sans objet : rouvrez son état avant d'en retirer un fichier.` };

  const r = await retirerFichierDeLaPiece(cell, doc.id, { entityType: module, entityId: found.requestId });
  if (!r.ok) return { ok: false, error: r.error };
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${await nameOf(found.beneficiary)} — « ${cell.label} » : fichier « ${doc.name} » retiré${r.restants === 0 ? " — pièce de nouveau attendue" : ""}.`);
  revalidate(found.scope, found.requestId);
  return {
    ok: true, id: cell.id,
    message: r.restants === 0 ? `${cell.label} : plus aucun fichier, la pièce est de nouveau attendue.` : `Fichier retiré (${r.restants} restant${r.restants > 1 ? "s" : ""}).`,
  };
}

// ───────────────────────────── Les cases ─────────────────────────────

/**
 * Ajoute une case sur la ligne d'UNE personne — une pièce à fournir ou un élément à acheter.
 *
 * Ajoutable par tous ceux qui ont accès à la demande : la Direction Marketing découvre souvent
 * après coup qu'il faut un visa ou une nuit d'hôtel supplémentaire.
 */
export async function addCareCell(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const beneficiaryId = fdStr(formData, "beneficiaryId");
  // LE « + » D'UNE CATÉGORIE DE LA FICHE (Direction, 10/2026) : `posteType` dit la catégorie, le libellé en découle.
  const type = typePoste(fdStr(formData, "posteType"));
  if (fdStr(formData, "posteType") && !type) return { ok: false, error: "Catégorie de poste inconnue." };
  if (!beneficiaryId) return { ok: false, error: "Personne non précisée." };

  const found = await scopeOfBeneficiary(beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

  const kind = (type ? "SERVICE" : fdStr(formData, "kind") ?? "DOCUMENT") as CareCellKind;
  if (kind !== "DOCUMENT" && kind !== "SERVICE") return { ok: false, error: "Nature inconnue." };
  const serviceKind = type ? type.serviceKind : kind === "SERVICE" ? ((fdStr(formData, "serviceKind") ?? "OTHER") as CareServiceKind) : null;
  if (serviceKind && !(serviceKind in SERVICE_KIND_LABELS)) return { ok: false, error: "Nature de prestation inconnue." };
  const memeNature = serviceKind ? await prisma.careCell.count({ where: { beneficiaryId, kind: "SERVICE", serviceKind } }) : 0;
  const label = fdStr(formData, "label") ?? (type ? libelleNouveauPoste(type, memeNature) : null);
  if (!label) return { ok: false, error: "Le libellé est obligatoire." };

  // UN HÔTEL AJOUTÉ prend la ville de l'événement et les dates du billet principal (propositions, corrigeables).
  let prerempli: { city: string | null; dateStart: Date | null; dateEnd: Date | null } = { city: null, dateStart: null, dateEnd: null };
  if (serviceKind === "HOTEL") prerempli = await hotelDeLaPersonne(found.scope, found.requestId, beneficiaryId);

  try {
    const last = await prisma.careCell.findFirst({ where: { beneficiaryId }, orderBy: { position: "desc" }, select: { position: true } });
    const created = await prisma.careCell.create({
      data: {
        beneficiaryId, kind, serviceKind, label,
        notes: fdStr(formData, "notes"),
        requestedById: user.id,
        position: (last?.position ?? 0) + 1,
        ...(serviceKind ? { currency: deviseDuPoste(found.scope, serviceKind) } : {}),
        ...prerempli,
      },
      select: { id: true },
    });
    await audit(user, found.scope, found.requestId, "CREATE",
      `${await nameOf(found.beneficiary)} — élément demandé : ${label}${serviceKind ? ` (${SERVICE_KIND_LABELS[serviceKind]})` : ""}.`);
    revalidate(found.scope, found.requestId);
    return { ok: true, id: created.id };
  } catch (err) {
    console.error("[care] ajout de case impossible", err);
    return { ok: false, error: "L'élément n'a pas pu être ajouté." };
  }
}

/**
 * Fait avancer une case : reçue, validée, ou sans objet.
 *
 * « Sans objet » n'est pas une suppression : on garde la trace qu'on a bien regardé le visa et
 * qu'il n'en fallait pas. Une case supprimée laisserait croire qu'on n'y a jamais pensé.
 */
export async function setCareCellStatus(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status") as CareCellStatus | null;
  if (!id || !status || !["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"].includes(status)) {
    return { ok: false, error: "État non précisé." };
  }

  const cell = await prisma.careCell.findUnique({ where: { id }, select: { id: true, label: true, beneficiaryId: true, expenseOrderId: true } });
  if (!cell) return { ok: false, error: "Élément introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };
  // Une prestation payée ne redevient pas « sans objet » : la dépense, elle, a bien eu lieu.
  if (status === "WAIVED" && cell.expenseOrderId) {
    return { ok: false, error: "Une dépense a été engagée sur cet élément : il ne peut plus être déclaré sans objet." };
  }

  await prisma.careCell.update({ where: { id }, data: { status } });
  await audit(user, found.scope, found.requestId, "UPDATE", `${await nameOf(found.beneficiary)} — « ${cell.label} » : ${status}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id };
}

export async function removeCareCell(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Élément non précisé." };
  const cell = await prisma.careCell.findUnique({ where: { id }, select: { id: true, label: true, beneficiaryId: true, expenseOrderId: true } });
  if (!cell) return { ok: false, error: "Élément introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };
  if (cell.expenseOrderId) return { ok: false, error: "Une dépense a été engagée sur cet élément : il ne peut plus être retiré." };

  await prisma.careCell.delete({ where: { id } });
  await audit(user, found.scope, found.requestId, "DELETE", `${await nameOf(found.beneficiary)} — élément « ${cell.label} » retiré.`);
  revalidate(found.scope, found.requestId);
  return { ok: true };
}

/**
 * ENREGISTRER UN POSTE DE LA FICHE — le billet (trajet, étapes, mode, dates), l'hôtel (hôtel, ville, dates,
 * chambre), ou un autre poste (détail, date) ; et son montant, dans la devise du poste : le dollar à
 * l'international sauf pour la billetterie (`deviseDuPoste`), converti au taux FIGÉ de la demande.
 *
 * Les règles de lecture sont celles du sponsoring (`lirePosteSaisi` → `lireVoyageur` / `lireHebergement`) :
 * un retour avant l'aller, un départ d'hôtel avant l'arrivée se refusent en le disant. Un poste dont la
 * dépense est engagée garde son montant : la dépense, elle, a eu lieu.
 */
export async function modifierPosteFiche(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const cell = await prisma.careCell.findUnique({ where: { id }, select: { ...CELL_FICHE_SELECT, beneficiaryId: true } });
  if (!cell || cell.kind !== "SERVICE" || !cell.serviceKind) return { ok: false, error: "Poste introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

  const nom = await nameOf(found.beneficiary);
  const avant = versCellRow(cell);
  // Un champ ABSENT du formulaire garde sa valeur : on ne vide jamais en silence ce que l'écran n'a pas montré.
  // (Noms de champs ÉCRITS EN CLAIR : le contrat des actions les lit dans la source.)
  const envoye = {
    label: formData.has("label") ? String(formData.get("label") ?? "") : undefined,
    notes: formData.has("notes") ? String(formData.get("notes") ?? "") : undefined,
    dateStart: formData.has("dateStart") ? String(formData.get("dateStart") ?? "") : undefined,
    dateEnd: formData.has("dateEnd") ? String(formData.get("dateEnd") ?? "") : undefined,
    trajet: formData.has("trajet") ? String(formData.get("trajet") ?? "") : undefined,
    transport: formData.has("transport") ? String(formData.get("transport") ?? "") : undefined,
    fromCity: formData.has("fromCity") ? String(formData.get("fromCity") ?? "") : undefined,
    toCity: formData.has("toCity") ? String(formData.get("toCity") ?? "") : undefined,
    segments: formData.has("segments") ? String(formData.get("segments") ?? "") : undefined,
    hotelName: formData.has("hotelName") ? String(formData.get("hotelName") ?? "") : undefined,
    city: formData.has("city") ? String(formData.get("city") ?? "") : undefined,
    roomType: formData.has("roomType") ? String(formData.get("roomType") ?? "") : undefined,
    timeStart: formData.has("timeStart") ? String(formData.get("timeStart") ?? "") : undefined,
    address: formData.has("address") ? String(formData.get("address") ?? "") : undefined,
    amount: formData.has("amount") ? String(formData.get("amount") ?? "") : undefined,
  };
  const lu = lirePosteSaisi(cell.serviceKind, nom, posteFusionne(envoye, avant));
  if (!lu.ok) return { ok: false, error: lu.error };
  const p = lu.poste;

  const req = await loadRequest(found.scope, found.requestId);
  const devise = deviseDuPoste(found.scope, cell.serviceKind);
  const amountDzd = versDzd(p.amount, devise, tauxDe(found.scope, req));
  // LE MONTANT NE S'ÉCRIT QUE S'IL EST ENVOYÉ : un montant d'avant (en DZD, sans montant saisi) reste tel quel.
  const ancien = avant.amount ?? (avant.currency === devise ? avant.amountDzd : null);
  const montantEnvoye = envoye.amount !== undefined && (p.amount ?? null) !== (ancien ?? null);
  if (cell.expenseOrderId && montantEnvoye) {
    return { ok: false, error: "Une dépense a été engagée sur ce poste : son montant ne change plus d'ici." };
  }

  await prisma.careCell.update({
    where: { id },
    data: {
      label: p.label ?? cell.label, notes: p.notes,
      dateStart: p.dateStart, dateEnd: p.dateEnd,
      trajet: p.trajet, transport: p.transport, fromCity: p.fromCity, toCity: p.toCity,
      segments: p.segments && p.segments.length ? (p.segments as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      hotelName: p.hotelName, city: p.city, roomType: p.roomType, timeStart: p.timeStart, address: p.address,
      ...(montantEnvoye ? { amount: p.amount, currency: devise, amountDzd } : {}),
    },
  });
  // LA FICHE CHEZ L'ASSISTANTE (14/10) : un billet / un hôtel modifié après l'envoi passe « à renvoyer ».
  if (cell.serviceKind === "TICKET" || cell.serviceKind === "HOTEL") await noterModificationFiche("CARE_CELL", id, user.id);
  await audit(user, found.scope, found.requestId, "UPDATE",
    `${nom} — poste « ${p.label ?? cell.label} » enregistré${montantEnvoye && p.amount != null ? ` (${montantLisible(p.amount, devise)}${devise === "USD" && amountDzd != null ? ` = ${montantLisible(amountDzd)}` : ""})` : ""}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id, message: "Poste enregistré." };
}

/**
 * LE BILLET ÉMIS / LA CONFIRMATION D'HÔTEL (Direction, 10/2026) — sur le billet : l'e-billet (PDF), la
 * référence de réservation (PNR) et, pour CHAQUE trajet (aller, retour, ou chaque étape), le n° de vol / train
 * et les heures ; sur l'hôtel : le voucher et le n° de confirmation. C'est ce que lira le livret de séjour.
 *
 * Ouvert à l'assistante de direction (qui réserve), au demandeur, à la Direction Marketing, au Super Admin et
 * à la Direction (`peutTeleverserBillet`). Le fichier rejoint les documents de la demande (`stepKey` = la case) ;
 * un nouveau fichier remplace le lien, l'ancien reste dans les documents (rien ne s'efface en silence).
 */
export async function enregistrerBilletEmis(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const cell = await prisma.careCell.findUnique({ where: { id }, select: { ...CELL_FICHE_SELECT, beneficiaryId: true } });
  if (!cell || cell.kind !== "SERVICE" || (cell.serviceKind !== "TICKET" && cell.serviceKind !== "HOTEL")) {
    return { ok: false, error: "Seuls un billet ou un hôtel portent un billet émis ou une confirmation." };
  }
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  const req = await loadRequest(found.scope, found.requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!peutTeleverserBillet({ id: user.id, roles: rolesDe(user), vueGlobale: hasGlobalView(user) }, { requesterId: req.requesterId })) {
    return { ok: false, error: "Le billet émis se dépose par l'assistante de direction, le demandeur, la Direction Marketing ou le Super Admin." };
  }
  // LA DIRECTION MARKETING, PAR SA FICHE : elle dépose sur les demandes qu'elle voit — pas sur un identifiant deviné.
  // L'assistante de direction réserve pour TOUTES les demandes (elle n'a pas le module : sa porte est son rôle).
  const sansFiche = hasRole(user, "DIRECTION_ASSISTANT") || hasRole(user, "SUPER_ADMIN") || hasGlobalView(user) || req.requesterId === user.id;
  if (!sansFiche && !(await canAccessEntity(user, SPEC[found.scope].module, found.requestId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  if (cell.status === "WAIVED") return { ok: false, error: "Ce poste est déclaré sans objet : rouvrez-le avant d'y joindre un billet." };

  const billet = cell.serviceKind === "TICKET";
  const avant = versCellRow(cell);
  let legDetails: Prisma.InputJsonValue | undefined;
  if (billet && formData.has("legDetails")) {
    const lus = lireDetailsTrajets(fdStr(formData, "legDetails") ?? "", etapesDuBillet(avant).length);
    if (!lus.ok) return { ok: false, error: lus.error };
    legDetails = lus.details as unknown as Prisma.InputJsonValue;
  }
  const bookingRef = formData.has("bookingRef") ? (fdStr(formData, "bookingRef")?.slice(0, 60) ?? null) : undefined;

  const fichier = formData.get("file");
  let issuedDocumentId: string | undefined;
  if (fichier instanceof File && fichier.size > 0) {
    const r = await persistUploadedDocument(user.id, {
      entityType: SPEC[found.scope].module, entityId: found.requestId, category: "SUPPORTING_DOC", confidentiality: "INTERNAL", stepKey: cell.id, file: fichier,
    });
    if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le fichier n'a pas pu être enregistré." };
    issuedDocumentId = r.documentId;
  }
  if (legDetails === undefined && bookingRef === undefined && issuedDocumentId === undefined) return { ok: false, error: "Rien à enregistrer." };

  await prisma.careCell.update({
    where: { id },
    data: {
      ...(legDetails !== undefined ? { legDetails } : {}),
      ...(bookingRef !== undefined ? { bookingRef } : {}),
      ...(issuedDocumentId ? { issuedDocumentId } : {}),
    },
  });
  const nom = await nameOf(found.beneficiary);
  const quoi = billet ? "billet émis" : "confirmation d'hôtel";
  await audit(user, found.scope, found.requestId, "UPDATE", `${nom} — ${quoi}${issuedDocumentId ? " déposé" : " mis à jour"}${bookingRef ? ` (réf. ${bookingRef})` : ""}.`);
  revalidate(found.scope, found.requestId);
  return { ok: true, id, message: billet ? "Billet émis enregistré." : "Confirmation d'hôtel enregistrée." };
}

// ───────────────────────────── Les devis ─────────────────────────────

/**
 * Enregistre un devis reçu par le secrétariat, en désignant **ce qu'il couvre**.
 *
 * Un devis couvre ce qu'il couvre réellement : une agence de voyage chiffre le groupe entier,
 * on ne lui demande pas de découper en dix lignes. D'où le rattachement à N cases.
 */
export async function createCareQuote(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  if (!isScope(scopeRaw)) return { ok: false, error: "Périmètre inconnu." };

  const requestId = fdStr(formData, "requestId");
  const supplier = fdStr(formData, "supplier");
  // QUI SAISIT UN DEVIS (audit Assistante de direction, 10/2026) : qui tient la fiche, comme avant — et
  // l'assistante de direction à qui l'on a DEMANDÉ les devis de cette prise en charge, qui n'a pas le module
  // (`care-devis-acces.ts`). Sans elle, les devis repartaient par e-mail.
  if (!requestId) return { ok: false, error: "Demande non précisée." };
  if (!(await peutSaisirLesDevis(user, scopeRaw, requestId))) {
    return { ok: false, error: canEdit(user, scopeRaw) ? "Demande introuvable." : "Non autorisé." };
  }
  if (!supplier) return { ok: false, error: "Le fournisseur est obligatoire." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  // LE MONTANT, DANS LA DEVISE DE CE QU'IL COUVRE (Direction, 10/2026). `amount` est saisi dans la devise des
  // postes couverts ; un appelant d'avant envoie `amountDzd`, qui reste un montant en dinars.
  const saisi = formData.has("amount") ? lireMontant(fdStr(formData, "amount")) : null;
  if (saisi && !saisi.ok) return { ok: false, error: "Le montant du devis est illisible (ex. 286000 ou 1250,50)." };
  const montantDzdDAvant = saisi ? null : fdNum(formData, "amountDzd");
  const montant = saisi?.ok ? saisi.montant : montantDzdDAvant;
  if (montant == null || montant <= 0) return { ok: false, error: "Le montant du devis est obligatoire." };

  // EN MODE « DE GROUPE », un devis couvre une CATÉGORIE pour tout le monde : les cases se déduisent.
  const categorie = fdStr(formData, "categorie") as CareServiceKind | null;
  if (categorie && !(categorie in SERVICE_KIND_LABELS)) return { ok: false, error: "Catégorie inconnue." };
  let cellIds = formData.getAll("cellIds").map(String).filter(Boolean);
  if (cellIds.length === 0 && categorie) {
    cellIds = await casesDeLaCategorieDemandee(scopeRaw, requestId, categorie);
    if (cellIds.length === 0) return { ok: false, error: `Aucune personne n'a de poste « ${SERVICE_KIND_LABELS[categorie]} » à couvrir.` };
  }
  if (cellIds.length === 0) return { ok: false, error: "Précisez ce que ce devis couvre." };
  cellIds = [...new Set(cellIds)];

  // Les cases doivent appartenir à CETTE demande : sans quoi un devis pourrait engager une
  // dépense sur une autre prise en charge.
  const couvertes = await prisma.careCell.findMany({
    where: { id: { in: cellIds }, beneficiary: parentWhere(scopeRaw, requestId) },
    select: { id: true, serviceKind: true },
  });
  if (couvertes.length !== cellIds.length) return { ok: false, error: "Certains éléments n'appartiennent pas à cette demande." };
  // RIEN NE S'ENGAGE AVANT LA PRÉVALIDATION ET L'ACCORD (27/10/2026) : pas de devis sur une demande non
  // prévalidée, ni sur une personne qui n'est pas « Accordée » (`care-engagement.ts`).
  const refusEngagement = await refusEngagementPriseEnCharge(scopeRaw, requestId, cellIds);
  if (refusEngagement) return { ok: false, error: refusEngagement };

  // LA DEVISE DE SAISIE : celle des postes couverts, sauf si l'appelant la DIT (`devise`) — l'assistante de
  // direction qui joint le devis d'une agence en dinars ne doit pas le voir relu en dollars (×240).
  const deviseBrute = fdStr(formData, "devise");
  if (deviseBrute && deviseBrute !== "DZD" && deviseBrute !== "USD") return { ok: false, error: "Devise inconnue (DZD ou USD)." };
  const chiffre = chiffrerLeDevis(scopeRaw, req, deviseBrute, Boolean(saisi), couvertes, montant);
  if (!chiffre.ok) return { ok: false, error: chiffre.error };
  const { devise, amountDzd } = chiffre;
  if (amountDzd == null) return { ok: false, error: "Le taux de conversion de cette demande est inconnu : le devis en dollars ne peut pas être converti." };
  const natures = new Set(couvertes.map((c) => c.serviceKind));
  const serviceKind = categorie ?? (natures.size === 1 ? [...natures][0] ?? null : null);

  // LE PDF DU DEVIS, s'il est joint : il rejoint les documents de la demande (catégorie « devis »).
  const fichier = formData.get("file");
  let documentId: string | null = null;
  if (fichier instanceof File && fichier.size > 0) {
    const r = await persistUploadedDocument(user.id, {
      entityType: SPEC[scopeRaw].module, entityId: requestId, category: "QUOTE", confidentiality: "INTERNAL", stepKey: null, file: fichier,
    });
    if (!r.ok || !r.documentId) return { ok: false, error: r.error ?? "Le fichier du devis n'a pas pu être enregistré." };
    documentId = r.documentId;
  }

  try {
    const quote = await prisma.careQuote.create({
      data: {
        ...parentWhere(scopeRaw, requestId),
        supplier,
        reference: fdStr(formData, "reference"),
        amountDzd,
        amount: montant,
        currency: devise.devise,
        serviceKind,
        documentId,
        note: fdStr(formData, "note"),
        createdById: user.id,
        cells: { create: cellIds.map((cellId) => ({ cellId })) },
      },
      select: { id: true },
    });
    // Les cases couvertes passent à « reçu » : on a une offre, elle n'est pas encore validée.
    await prisma.careCell.updateMany({ where: { id: { in: cellIds }, status: "REQUESTED" }, data: { status: "PROVIDED" } });

    await audit(user, scopeRaw, requestId, "CREATE",
      `Devis ${supplier} — ${montantLisible(montant, devise.devise)}${devise.devise === "USD" ? ` (${montantLisible(amountDzd)})` : ""}, couvrant ${cellIds.length} élément(s).`);
    revalidate(scopeRaw, requestId);
    return { ok: true, id: quote.id, message: "Devis enregistré — retenez-le quand il convient." };
  } catch (err) {
    console.error("[care] enregistrement du devis impossible", err);
    if (documentId) {
      const doc = await prisma.document.delete({ where: { id: documentId } }).catch(sansBloquer("care-actions.createCareQuote.document", null));
      if (doc?.fileKey) await deleteFileByKey(doc.fileKey).catch(sansBloquer("care-actions.createCareQuote.deleteFileByKey"));
    }
    return { ok: false, error: "Le devis n'a pas pu être enregistré." };
  }
}

/**
 * RETENIR UNE PROPOSITION — comme au sponsoring : le demandeur choisit le devis qui convient parmi ceux
 * reçus ; un autre devis retenu qui couvre les mêmes postes cesse de l'être (au plus une proposition retenue
 * par poste). Une fois le BC demandé, le choix ne change plus d'ici. `annuler` retire le choix.
 */
export async function retenirDevisPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Devis non précisé." };
  const quote = await prisma.careQuote.findUnique({
    where: { id },
    select: { id: true, supplier: true, status: true, retainedAt: true, bcRequestedAt: true, congressNationalId: true, congressInternationalId: true, cells: { select: { cellId: true } } },
  });
  if (!quote) return { ok: false, error: "Devis introuvable." };
  const scope: Scope = quote.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = quote.congressNationalId ?? quote.congressInternationalId;
  if (!requestId) return { ok: false, error: "Devis orphelin." };
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  if (quote.status !== "PENDING") return { ok: false, error: "Ce devis est déjà tranché par la Direction : son choix ne change plus." };
  if (quote.bcRequestedAt) return { ok: false, error: "Le BC de ce devis est déjà demandé : le choix ne change plus d'ici." };
  const annuler = fdStr(formData, "annuler") === "on";

  if (annuler) {
    await prisma.careQuote.updateMany({ where: { id, bcRequestedAt: null }, data: { retainedAt: null, retainedById: null } });
    await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} : n'est plus la proposition retenue.`);
    revalidate(scope, requestId);
    return { ok: true, id, message: "Le devis n'est plus retenu." };
  }

  const cellIds = quote.cells.map((c) => c.cellId);
  const rivaux = await devisRivaux(scope, requestId, id, cellIds);
  const engage = rivaux.find((r) => r.bcRequestedAt);
  if (engage) return { ok: false, error: `Le devis ${engage.supplier}, déjà retenu pour ces postes, a son BC demandé : il reste le choix.` };
  await retenirALaPlace(id, rivaux, user.id);
  await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} RETENU${rivaux.length ? ` (à la place de ${rivaux.map((r) => r.supplier).join(", ")})` : ""}.`);
  await signalerPorteDgSiBesoin(SPEC[scope].module, requestId);
  revalidate(scope, requestId);
  return { ok: true, id, message: `Devis ${quote.supplier} retenu${rivaux.length ? " — l'autre proposition est écartée" : ""}. Demandez le BC quand tout est prêt.` };
}

/**
 * Accepte ou refuse un devis — **d'un bloc**. Accepter la moitié d'un devis n'a pas de sens
 * commercial : le fournisseur a chiffré un ensemble.
 *
 * ⚠️ Le garde-fou : une case déjà couverte par un devis accepté ne peut pas l'être une seconde
 * fois. C'est ce qui empêche de payer deux fois le même hôtel.
 */
export async function decideCareQuote(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || (decision !== "ACCEPTED" && decision !== "REJECTED")) return { ok: false, error: "Décision non précisée." };

  const quote = await devisATrancher(id);
  if (!quote) return { ok: false, error: "Devis introuvable." };
  const scope: Scope = quote.congressNationalId ? "NATIONAL" : "INTERNATIONAL";
  const requestId = quote.congressNationalId ?? quote.congressInternationalId;
  if (!requestId) return { ok: false, error: "Devis orphelin." };
  if (!canDecide(user, scope)) return { ok: false, error: "Seule la Direction tranche un devis." };
  if (quote.expenseOrderId) return { ok: false, error: "Ce devis a déjà été engagé : sa décision ne peut plus changer." };

  const cellIds = quote.cells.map((c) => c.cellId);

  // ACCEPTER ENGAGE LA DÉPENSE (27/10/2026) : la demande prévalidée, chaque personne couverte accordée, et une
  // catégorie budgétaire — l'ordre né du devis la porte, il n'échappe plus aux enveloppes.
  let budgetCategoryId: string | null = null;
  if (decision === "ACCEPTED") {
    const refusEngagement = await refusEngagementPriseEnCharge(scope, requestId, cellIds);
    if (refusEngagement) return { ok: false, error: refusEngagement };
    // LE DG SUR LE TOTAL (27/10/2026) : au-dessus du seuil, aucun ordre sans sa validation. Un devis
    // accepté sans avoir été retenu n'est pas encore dans le total : il y entre ici.
    const refusDg = await refusSiPorteDgFermee(SPEC[scope].module, requestId, quote.status === "PENDING" && !quote.retainedAt ? toNumber(quote.amountDzd) : 0);
    if (refusDg) {
      await signalerPorteDgSiBesoin(SPEC[scope].module, requestId);
      return { ok: false, error: refusDg };
    }
    budgetCategoryId = fdStr(formData, "budgetCategoryId");
    if (!budgetCategoryId) return { ok: false, error: "Choisissez la catégorie budgétaire du devis : l'ordre de dépense qu'il émet l'impute à son enveloppe." };
    const cat = await prisma.budgetCategoryLine.count({ where: { id: budgetCategoryId } });
    if (cat === 0) return { ok: false, error: "La catégorie budgétaire choisie est introuvable." };
  }

  if (decision === "ACCEPTED") {
    const conflit = await conflitDeCouverture(scope, requestId, id, quote.amountDzd, cellIds);
    if (conflit) return { ok: false, error: conflit };
  }

  const req = await loadRequest(scope, requestId);

  // UN DEVIS N'ÉMET QU'UN ORDRE, MÊME À DEUX CLICS (audit argent 2026-10-27, ARGENT-02). Le garde « déjà engagé »
  // était lu en tête, l'ordre créé ensuite, et le devis écrit par son seul id : deux acceptations simultanées
  // passaient toutes deux la lecture et émettaient DEUX ordres au centre de paiement — le second écrasait le
  // lien du premier, qui restait payable sans que rien ne le rattache plus au devis. Le devis se RÉSERVE donc
  // d'abord, sur l'état lu (§118.151) : seul le gagnant émet l'ordre ; un échec de l'émission rend la réserve.
  if (decision === "ACCEPTED" && !(await reserverLeDevis(quote, user.id))) {
    return { ok: false, error: "Ce devis vient d'être tranché (ou engagé) par quelqu'un d'autre : rechargez la page." };
  }
  const rendreLaReserve = () => rendreLaReserveDuDevis(quote);

  let ordreNe = false;
  try {
    if (decision === "ACCEPTED") {
      const amount = toNumber(quote.amountDzd);
      const order = await createExpenseOrder({
        label: `${req?.name ?? "Prise en charge"} — devis ${quote.supplier}`,
        amount,
        category: "EVENEMENT",
        beneficiary: quote.supplier,
        sourceType: SPEC[scope].module,
        sourceId: requestId,
        requestedById: user.id,
        budgetCategoryId,
        // LE BUDGET EST EN DZD : un devis saisi en dollars entre à son équivalent au taux figé de la demande.
        notes: `Devis couvrant ${cellIds.length} élément(s) de la prise en charge.${quote.currency === "USD" && quote.amount != null ? ` Saisi : ${montantLisible(toNumber(quote.amount), "USD")} (converti au taux de la demande).` : ""}`,
      });
      ordreNe = true;
      await rattacherLOrdre(id, cellIds, order.id, user.id);
      await audit(user, scope, requestId, "UPDATE",
        `Devis ${quote.supplier} ACCEPTÉ (${amount.toLocaleString("fr-FR")} DZD) — ordre de dépense ${order.reference}.`);
    } else {
      await refuserLeDevis(id, cellIds, user.id, fdStr(formData, "note"));
      await audit(user, scope, requestId, "UPDATE", `Devis ${quote.supplier} REFUSÉ — les éléments couverts repassent en attente.`);
    }

    revalidate(scope, requestId);
    revalidatePath("/finances/paiements-a-faire");
    return { ok: true, id };
  } catch (err) {
    console.error("[care] décision de devis impossible", err);
    // L'ordre n'est pas né : la réserve se rend. Né mais non rattaché, le devis RESTE réservé — le rendre
    // laisserait accepter une seconde fois, donc émettre un second ordre.
    if (decision === "ACCEPTED" && !ordreNe) await rendreLaReserve();
    return { ok: false, error: "La décision n'a pas pu être enregistrée." };
  }
}

// ───────────────────────────── Secrétariat & Finances ─────────────────────────────

/** Sollicite le secrétariat pour obtenir les devis des éléments à acheter. */
export async function requestCareQuotes(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  // Elle écrit désormais dans le sujet de l'assistante : la même porte que la demande de réservation.
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };

  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!(await demandePrevalidee(scopeRaw, requestId))) return { ok: false, error: REFUS_NON_PREVALIDEE };

  const toQuote = await prisma.careCell.count({
    where: { beneficiary: { ...parentWhere(scopeRaw, requestId), status: "APPROVED" }, kind: "SERVICE", status: "REQUESTED" },
  });
  if (toQuote === 0) return { ok: false, error: "Aucun élément n'attend de devis." };

  // UNE PORTE QU'ELLE PEUT OUVRIR (audit Assistante de direction, 10/2026). La notification menait à la fiche du
  // congrès — un module que l'assistante n'a pas. La demande s'écrit désormais dans SON sujet (celui de la
  // réservation, ouvert s'il n'existe pas : c'est lui qui la désigne), et le lien mène à la page « Devis » de la
  // prise en charge, où elle les saisit (`care-devis-acces.ts`).
  const lienDevis = `${SPEC[scopeRaw].path}/${requestId}/devis`;
  const sujet = await ecrireAAssistante(scopeRaw, req, user, "Demande de devis.",
    `${toQuote} élément(s) à chiffrer — saisissez chaque devis reçu (fournisseur, montant, PDF) : ${lienDevis}`);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  await notifyRoles(["DIRECTION_ASSISTANT", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Devis à obtenir — prise en charge",
    body: `${req.name} : ${toQuote} élément(s) à chiffrer.`,
    link: lienDevis,
  }).catch(sansBloquer("care-actions.requestCareQuotes.notifyRoles"));

  await audit(user, scopeRaw, requestId, "UPDATE", `Secrétariat sollicité pour ${toQuote} devis — sujet ${sujet.reference}.`);
  revalidate(scopeRaw, requestId);
  revalidatePath("/dossiers");
  return { ok: true, message: `Le secrétariat est prévenu — ${toQuote} élément(s) à chiffrer (sujet ${sujet.reference}).` };
}

/**
 * Envoie la demande aux Finances.
 *
 * Refuse tant que quelque chose manque, en DISANT quoi : une personne accordée dont il manque
 * le passeport, ou un devis qui attend encore une décision. Envoyer aux Finances un dossier
 * incomplet, c'est produire un montant faux puis le corriger à la main.
 */
export async function sendCareToFinance(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canDecide(user, scopeRaw)) return { ok: false, error: "Seule la Direction envoie aux Finances." };

  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const { rows, readiness } = await etatPourLesFinances(scopeRaw, requestId);
  if (!readiness.ready) return { ok: false, error: readiness.blockers.join(" ") };

  await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Prise en charge à régler",
    body: `${req.name} — dossier complet, ${rows.filter((r) => r.status === "APPROVED").length} personne(s) prise(s) en charge.`,
    link: "/finances/paiements-a-faire",
  }).catch(sansBloquer("care-actions.sendCareToFinance.notifyRoles"));
  if (req.requesterId) {
    await notifyUser({
      userId: req.requesterId, type: "GENERIC",
      title: "Prise en charge transmise aux Finances",
      body: `${req.name} — le dossier est complet.`,
      link: `${SPEC[scopeRaw].path}/${requestId}`,
    }).catch(sansBloquer("care-actions.sendCareToFinance.notifyUser"));
  }

  // LA TRACE QU'ON RELIT : « Marquer réalisée » ne s'ouvre qu'après cet envoi (`envoiAuxFinances`).
  await recordAudit({
    actorId: user.id, module: SPEC[scopeRaw].module, entityType: SPEC[scopeRaw].module, entityId: requestId,
    action: "UPDATE", field: ENVOI_FINANCES_CHAMP, summary: ENVOI_FINANCES_RESUME,
  }).catch(sansBloquer("care-actions.sendCareToFinance.recordAudit"));
  revalidate(scopeRaw, requestId);
  return { ok: true, message: "Les Finances sont prévenues — le dossier est complet." };
}

/**
 * MARQUER LA PRISE EN CHARGE « RÉALISÉE » (Direction, 27/10) — pose `COMPLETED`, jusque-là posé par l'import
 * seulement. Le demandeur ou la Direction Marketing (`peutMarquerRealisee`), sur une demande validée ET déjà
 * transmise aux Finances : avant, l'événement n'est pas soldé et « Réalisé » mentirait. Trace d'audit.
 */
export async function marquerPriseEnChargeRealisee(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  if (!peutMarquerRealisee({ id: user.id, roles: rolesDe(user) }, { requesterId: req.requesterId })) {
    return { ok: false, error: "Seuls le demandeur ou la Direction Marketing marquent une prise en charge réalisée." };
  }
  // LA DIRECTION MARKETING, PAR SA FICHE : elle marque les demandes qu'elle voit — pas un identifiant deviné.
  const sansFiche = req.requesterId === user.id || hasRole(user, "SUPER_ADMIN");
  if (!sansFiche && !(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "VIEW"))) return { ok: false, error: "Demande introuvable." };
  if (req.requestStatus === "COMPLETED") return { ok: false, error: "Cette prise en charge est déjà marquée réalisée." };
  if (req.requestStatus !== "APPROVED") return { ok: false, error: "Seule une prise en charge validée se marque réalisée." };
  if (!(await envoiAuxFinances(scopeRaw, requestId))) {
    return { ok: false, error: "Transmettez d'abord le dossier aux Finances : une prise en charge se marque réalisée après cet envoi." };
  }

  const n = await poserLaFin(scopeRaw, requestId, user.id);
  if (n.count === 0) return { ok: false, error: "La demande a changé entre-temps — rechargez la page." };

  await recordAudit({
    actorId: user.id, module: SPEC[scopeRaw].module, entityType: SPEC[scopeRaw].module, entityId: requestId,
    action: "UPDATE", field: "requestStatus", oldValue: "APPROVED", newValue: "COMPLETED",
    summary: `Prise en charge « ${req.name} » marquée réalisée.`,
  });
  revalidate(scopeRaw, requestId);
  revalidatePath("/ad-pro");
  return { ok: true, message: "Prise en charge marquée réalisée." };
}

/** L'annuaire, pour le sélecteur de personnes. */
export async function careDirectoryOptions(): Promise<{ id: string; name: string; specialty: string | null; institution: string | null }[]> {
  await requireUser();
  return praticiensDeLAnnuaire();
}

/**
 * Rattache un matériel promotionnel à la case d'UNE personne.
 *
 * Une prise en charge s'accompagne souvent d'un support produit — brochure, kit, présentoir —
 * destiné à cette personne-là. On ne recopie jamais le circuit du matériel ici : il a le sien
 * (visa publicitaire, conformité information médicale, agence, BAT), et la case en montre
 * seulement l'avancement. Deux vérités sur le même objet finiraient par diverger.
 */
export async function linkCareCellPromoMaterial(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Élément non précisé." };

  const cell = await prisma.careCell.findUnique({ where: { id }, select: { id: true, label: true, beneficiaryId: true } });
  if (!cell) return { ok: false, error: "Élément introuvable." };
  const found = await scopeOfBeneficiary(cell.beneficiaryId);
  if (!found) return { ok: false, error: "Personne introuvable." };
  if (!canEdit(user, found.scope)) return { ok: false, error: "Non autorisé." };

  const promoMaterialId = fdStr(formData, "promoMaterialId");
  if (promoMaterialId) {
    const pm = await prisma.promoMaterial.findUnique({ where: { id: promoMaterialId }, select: { reference: true } });
    if (!pm) return { ok: false, error: "Matériel promotionnel introuvable." };
    await prisma.careCell.update({
      where: { id },
      data: { promoMaterialId, kind: "SERVICE", serviceKind: "PROMO_MATERIAL" },
    });
    await audit(user, found.scope, found.requestId, "UPDATE",
      `${await nameOf(found.beneficiary)} — « ${cell.label} » rattaché au matériel ${pm.reference}.`);
  } else {
    await prisma.careCell.update({ where: { id }, data: { promoMaterialId: null } });
    await audit(user, found.scope, found.requestId, "UPDATE",
      `${await nameOf(found.beneficiary)} — « ${cell.label} » détaché de son matériel promotionnel.`);
  }

  revalidate(found.scope, found.requestId);
  return { ok: true, id };
}

// ───────────────────────────── Réservation et BC — l'assistante de direction ─────────────────────────────

/**
 * DEMANDER LA RÉSERVATION EN BLOC — FERMÉ (Direction, 27/10). La réservation d'une prise en charge se fait FICHE
 * PAR FICHE (`DemandeReservation`, `reservation-fiche-actions.ts`) : chaque billet ou hôtel part seul et a son état.
 * Ce geste n'écrit plus rien et le dit ; les envois en bloc déjà faits ont été repris en fiches (migration
 * `20270131120000_reservation_par_fiche_seule`).
 */
export async function demanderReservationPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  return {
    ok: false,
    error: "La réservation se demande désormais fiche par fiche : envoyez chaque billet ou hôtel à l'assistante depuis la fiche voyageur (« Envoyer », ou « Envoyer les fiches prêtes »).",
  };
}

/**
 * DEMANDER LE BC — d'après les devis RETENUS (comme `demanderBCBilletterie`) : la liste part dans le sujet de
 * l'assistante de direction, chaque devis est marqué « BC demandé » (son choix ne change plus), et la Direction
 * est prévenue qu'il reste à l'accepter — c'est l'acceptation qui émet l'ordre de dépense, en DZD.
 * `quoteIds` restreint la demande (le BC d'une fiche) ; sans lui, tous les devis retenus en attente partent.
 */
export async function demanderBCPriseEnCharge(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };

  const voulus = formData.getAll("quoteIds").map(String).filter(Boolean);
  const retenus = await devisRetenus(scopeRaw, requestId, voulus);
  if (retenus.length === 0) return { ok: false, error: "Retenez d'abord un devis : le bon de commande s'établit d'après les propositions retenues." };
  // Pas de BC avant la prévalidation de la demande ni l'accord de chaque personne couverte (27/10/2026).
  const refusEngagement = await refusEngagementPriseEnCharge(scopeRaw, requestId, retenus.flatMap((q) => q.cells.map((c) => c.cellId)));
  if (refusEngagement) return { ok: false, error: refusEngagement };
  // Ni BC au-dessus du seuil sans la validation du TOTAL par le DG (27/10/2026) — les devis retenus y sont.
  const refusDg = await refusSiPorteDgFermee(SPEC[scopeRaw].module, requestId);
  if (refusDg) {
    await signalerPorteDgSiBesoin(SPEC[scopeRaw].module, requestId);
    return { ok: false, error: refusDg };
  }

  const { total, corps } = await demandeDeBc(scopeRaw, requestId, retenus, fdStr(formData, "note"));

  const sujet = await ecrireAAssistante(scopeRaw, req, user, "Demande de bon de commande.", corps);
  if (!sujet.ok) return { ok: false, error: sujet.error };
  const marques = await marquerBcDemande(retenus, user.id);
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: "Prise en charge — devis retenus à accepter",
    body: `${req.name} — ${marques.count} devis retenu(s), BC demandé à l'assistante de direction.`,
    link: `${SPEC[scopeRaw].path}/${requestId}`,
  }).catch(sansBloquer("care-actions.demanderBCPriseEnCharge.notifyRoles"));
  await audit(user, scopeRaw, requestId, "UPDATE", `BC demandé pour ${marques.count} devis retenu(s) — sujet ${sujet.reference}.`);
  revalidate(scopeRaw, requestId);
  revalidatePath("/dossiers");
  const depasse = req.finalAmount != null && total > toNumber(req.finalAmount)
    ? ` Les devis retenus (${montantLisible(Math.round(total * 100) / 100)}) dépassent l'enveloppe accordée : la Direction le verra.`
    : "";
  return { ok: true, id: sujet.id, message: `BC demandé pour ${marques.count} devis — sujet ${sujet.reference}, l'assistante de direction est prévenue.${depasse}` };
}

// ───────────────────────────── Postes de groupe ─────────────────────────────

/**
 * AJOUTER UN POSTE DE GROUPE — « repas 100 par personne » (Direction, 10/2026) : un montant PAR PERSONNE qui
 * s'applique à chacun ; en dollars à l'international (sauf billetterie), converti au taux figé de la demande.
 */
export async function ajouterPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const scopeRaw = fdStr(formData, "scope") ?? "";
  const requestId = fdStr(formData, "requestId");
  if (!isScope(scopeRaw) || !requestId) return { ok: false, error: "Demande non précisée." };
  if (!canEdit(user, scopeRaw)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scopeRaw].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  const req = await loadRequest(scopeRaw, requestId);
  if (!req) return { ok: false, error: "Demande introuvable." };
  const type = typePoste(fdStr(formData, "posteType"));
  if (!type) return { ok: false, error: "Choisissez la catégorie du poste." };
  const lu = lirePosteSaisi(type.serviceKind === "TICKET" || type.serviceKind === "HOTEL" ? "OTHER" : type.serviceKind, req.name, {
    label: fdStr(formData, "label"), notes: fdStr(formData, "notes"), dateStart: fdStr(formData, "date"), amount: fdStr(formData, "unitAmount"),
    timeStart: fdStr(formData, "timeStart"), address: fdStr(formData, "address"),
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const devise = deviseDuPoste(scopeRaw, type.serviceKind);
  const created = await creerPosteGroupe(scopeRaw, requestId, req, type, lu.poste, devise, user.id);
  await audit(user, scopeRaw, requestId, "CREATE", `Poste de groupe « ${created.label} »${lu.poste.amount != null ? ` — ${montantLisible(lu.poste.amount, devise)} par personne` : ""}.`);
  revalidate(scopeRaw, requestId);
  return { ok: true, id: created.id, message: "Poste de groupe ajouté — il s'applique à chaque personne." };
}

/**
 * MODIFIER UN POSTE DE GROUPE — son libellé, sa date, son montant par personne, son état ; et EXCLURE ou
 * réinclure UNE personne (`exclure` / `inclure` = l'identifiant de la fiche), sans toucher aux autres.
 */
export async function modifierPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await chargerPosteGroupe(id);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { g, scope, requestId } = found;
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };

  const exclure = fdStr(formData, "exclure");
  const inclure = fdStr(formData, "inclure");
  if (exclure || inclure) {
    const qui = (exclure ?? inclure)!;
    const appartient = await prisma.careBeneficiary.count({ where: { id: qui, ...parentWhere(scope, requestId) } });
    if (!appartient) return { ok: false, error: "Personne introuvable sur cette demande." };
    await exclureOuReinclure(g, qui, Boolean(exclure), user.id);
    await audit(user, scope, requestId, "UPDATE", `Poste de groupe « ${g.label} » : une personne ${exclure ? "exclue" : "réincluse"}.`);
    revalidate(scope, requestId);
    return { ok: true, id, message: exclure ? "Personne exclue de ce poste." : "Personne réincluse dans ce poste." };
  }

  const req = await loadRequest(scope, requestId);
  const lu = lirePosteSaisi("OTHER", req?.name ?? "", {
    label: formData.has("label") ? fdStr(formData, "label") : g.label,
    notes: formData.has("notes") ? fdStr(formData, "notes") : g.notes,
    dateStart: formData.has("date") ? fdStr(formData, "date") : (g.date ? g.date.toISOString().slice(0, 10) : null),
    amount: formData.has("unitAmount") ? fdStr(formData, "unitAmount") : (g.unitAmount != null ? String(toNumber(g.unitAmount)) : null),
    timeStart: formData.has("timeStart") ? fdStr(formData, "timeStart") : g.timeStart,
    address: formData.has("address") ? fdStr(formData, "address") : g.address,
  });
  if (!lu.ok) return { ok: false, error: lu.error };
  const status = fdStr(formData, "status") as CareCellStatus | null;
  if (status && !["REQUESTED", "PROVIDED", "SETTLED", "WAIVED"].includes(status)) return { ok: false, error: "État inconnu." };
  const devise = deviseDuPoste(scope, g.serviceKind);
  await prisma.careGroupPoste.update({
    where: { id },
    data: {
      label: lu.poste.label ?? g.label, notes: lu.poste.notes, date: lu.poste.dateStart,
      timeStart: lu.poste.timeStart, address: lu.poste.address,
      unitAmount: lu.poste.amount, currency: devise, unitAmountDzd: versDzd(lu.poste.amount, devise, tauxDe(scope, req)),
      ...(status ? { status } : {}), updatedById: user.id,
    },
  });
  await audit(user, scope, requestId, "UPDATE", `Poste de groupe « ${lu.poste.label ?? g.label} » modifié.`);
  revalidate(scope, requestId);
  return { ok: true, id, message: "Poste de groupe enregistré." };
}

export async function retirerPosteGroupe(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Poste non précisé." };
  const found = await chargerPosteGroupe(id);
  if (!found) return { ok: false, error: "Poste introuvable." };
  const { g, scope, requestId } = found;
  if (!canEdit(user, scope)) return { ok: false, error: "Non autorisé." };
  if (!(await canAccessEntity(user, SPEC[scope].module, requestId, "UPDATE"))) return { ok: false, error: "Demande introuvable." };
  if (g.status === "SETTLED") return { ok: false, error: "Ce poste est réglé : déclarez-le plutôt « sans objet » s'il n'a plus lieu d'être." };
  await prisma.careGroupPoste.delete({ where: { id } });
  await audit(user, scope, requestId, "DELETE", `Poste de groupe « ${g.label} » retiré.`);
  revalidate(scope, requestId);
  return { ok: true, message: "Poste de groupe retiré." };
}

/** Les matériels promotionnels rattachables — pour le sélecteur. */
export async function carePromoOptions(): Promise<{ id: string; reference: string; title: string }[]> {
  await requireUser();
  return materielsRattachables();
}
