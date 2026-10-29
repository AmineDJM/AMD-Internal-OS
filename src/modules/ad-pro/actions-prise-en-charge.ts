"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type CareCellKind, type CareCellStatus, type CareOpinion, type CareServiceKind } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, type SessionUser } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { toNumber } from "@/lib/utils";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createExpenseOrder } from "@/lib/expense-orders";
import { careProgress, defaultCells, financeReadiness, quoteConflicts, OPINION_LABELS, SERVICE_KIND_LABELS, casesDeLaCategorie, deviseDuDevis, deviseDuPoste, hotelPrerempli, libelleNouveauPoste, lireMontant, montantLisible, typePoste, versDzd, peutMarquerRealisee, TAUX_USD_DZD_DEFAUT } from "@/modules/ad-pro/partage";
import { envoiAuxFinances, ENVOI_FINANCES_CHAMP, ENVOI_FINANCES_RESUME, peutSaisirLesDevis, demandePrevalidee, prendreLesCasesDuDevis, refusEngagementPriseEnCharge, rendreLaReserveDuDevis, REFUS_NON_PREVALIDEE, refusSiPorteDgFermee, signalerPorteDgSiBesoin } from "@/modules/ad-pro/api";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { canAccessEntity } from "@/lib/entity-access";
import { creerProfilMedecin } from "@/lib/medical/profil-rapide";
import { persistUploadedDocument } from "@/lib/documents";
import { deleteFileByKey } from "@/lib/storage";
import { relierALaPersonne } from "@/modules/referentiels/api";
import { sansBloquer } from "@/lib/journal";
import { type Scope, SPEC, isScope, revalidate, canEdit, audit, loadRequest, tauxDe, CELL_FICHE_SELECT, versCellRow, ecrireAAssistante, parentWhere, scopeOfBeneficiary, nameOf, rolesDe } from "./infra/prise-en-charge/actions-commun";

/**
 * PRISE EN CHARGE — actions serveur (nationale et internationale) : les PERSONNES (ajout, avis,
 * décision par personne), les CASES de chaque fiche, les DEVIS (saisir, décider, demander), l'envoi aux
 * Finances et la réalisation — le circuit de la décision, celui qu'Adam appelle aussi.
 *
 * Ce que la prise en charge tient, et qui n'existait pas :
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
 *
 * Clé historique `care-actions` (`src/lib/actions/parc.ts`), portée avec `actions-prise-en-charge-logistique.ts` ;
 * le socle commun : `infra/prise-en-charge/actions-commun.ts`.
 */

/** Trancher (accorder une personne, accepter un devis) : Direction. */
function canDecide(user: SessionUser, scope: Scope): boolean {
  return hasGlobalView(user) || userCan(user, SPEC[scope].module, "VALIDATE");
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
  if (serviceKind === "HOTEL") {
    const req = await loadRequest(found.scope, found.requestId);
    const billet = await prisma.careCell.findFirst({ where: { beneficiaryId, kind: "SERVICE", serviceKind: "TICKET" }, orderBy: [{ position: "asc" }, { createdAt: "asc" }], select: CELL_FICHE_SELECT });
    const p = hotelPrerempli({ city: req?.city ?? null }, billet ? versCellRow(billet) : null);
    const d = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00.000Z`) : null);
    prerempli = { city: p.city, dateStart: d(p.dateStart), dateEnd: d(p.dateEnd) };
  }

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
    const personnes = await prisma.careBeneficiary.findMany({
      where: parentWhere(scopeRaw, requestId),
      select: { status: true, cells: { where: { kind: "SERVICE", serviceKind: categorie }, select: CELL_FICHE_SELECT } },
    });
    cellIds = casesDeLaCategorie(personnes.map((p) => ({ status: p.status, cells: p.cells.map(versCellRow) })), categorie);
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
  const deviseDite: "DZD" | "USD" | null = deviseBrute === "DZD" || deviseBrute === "USD" ? deviseBrute : null;
  const devise = deviseDite && saisi
    ? ({ ok: true, devise: deviseDite } as const)
    : saisi ? deviseDuDevis(scopeRaw, couvertes.map((c) => c.serviceKind)) : ({ ok: true, devise: "DZD" } as const);
  if (!devise.ok) return { ok: false, error: devise.error };
  // Un montant DIT en dollars se convertit au taux figé de la demande — 240 au national, qui n'en porte pas.
  const taux = tauxDe(scopeRaw, req) ?? (deviseDite === "USD" ? TAUX_USD_DZD_DEFAUT : null);
  const amountDzd = versDzd(montant, devise.devise, taux);
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

  const quote = await prisma.careQuote.findUnique({
    where: { id },
    select: {
      id: true, supplier: true, amountDzd: true, status: true, expenseOrderId: true, amount: true, currency: true, retainedAt: true,
      decidedById: true, decidedAt: true,
      congressNationalId: true, congressInternationalId: true,
      cells: { select: { cellId: true } },
    },
  });
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
    const others = await prisma.careQuote.findMany({
      where: { ...parentWhere(scope, requestId), id: { not: id } },
      select: { id: true, status: true, amountDzd: true, cells: { select: { cellId: true } } },
    });
    const conflicts = quoteConflicts(
      { id, status: "PENDING", amountDzd: toNumber(quote.amountDzd), cellIds },
      others.map((o) => ({ id: o.id, status: o.status, amountDzd: toNumber(o.amountDzd), cellIds: o.cells.map((c) => c.cellId) })),
    );
    if (conflicts.length > 0) {
      const labels = await prisma.careCell.findMany({ where: { id: { in: conflicts.map((c) => c.cellId) } }, select: { label: true } });
      return {
        ok: false,
        error: `Déjà couvert par un devis accepté : ${labels.map((l) => l.label).join(", ")}. Refusez d'abord l'autre devis.`,
      };
    }
  }

  const req = await loadRequest(scope, requestId);

  // UN DEVIS N'ÉMET QU'UN ORDRE, MÊME À DEUX CLICS (audit argent 2026-10-27, ARGENT-02). Le garde « déjà engagé »
  // était lu en tête, l'ordre créé ensuite, et le devis écrit par son seul id : deux acceptations simultanées
  // passaient toutes deux la lecture et émettaient DEUX ordres au centre de paiement — le second écrasait le
  // lien du premier, qui restait payable sans que rien ne le rattache plus au devis. Le devis se RÉSERVE donc
  // d'abord, sur l'état lu (§118.151) : seul le gagnant émet l'ordre ; un échec de l'émission rend la réserve.
  if (decision === "ACCEPTED") {
    const reserve = await prisma.careQuote.updateMany({
      where: { id, expenseOrderId: null, status: quote.status, decidedAt: quote.decidedAt },
      data: { status: "ACCEPTED", decidedById: user.id, decidedAt: new Date() },
    });
    if (reserve.count === 0) return { ok: false, error: "Ce devis vient d'être tranché (ou engagé) par quelqu'un d'autre : rechargez la page." };
  }
  const rendreLaReserve = () => rendreLaReserveDuDevis(id, cellIds, quote);
  // DEVIS RIVAUX SUR LES MÊMES CASES (DONNEES-08) : seul le devis qui les trouve toutes libres les prend, sous verrou.
  if (decision === "ACCEPTED" && !(await prendreLesCasesDuDevis(id, cellIds))) { await rendreLaReserve(); return { ok: false, error: "Un autre devis couvrant les mêmes éléments vient d'être accepté : rechargez la page." }; }

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
      await prisma.$transaction([
        prisma.careQuote.update({
          where: { id },
          data: { status: "ACCEPTED", decidedById: user.id, decidedAt: new Date(), expenseOrderId: order.id },
        }),
        // Les cases couvertes deviennent réglées et portent leur part de la dépense.
        prisma.careCell.updateMany({
          where: { id: { in: cellIds } },
          data: { status: "SETTLED", quoteId: id, expenseOrderId: order.id },
        }),
      ]);
      await audit(user, scope, requestId, "UPDATE",
        `Devis ${quote.supplier} ACCEPTÉ (${amount.toLocaleString("fr-FR")} DZD) — ordre de dépense ${order.reference}.`);
    } else {
      await prisma.$transaction([
        prisma.careQuote.update({ where: { id }, data: { status: "REJECTED", decidedById: user.id, decidedAt: new Date(), note: fdStr(formData, "note") } }),
        // Les cases redeviennent « demandées » : il faut un autre devis.
        prisma.careCell.updateMany({ where: { id: { in: cellIds }, status: "PROVIDED" }, data: { status: "REQUESTED" } }),
      ]);
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

  const beneficiaries = await prisma.careBeneficiary.findMany({
    where: parentWhere(scopeRaw, requestId),
    select: {
      status: true, doctorId: true, firstName: true, lastName: true,
      cells: { select: { kind: true, status: true, label: true, amountDzd: true } },
    },
  });
  const quotes = await prisma.careQuote.findMany({
    where: parentWhere(scopeRaw, requestId),
    select: { id: true, status: true, amountDzd: true, cells: { select: { cellId: true } } },
  });

  const rows = await Promise.all(
    beneficiaries.map(async (b) => ({
      status: b.status,
      name: await nameOf(b),
      progress: careProgress(b.cells.map((c) => ({ ...c, amountDzd: c.amountDzd != null ? toNumber(c.amountDzd) : null }))),
    })),
  );
  const readiness = financeReadiness(
    rows,
    quotes.map((q) => ({ id: q.id, status: q.status, amountDzd: toNumber(q.amountDzd), cellIds: q.cells.map((c) => c.cellId) })),
  );
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

  const data = { requestStatus: "COMPLETED" as const, status: "COMPLETED" as const, updatedById: user.id };
  // Écriture CONDITIONNELLE : deux clics simultanés ne posent pas deux fois la même fin.
  const n = scopeRaw === "NATIONAL"
    ? await prisma.congressNational.updateMany({ where: { id: requestId, requestStatus: "APPROVED" }, data })
    : await prisma.congressInternational.updateMany({ where: { id: requestId, requestStatus: "APPROVED" }, data });
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
