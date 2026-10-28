"use server";

import { revalidatePath } from "next/cache";
import type { CongressRequestStatus, EntityType, NationalEventType, Prisma } from "@prisma/client";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, hasGlobalView, hasRole, anyRoleFilter, type Module } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { moneyEntityOf } from "@/lib/company";
import { normalizeCity } from "@/lib/geo/algeria";
import { recordAudit } from "@/lib/audit";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { createMedicalInfoDeclaration, repercuterMontantSurDeclaration, pharmacienAssigne } from "@/lib/medical-info";
import { createExpenseOrder, reviserOrdreNonRegle, apresRevisionOrdre } from "@/modules/finances/api";
import { involveThirdParty } from "@/lib/third-party";
import { adProInit, PRODUCT_MANAGER_ROLES } from "@/lib/workflow/origin";
import { ouvrirLeCircuit } from "@/lib/workflow/engine";
import { retirerDemandeAdPro } from "@/lib/actions/workflow-actions";
import { referentAInscrire } from "@/lib/ad-pro/referent-de-la-gamme";
import { gammeImposee } from "@/lib/ad-pro/business-unit-auto";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";
import { attachFiles, validateAttachments } from "@/lib/attach-files";
import { deviseDuPoste, lireMode, TAUX_USD_DZD_DEFAUT } from "@/lib/care-fiches";
import { refusCategoriePourLaDemande, type NatureDemandeAdPro } from "@/lib/ad-pro/categorie-budgetaire-serveur";
import { relierALaPersonne } from "@/modules/referentiels/api";

// Le **même** circuit de prise en charge sert les prises en charge internationales/nationaux
// ET les événements (module Events) : on paramètre tout par `type`.
type CongressType = "INTL" | "NATIONAL" | "EVENT";
const EVENT_TYPES: NationalEventType[] = ["CONGRESS", "SEMINAR", "ROUND_TABLE", "WEBINAR", "WORKSHOP", "SYMPOSIUM", "STAFF", "OTHER"];

const moduleFor = (t: CongressType): Module => (t === "INTL" ? "CONGRESS_INTERNATIONAL" : t === "NATIONAL" ? "CONGRESS_NATIONAL" : "EVENTS");
const pathFor = (t: CongressType) => (t === "INTL" ? "/congress-international" : t === "NATIONAL" ? "/congress-national" : "/events");
const entityFor = (t: CongressType): EntityType => (t === "INTL" ? "CONGRESS_INTERNATIONAL" : t === "NATIONAL" ? "CONGRESS_NATIONAL" : "EVENT");
const ML = (t: CongressType) => (t === "EVENT" ? "Events" : "Congrès"); // libellé module pour l'audit
const NOUN = (t: CongressType) => (t === "EVENT" ? "Événement" : "Congrès"); // nom métier pour les notifications
const typeOf = (formData: FormData): CongressType => {
  const v = fdStr(formData, "type");
  return v === "NATIONAL" ? "NATIONAL" : v === "EVENT" ? "EVENT" : "INTL";
};
const fdList = (formData: FormData, key: string): string[] => formData.getAll(key).map((v) => String(v)).filter(Boolean);

function loadCongress(t: CongressType, id: string) {
  if (t === "INTL") return prisma.congressInternational.findUnique({ where: { id } });
  if (t === "NATIONAL") return prisma.congressNational.findUnique({ where: { id } });
  return prisma.event.findUnique({ where: { id } });
}
function updateCongress(t: CongressType, id: string, data: Record<string, unknown>) {
  if (t === "INTL") return prisma.congressInternational.update({ where: { id }, data: data as Prisma.CongressInternationalUpdateInput });
  if (t === "NATIONAL") return prisma.congressNational.update({ where: { id }, data: data as Prisma.CongressNationalUpdateInput });
  // Le modèle Event n'a pas de champ updatedById (contrairement aux congrès).
  const { updatedById: _omit, ...rest } = data;
  return prisma.event.update({ where: { id }, data: rest as Prisma.EventUpdateInput });
}

// ───────────────────────────── Création de la demande ─────────────────────────────

export async function createCongressRequest(
  _prev: ActionResult | undefined,
  formData: FormData,
): Promise<ActionResult> {
  const user = await requireUserAuNomDeLaVue();
  const t = typeOf(formData);
  if (!userCan(user, moduleFor(t), "CREATE")) return { ok: false, error: "Non autorisé." };
  // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.
  /*
   * CE QUE LA DEMANDE EXIGE, NOMMÉ EN UNE FOIS (décision du 04/10/2026) : le nom, et l'événement par
   * son DÉBUT et sa FIN — deux dates, des deux côtés. Un refus par champ ferait ressaisir le
   * formulaire trois fois (§118.18). Le nom garde sa garde à part, plus bas : c'est elle que la
   * dérivation des contrats lit (§118.142).
   */
  const name = fdStr(formData, "name");
  const debut = t === "INTL" ? fdDate(formData, "startDate") : fdDate(formData, "date");
  const fin = fdDate(formData, "endDate");
  const manque = [name ? null : "le nom de l'événement", debut ? null : "la date de début", fin ? null : "la date de fin"]
    .filter((x): x is string => x !== null);
  if (manque.length > 1) return { ok: false, error: `À renseigner : ${manque.join(", ")}.` };
  if (!name) return { ok: false, error: "Le nom de l'événement est obligatoire." };
  if (manque.length > 0) return { ok: false, error: `À renseigner : ${manque.join(", ")}.` };
  if (debut && fin && fin < debut) return { ok: false, error: "La date de fin ne peut pas précéder la date de début." };

  // Les pièces se jugent AVANT la demande : refusées après, elles la laissaient créée, et le
  // second essai en faisait une seconde (audit du 04/10, constat 7 — même défaut qu'au sponsoring).
  const pieces = formData.getAll("files").filter((f): f is File => f instanceof File);
  const piecesRefusees = await validateAttachments(pieces);
  if (piecesRefusees) return { ok: false, error: `${piecesRefusees} Aucune demande n'a été créée.` };

  // LES PROFESSIONNELS PROPOSÉS, vérifiés AVANT la création : un identifiant qui ne désigne aucun
  // praticien de l'annuaire est refusé, au lieu de créer une demande amputée en silence.
  // (Appelants d'avant : `invitedDoctorIds` reste lu comme « professionnels proposés ». Le formulaire de création
  // ne les envoie plus — les professionnels s'ajoutent dans la demande, fiche par fiche, Direction 10/2026.)
  const proposes = [...new Set(fdList(formData, "invitedDoctorIds"))];
  // LE OU LES MÉDECINS À L'ORIGINE d'une « initiative du médecin » : l'origine de la demande, PAS une prise en charge.
  const origine = [...new Set(fdList(formData, "initiativeDoctorIds"))];
  // QUI EST À L'ORIGINE DE LA DEMANDE (Direction, 07/10) : « Mon initiative » ou « Initiative du médecin » — et dans ce
  // second cas, le ou les médecins de l'annuaire qui l'ont demandée. Facultatif pour les appelants d'avant (aucun choix posté).
  const initiativeBrute = fdStr(formData, "initiative");
  const initiative = initiativeBrute === "MEDECIN" || initiativeBrute === "DEMANDEUR" ? initiativeBrute : null;
  if (initiativeBrute && !initiative) return { ok: false, error: "Initiative inconnue : choisissez « Mon initiative » ou « Initiative du médecin »." };
  if (initiative === "MEDECIN" && proposes.length === 0 && origine.length === 0) return { ok: false, error: "Initiative du médecin : choisissez dans l'annuaire le ou les médecins à l'origine de la demande." };
  const annuaire = [...new Set([...proposes, ...origine])];
  if (annuaire.length > 0) {
    const connus = await prisma.medicalDoctor.count({ where: { id: { in: annuaire } } });
    if (connus !== annuaire.length) return { ok: false, error: "Un médecin choisi est introuvable dans l'annuaire — rechargez le formulaire." };
  }
  // LE MODE DE PRISE EN CHARGE (Direction, 10/2026) : individuelle (par défaut) ou de groupe.
  const modeBrut = fdStr(formData, "careMode");
  const careMode = modeBrut ? lireMode(modeBrut) : "INDIVIDUAL";
  if (!careMode) return { ok: false, error: "Mode de prise en charge inconnu : individuelle ou de groupe." };

  const eventType: NationalEventType = EVENT_TYPES.includes(fdStr(formData, "eventType") as NationalEventType)
    ? (fdStr(formData, "eventType") as NationalEventType)
    : "CONGRESS";

  // Routage intelligent : on saute les étapes d'approbation au niveau/en dessous du créateur.
  const pmId = fdStr(formData, "productManagerId");
  if (pmId) {
    const okPm = await prisma.user.count({ where: { id: pmId, isActive: true, ...anyRoleFilter(PRODUCT_MANAGER_ROLES) } });
    if (!okPm) return { ok: false, error: "Le référent Direction Marketing sélectionné est introuvable." };
  }
  // La Direction peut demander l'avis de la Direction Marketing avant de trancher — ou trancher tout
  // de suite. `adProInit` ignore ce drapeau pour les autres rangs.
  // La NATURE de la demande — celle de l'entité créée plus bas (`t === "INTL"` crée un congrès
  // international, sinon un congrès national). Elle ne change pas l'ENTRÉE, seulement la suite
  // (§118.156), mais le parcours se lit toujours avec elle.
  const init = adProInit(user, t === "INTL" ? "CONGRESS_INTERNATIONAL" : "CONGRESS_NATIONAL", pmId);
  // LA GAMME SE LIT UNE FOIS : le référent vient de la gamme qu'on ÉCRIT, jamais d'une lecture
  // parallèle du formulaire. Les deux coïncident ici, et c'est précisément le genre d'accord qui
  // se défait le jour où la gamme se déduit du demandeur, en silence (§118.5).
  // Et elle se lit d'abord SUR LE DEMANDEUR (`gammeImposee`) : un KAM rattaché à sa BU n'a plus le
  // champ à l'écran, et une valeur postée n'entre pas en ligne de compte pour lui.
  const gammeDeLaDemande = await gammeImposee(user, fdStr(formData, "businessUnitId") || null);
  const referentGamme = await referentAInscrire(gammeDeLaDemande);
  const now = new Date();

  /*
   * NI SPÉCIALITÉ NI PRODUITS NI PAYS (national) sur une prise en charge — décision de la Direction
   * du 04/10/2026. Ce que le formulaire ne porte plus ne s'écrit plus (§118.152c) ; les colonnes
   * restent en base pour les demandes d'avant.
   *
   * LES MÉDECINS deviennent les « professionnels proposés pour la prise en charge » : une ligne
   * `CareBeneficiary` par praticien choisi, la MÊME liste que celle de la fiche (une seule source de
   * vérité). `invitedDoctorIds` n'est plus écrit ; la migration du 04/10 y a repris ce qu'il portait.
   */

  const common = {
    name,
    eventType,
    initiative,
    initiativeDoctorIds: initiative === "MEDECIN" ? origine : [],
    careMode,
    estimatedBudget: fdNum(formData, "estimatedBudget"),
    participantIds: fdList(formData, "participantIds"),
    requesterId: user.id,
    requestStatus: init.status as CongressRequestStatus,
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
  };

  const created =
    t === "INTL"
      ? await prisma.congressInternational.create({
          data: {
      // LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé.
      businessUnitId: gammeDeLaDemande,
            ...common,
            country: fdStr(formData, "country"),
            // La ville vient du référentiel des wilayas ; une saisie ancienne reprend sa forme
            // officielle, et ce qu'on ne sait pas rattacher est conservé tel quel.
            city: normalizeCity(fdStr(formData, "city")),
            startDate: debut,
            endDate: fin,
            // LE TAUX USD → DZD, FIGÉ À LA CRÉATION : tout sauf la billetterie s'y convertit (Direction, 10/2026).
            usdDzdRate: TAUX_USD_DZD_DEFAUT,
          },
        })
      : await prisma.congressNational.create({
          data: {
      // LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé.
      businessUnitId: gammeDeLaDemande,
            ...common,
            // La ville vient du référentiel des wilayas ; une saisie ancienne reprend sa forme
            // officielle, et ce qu'on ne sait pas rattacher est conservé tel quel.
            city: normalizeCity(fdStr(formData, "city")),
            hostInstitution: fdStr(formData, "hostInstitution"),
            date: debut,
            endDate: fin,
          },
        });

  if (proposes.length > 0) {
    // Chaque professionnel proposé reçoit SA fiche, billetterie et hôtellerie ouvertes (Direction, 10/2026).
    const ville = created.city ?? null;
    await prisma.$transaction(async (tx) => {
      for (const [i, doctorId] of proposes.entries()) {
        const b = await tx.careBeneficiary.create({
          data: {
            ...(t === "INTL" ? { congressInternationalId: created.id } : { congressNationalId: created.id }),
            doctorId, position: i + 1, createdById: user.id, updatedById: user.id,
          },
          select: { id: true },
        });
        await tx.careCell.createMany({
          data: [
            { beneficiaryId: b.id, kind: "SERVICE", serviceKind: "TICKET", label: "Billetterie", currency: "DZD", requestedById: user.id, position: 1 },
            { beneficiaryId: b.id, kind: "SERVICE", serviceKind: "HOTEL", label: "Hôtellerie", city: ville, currency: deviseDuPoste(t === "INTL" ? "INTERNATIONAL" : "NATIONAL", "HOTEL"), requestedById: user.id, position: 2 },
          ],
        });
        // DOUBLE ÉCRITURE (refonte, lot V2-B) : le bénéficiaire rejoint la Personne de son praticien.
        await relierALaPersonne(tx, "CareBeneficiary", b.id, user.id);
      }
    });
  }

  // Les demandes du médecin, jointes DÈS la création — la pièce que tout le circuit va lire.
  // Ce qui peut encore échouer ici est l'écriture : la demande existe, elle n'est pas refaite —
  // le manque est dit dans la réponse et dans la cloche.
  const attached = await attachFiles({
    files: pieces, entityType: entityFor(t), entityId: created.id, uploadedById: user.id, category: "REQUEST_LETTER",
  });

  await recordAudit({ actorId: user.id, action: "CREATE", module: ML(t), entityType: entityFor(t), entityId: created.id, summary: `Prise en charge « ${name} »${attached.saved > 0 ? ` (${attached.saved} pièce(s) jointe(s))` : ""}` });
  // LE CIRCUIT NAÎT AVEC LA DEMANDE et prévient chaque acteur de SON parcours (décision #1, 27/10/2026).
  await ouvrirLeCircuit(entityFor(t), created.id);
  revalidatePath(pathFor(t));
  // Le tableau « Toutes les demandes » et « Mon espace » lisent aussi la demande qui vient de naître.
  revalidatePath("/ad-pro");
  revalidatePath("/mon-espace");
  return { ok: true, id: created.id, ...(attached.error ? { message: `Demande créée. ${attached.error}` } : {}) };
}

// ─────────────────── Attribution de la Direction Marketing (Direction Marketing) ───────────────────

export async function preliminaryDecision(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision"); // APPROVE | REJECT
  if (!id || !decision) return { ok: false, error: "Paramètres manquants." };
  // Approbation préliminaire (approuver/refuser + désigner le référent Direction Marketing) :
  // **réservée au National Sales** (la demande émane d'un délégué). Ni la Direction
  // ni la Direction Marketing n'interviennent à cette étape.
  if (!(hasRole(user, "NATIONAL_SALES") || user.role === "SUPER_ADMIN")) return { ok: false, error: "Attribution réservée au National Sales." };

  const c = await loadCongress(t, id);
  if (!c) return { ok: false, error: "Demande introuvable." };
  if (c.requestStatus !== "AWAITING_PRELIMINARY") return { ok: false, error: "Cette demande n'est pas en attente de validation préliminaire." };

  if (decision === "REJECT") {
    const reason = fdStr(formData, "note");
    if (!reason) return { ok: false, error: "Le motif de refus est obligatoire." };
    await updateCongress(t, id, { requestStatus: "REJECTED", rejectionReason: reason, preliminaryById: user.id, preliminaryAt: new Date(), updatedById: user.id });
    if (c.requesterId) await notifyUser({ userId: c.requesterId, type: "GENERIC", title: `${NOUN(t)} — demande refusée`, body: c.name, link: `${pathFor(t)}/${id}` });
    await recordAudit({ actorId: user.id, action: "REFUSE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Refus préliminaire — ${c.name}` });
  } else {
    const productManagerId = fdStr(formData, "productManagerId");
    if (!productManagerId) return { ok: false, error: "Sélectionnez le référent Direction Marketing qui fera l'analyse." };
    await updateCongress(t, id, {
      requestStatus: "PRELIMINARY_APPROVED", productManagerId,
      preliminaryById: user.id, preliminaryAt: new Date(), preliminaryNote: fdStr(formData, "note"), updatedById: user.id,
    });
    await notifyUser({ userId: productManagerId, type: "ASSIGNMENT", title: `${NOUN(t)} à analyser`, body: c.name, link: `${pathFor(t)}/${id}` });
    if (c.requesterId) await notifyUser({ userId: c.requesterId, type: "GENERIC", title: "Demande validée (préliminaire)", body: c.name, link: `${pathFor(t)}/${id}` });
    await recordAudit({ actorId: user.id, action: "VALIDATE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Validation préliminaire — ${c.name}` });
  }
  revalidatePath(`${pathFor(t)}/${id}`);
  revalidatePath(pathFor(t));
  return { ok: true };
}

// ───────────────────────────── Analyse Direction Marketing ─────────────────────────────

export async function submitProductAnalysis(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const c = await loadCongress(t, id);
  if (!c) return { ok: false, error: "Demande introuvable." };
  if (c.productManagerId !== user.id && !hasGlobalView(user)) return { ok: false, error: "Réservé au référent Direction Marketing assigné." };
  if (c.requestStatus !== "PRELIMINARY_APPROVED") return { ok: false, error: "Cette demande n'est pas en phase d'analyse." };

  // La Direction Marketing peut APPROUVER (et proposer un budget, désormais facultatif)
  // ou REFUSER la demande.
  const decision = fdStr(formData, "decision") ?? "APPROVE";
  if (decision === "REJECT") {
    const reason = fdStr(formData, "productManagerNotes") || fdStr(formData, "note");
    if (!reason) return { ok: false, error: "Indiquez le motif du refus." };
    await updateCongress(t, id, {
      requestStatus: "REJECTED", rejectionReason: reason, productManagerNotes: reason, updatedById: user.id,
    });
    if (c.requesterId) await notifyUser({ userId: c.requesterId, type: "GENERIC", title: `${NOUN(t)} — refusé par la Direction Marketing`, body: c.name, link: `${pathFor(t)}/${id}` });
    await notifyRoles(["NATIONAL_SALES", "SUPER_ADMIN"], { type: "GENERIC", title: `${NOUN(t)} refusé par la Direction Marketing`, body: c.name, link: `${pathFor(t)}/${id}` });
    await recordAudit({ actorId: user.id, action: "REFUSE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Refus Direction Marketing — ${c.name}` });
    revalidatePath(`${pathFor(t)}/${id}`);
    revalidatePath(pathFor(t));
    return { ok: true };
  }

  // Approbation : le budget proposé est facultatif (la Direction tranchera).
  await updateCongress(t, id, {
    requestStatus: "AWAITING_FINAL",
    productManagerBudget: fdNum(formData, "productManagerBudget"),
    productManagerNotes: fdStr(formData, "productManagerNotes"),
    updatedById: user.id,
  });
  await notifyRoles(["DIRECTION", "SUPER_ADMIN"], {
    type: "VALIDATION_REQUIRED",
    title: `${NOUN(t)} — validation définitive`,
    body: `${c.name} — analyse Direction Marketing terminée`,
    link: `${pathFor(t)}/${id}`,
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Analyse Direction Marketing — ${c.name}` });
  revalidatePath(`${pathFor(t)}/${id}`);
  return { ok: true };
}

// ───────────────────────────── Validation définitive (Direction) → ordre de dépense ─────────────────────────────

export async function finalDecision(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  const decision = fdStr(formData, "decision");
  if (!id || !decision) return { ok: false, error: "Paramètres manquants." };
  // Validation définitive **réservée à la Direction** (et au Super Admin) — le chef
  // de produit, même s'il « gère » le module, ne doit PAS pouvoir trancher.
  if (!hasGlobalView(user)) return { ok: false, error: "Validation définitive réservée à la Direction." };

  const c = await loadCongress(t, id);
  if (!c) return { ok: false, error: "Demande introuvable." };
  if (c.requestStatus !== "AWAITING_FINAL") return { ok: false, error: "Cette demande n'est pas en attente de validation définitive." };

  if (decision === "REJECT") {
    const reason = fdStr(formData, "note");
    if (!reason) return { ok: false, error: "Le motif de refus est obligatoire." };
    await updateCongress(t, id, { requestStatus: "REJECTED", rejectionReason: reason, finalById: user.id, finalAt: new Date(), updatedById: user.id });
    if (c.requesterId) await notifyUser({ userId: c.requesterId, type: "GENERIC", title: `${NOUN(t)} — refusé (définitif)`, body: c.name, link: `${pathFor(t)}/${id}` });
    await recordAudit({ actorId: user.id, action: "REFUSE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Refus définitif — ${c.name}` });
    revalidatePath(`${pathFor(t)}/${id}`);
    return { ok: true };
  }

  // Le montant accordé par la Direction est **obligatoire** à la validation définitive :
  // il fait foi pour la déclaration d'information médicale puis l'ordre de dépense.
  const amount = fdNum(formData, "finalAmount");
  if (amount === null || amount <= 0) return { ok: false, error: "Le montant accordé est obligatoire pour valider définitivement." };

  // (Sous-)catégorie budgétaire : la Direction impute explicitement la dépense à une
  // (sous-)catégorie AVANT qu'elle ne parte au comptable. Facultatif côté serveur
  // (aucune enveloppe configurée = pas de choix), mais requis dans l'UI dès qu'il
  // existe des (sous-)catégories. Vérifie qu'elle existe encore.
  const budgetCategoryId = fdStr(formData, "budgetCategoryId");
  if (budgetCategoryId) {
    const okCat = await prisma.budgetCategoryLine.count({ where: { id: budgetCategoryId } });
    if (okCat === 0) return { ok: false, error: "La (sous-)catégorie budgétaire choisie est introuvable." };
    // Elle convient à la demande : sa nature, son exercice, sa Business Unit (point 9, 27/10).
    const refusCat = await refusCategoriePourLaDemande(budgetCategoryId, entityFor(t) as NatureDemandeAdPro, id);
    if (refusCat) return { ok: false, error: refusCat };
  }

  // Étape « information médicale » : intercalée UNIQUEMENT si un pharmacien responsable
  // est configuré. Sinon, on route directement l'ordre de dépense vers les Finances
  // (le responsable des finances est notifié par createExpenseOrder).
  // Le pharmacien désigné — le plus ancien actif, déterministe (`pharmacienAssigne`).
  const pharmacist = await pharmacienAssigne();

  if (pharmacist) {
    const decl = await createMedicalInfoDeclaration({
      sourceType: entityFor(t),
      sourceId: id,
      label: `${NOUN(t)} — ${c.name}`,
      beneficiary: c.name,
      amount,
      requesterId: c.requesterId ?? user.id,
      budgetCategoryId,
    });
    await updateCongress(t, id, {
      requestStatus: "APPROVED",
      finalById: user.id, finalAt: new Date(), finalNote: fdStr(formData, "note"), finalAmount: amount,
      status: "VALIDATED",
      updatedById: user.id,
    });
    await recordAudit({ actorId: user.id, action: "VALIDATE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Validation définitive — ${c.name} (déclaration ${decl.reference})` });
    revalidatePath("/information-medicale");
  } else {
    // Pas de pharmacien PRIM : ordre de dépense émis directement → Finances.
    const order = await createExpenseOrder({
      label: `${NOUN(t)} — ${c.name}`,
      amount,
      category: "EVENEMENT",
      beneficiary: c.name,
      sourceType: entityFor(t),
      sourceId: id,
      requestedById: c.requesterId ?? user.id,
      budgetCategoryId,
    });
    await updateCongress(t, id, {
      requestStatus: "APPROVED",
      finalById: user.id, finalAt: new Date(), finalNote: fdStr(formData, "note"), finalAmount: amount,
      status: "VALIDATED", expenseOrderId: order.id,
      updatedById: user.id,
    });
    await recordAudit({ actorId: user.id, action: "VALIDATE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Validation définitive — ${c.name} (ordre ${order.reference})` });
    // LA DÉCLARATION NAÎT QUAND MÊME, non assignée, et porte l'ordre déjà parti : l'événement reste à
    // déclarer au ministère même sans pharmacien, et la validation finale ne doublera pas l'ordre.
    // Le paiement, lui, ne change pas. Best-effort : l'ordre est parti, une déclaration ratée se rattrape.
    await createMedicalInfoDeclaration({
      sourceType: entityFor(t), sourceId: id, label: `${NOUN(t)} — ${c.name}`, beneficiary: c.name,
      amount, requesterId: c.requesterId ?? user.id, budgetCategoryId, expenseOrderId: order.id,
    }).catch((e) => console.error("[information médicale] déclaration non assignée non créée", e));
    revalidatePath("/information-medicale");
    revalidatePath("/finances/paiements-a-faire");
    revalidatePath("/finances");
  }

  if (c.requesterId) await notifyUser({ userId: c.requesterId, type: "GENERIC", title: `${NOUN(t)} validé — pris en charge`, body: c.name, link: `${pathFor(t)}/${id}` });
  revalidatePath(`${pathFor(t)}/${id}`);
  return { ok: true };
}

// ───────────────────────────── Modification du budget accordé (Direction) ─────────────────────────────

/**
 * La Direction peut **modifier le montant accordé** même après la validation
 * définitive. Répercuté sur la déclaration d'information médicale (si pas encore
 * validée) et sur l'ordre de dépense (s'il existe et n'est pas encore réglé).
 */
export async function updateGrantedBudget(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  if (!hasGlobalView(user)) return { ok: false, error: "Réservé à la Direction." };
  const c = await loadCongress(t, id);
  if (!c) return { ok: false, error: "Demande introuvable." };
  if (!["APPROVED", "COMPLETED"].includes(c.requestStatus ?? "")) return { ok: false, error: "Le budget ne peut être modifié qu'après validation définitive." };
  const amount = fdNum(formData, "finalAmount");
  if (amount === null || amount <= 0) return { ok: false, error: "Montant invalide." };

  await updateCongress(t, id, { finalAmount: amount, updatedById: user.id });

  // Répercussion sur la déclaration PRIM (tant qu'elle n'est pas validée).
  const decl = await repercuterMontantSurDeclaration(entityFor(t), id, amount);
  // Répercussion sur l'ordre de dépense (s'il existe et n'est pas réglé) — par l'UNIQUE réviseur
  // d'ordre (§118.191). Il écrivait ici en ligne, et sans condition : un règlement passé entre la
  // lecture et l'écriture voyait son ordre PAYÉ changer de montant et son autorisation rouverte. Le
  // réviseur relève le montant sous condition, rouvre le centre quand il monte (§118.148), et ne
  // touche ni un ordre réglé ni un ordre refusé.
  const orderId = decl?.expenseOrderId ?? c.expenseOrderId;
  let suiteOrdre: string | null = null;
  if (orderId) {
    const raison = "budget accordé modifié";
    const revision = await reviserOrdreNonRegle(prisma, orderId, { montant: amount }, { acteurId: user.id, raison });
    if (revision.ok && revision.revise) {
      await apresRevisionOrdre(revision, { acteurId: user.id, objet: c.name, raison });
      if (!revision.rouvert) {
        await notifyRoles(["FINANCE_BUDGET_MANAGER", "SUPER_ADMIN"], { type: "GENERIC", title: "Budget d'un événement modifié", body: `${c.name} — nouveau montant ${amount.toLocaleString("fr-FR")} DZD`, link: "/finances/paiements-a-faire" });
      }
    } else if (!revision.ok) {
      // Le budget est modifié ; l'ordre, non — et on le DIT (§118.52) : un silence se lirait « le
      // paiement suit ». Un ordre réglé a payé l'ancien montant ; un ordre refusé reste ce que le
      // centre a refusé — réécrire son chiffre falsifierait ce qu'il a vu.
      const ref = revision.reference ?? "";
      suiteOrdre = revision.motif === "REGLE"
        ? `Budget modifié — le paiement ${ref} est déjà réglé : il ne suit pas ce montant (l'argent est parti au montant d'avant).`
        : revision.motif === "REFUSE"
          ? `Budget modifié — le paiement ${ref} a été refusé par le centre de paiement : il ne suit pas ce montant.`
          : `Budget modifié — l'ordre de dépense ${ref} n'a pas pu suivre (il changeait au même moment) : relancez la modification.`;
    }
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: ML(t), entityType: entityFor(t), entityId: id, field: "finalAmount", newValue: String(amount), summary: `Budget accordé modifié — ${c.name}` });
  revalidatePath(`${pathFor(t)}/${id}`);
  revalidatePath("/information-medicale");
  revalidatePath("/finances/paiements-a-faire");
  revalidatePath("/centre-de-paiement");
  return suiteOrdre ? { ok: true, message: suiteOrdre } : { ok: true };
}

// ───────────────────────────── Impliquer une tierce personne ─────────────────────────────

/**
 * Implique une tierce personne (ex. assistante de direction) dans le circuit d'un
 * congrès / événement, SANS lui donner accès au module : elle reçoit une demande
 * dans son espace + un dossier de suivi indiquant l'événement (SANS budget).
 */
export async function requestThirdPartyInput(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  const personId = fdStr(formData, "personId");
  if (!id || !personId) return { ok: false, error: "Indiquez la personne à impliquer." };
  const c = await loadCongress(t, id);
  if (!c) return { ok: false, error: "Demande introuvable." };
  const isActor = hasGlobalView(user) || hasRole(user, "NATIONAL_SALES") || c.productManagerId === user.id || c.requesterId === user.id;
  if (!isActor) return { ok: false, error: "Non autorisé." };

  const res = await involveThirdParty({
    actorId: user.id,
    personId,
    eventLabel: `${NOUN(t)} — ${c.name}`,
    moduleLabel: t === "EVENT" ? "Événements" : "Ad & Pro",
    note: fdStr(formData, "note"),
    sourceType: entityFor(t),
    sourceId: id,
  });
  if (!res.ok) return { ok: false, error: res.error };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: ML(t), entityType: entityFor(t), entityId: id, summary: `Tierce personne impliquée — ${c.name}` });
  revalidatePath(`${pathFor(t)}/${id}`);
  return { ok: true };
}

/**
 * ANNULER UNE DEMANDE DE CONGRÈS — UN SEUL CHEMIN (audit du 04/10, constat 23). Cette action et
 * `retirerDemandeAdPro` faisaient la même chose par deux portes : chacune vérifiait le droit à sa façon
 * (celle-ci sans la porte de la FICHE — une demande hors portée s'annulait par son identifiant), et les
 * deux finissaient dans `retirerDemande`. Elle ne garde que ce qui lui est propre — lire le type de
 * congrès — et DÉLÈGUE : droit, motif, circuit et refus sont ceux du retrait commun. Son seul appelant
 * est l'op d'Adam `cancel_congress_request` (aucun écran ne l'appelle) : elle reste pour lui.
 */
export async function cancelCongressRequest(formData: FormData): Promise<ActionResult> {
  await requireUser();
  const t = typeOf(formData);
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const relais = new FormData();
  relais.set("entityType", entityFor(t));
  relais.set("entityId", id);
  const motif = fdStr(formData, "motif");
  if (motif !== null) relais.set("motif", motif);
  return retirerDemandeAdPro(relais);
}
