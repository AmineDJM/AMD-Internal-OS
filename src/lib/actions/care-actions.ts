"use server";

import { revalidatePath } from "next/cache";
import { type CareCellStatus, type CareServiceKind } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, hasRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { piecesADemander, SERVICE_KIND_LABELS } from "@/lib/care";
import {
  deviseDuPoste, peutTeleverserBillet, lireMontant, lirePosteSaisi, montantLisible, typePoste, peutMarquerRealisee,
} from "@/lib/care-fiches";
import { envoiAuxFinances, ENVOI_FINANCES_CHAMP, ENVOI_FINANCES_RESUME } from "@/lib/care-realisation";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { peutSaisirLesDevis } from "@/lib/care-devis-acces";
import { creerProfilMedecin } from "@/lib/medical/profil-rapide";
import { persistUploadedDocument } from "@/lib/documents";
import { deleteFileByKey } from "@/lib/storage";
import { retirerFichierDeLaPiece } from "@/lib/care-pieces-db";
import { demandePrevalidee, refusEngagementPriseEnCharge, REFUS_NON_PREVALIDEE } from "@/lib/care-engagement";
import { relierALaPersonne } from "@/modules/referentiels/api";
import { sansBloquer } from "@/lib/journal";
import {
  SPEC, canDecide, canEdit, chargerPosteGroupe, isScope, loadRequest, nameOf, parentWhere, revalidate, rolesDe,
  scopeOfBeneficiary, type Scope,
} from "@/lib/actions/internes/care/demande";
import { CELL_FICHE_SELECT } from "@/lib/actions/internes/care/fiches";
import { fichierEtSaPiece, materielsRattachables, praticiensDeLAnnuaire } from "@/lib/actions/internes/care/postes";
import { casesDeLaCategorieDemandee, chiffrerLeDevis, devisATrancher } from "@/lib/actions/internes/care/devis";
import { creerPosteGroupe, etatPourLesFinances, poserLaFin } from "@/lib/actions/internes/care/demande-suite";
import { ecrireAuSujetDeLAssistante, journaliser, ouvrirLaFiche } from "@/lib/actions/internes/care/journal";
import {
  ajouterLaCase, deposerLesFichiers, enregistrerLeBillet, enregistrerLePoste, modifierLePosteDeGroupe,
  noterLAvis, rattacherLeMateriel, trancherLaPersonne,
} from "@/lib/actions/internes/care/saisie";
import { demanderLeBc, retenirOuAnnuler, trancherLeDevis } from "@/lib/actions/internes/care/circuit";
// Découpé par responsabilité (lot V4) : aides, lectures et corps internes dans `actions/internes/care/{demande,fiches,postes,devis,demande-suite,journal,saisie,circuit}` — les actions restent ici (leur clé de contrat, leur porte).

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

// LES ÉCRIVAINS LOCAUX vivent dans `actions/internes/care/journal.ts` ; ces alias les gardent LOCAUX au fichier
// (appelés sans le formulaire, le contrat des actions ne les suit pas — comme avant leur sortie).
const audit = journaliser;
const ouvrirFiche = ouvrirLaFiche;
const ecrireAAssistante = ecrireAuSujetDeLAssistante;

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

  return noterLAvis(formData, { user, id, found });
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

  return trancherLaPersonne(formData, { user, id, decision, found });
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
  return deposerLesFichiers(formData, { user, cell, found, module });
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

  return ajouterLaCase(formData, { user, beneficiaryId, type, found });
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

  return enregistrerLePoste(formData, { user, id, cell: { ...cell, serviceKind: cell.serviceKind }, found });
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

  return enregistrerLeBillet(formData, { user, id, cell, found });
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
  return retenirOuAnnuler(formData, { user, id, quote, scope, requestId });
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

  return trancherLeDevis(formData, { user, id, decision, quote, scope, requestId });
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

  return rattacherLeMateriel(formData, { user, id, cell, found });
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

  return demanderLeBc(formData, { user, scope: scopeRaw, requestId, req });
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

  return modifierLePosteDeGroupe(formData, { user, id, found });
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
