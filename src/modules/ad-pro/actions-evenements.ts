"use server";

import { revalidatePath } from "next/cache";
import {
  EventType, EventScope, EventFormat, EventStatus, ParticipantRole, RegistrationStatus,
} from "@prisma/client";
import type { CongressRequestStatus } from "@prisma/client";
import { requireUser, requireUserAuNomDeLaVue } from "@/lib/session";
import { userCan, anyRoleFilter, hasGlobalView } from "@/lib/rbac";
import { canAccessEntity } from "@/lib/entity-access";
import { isAdProDecided, porteeModificationEvenement, champsModifies, CHAMPS_ORGANISATION, statutManuelOuRien, estStatutDuCircuit, estStatutInscriptionRetire, estStatutOrganisation, estTypeExterne, REFUS_INSCRIPTION_PUBLIQUE, REFUS_LISTE_ATTENTE, REFUS_ORGANISATION, TYPES_EVENEMENT_EXTERNE, readMultiField, lireMedecinsDemande } from "@/modules/ad-pro/partage";
import { ouvrirPourEcrire } from "@/lib/queries/porte-ecriture";
import { prisma } from "@/lib/prisma";
import { supprimerReversible } from "@/lib/suppression/coeur";
import { moneyEntityOf } from "@/lib/company";
import { recordAudit } from "@/lib/audit";
import { adProInit, PRODUCT_MANAGER_ROLES } from "@/lib/workflow/origin";
import { ouvrirLeCircuit, relancerCycle } from "@/lib/workflow/engine";
import { referentAInscrire, gammeImposee, businessUnitDuDemandeur } from "@/modules/ad-pro/api";
import { fdStr, fdNum, fdDate, type ActionResult } from "@/lib/actions/types";

const inEnum = <T extends Record<string, string>>(e: T, v: string | null, fallback: T[keyof T]): T[keyof T] =>
  v && (Object.values(e) as string[]).includes(v) ? (v as T[keyof T]) : fallback;


/**
 * LE STATUT SAISI, ou un REFUS QUI NOMME LE REMÈDE (§118.30, §118.138).
 *
 * « Validé » et « En attente de validation » sont des VERDICTS du circuit de prise en charge :
 * les laisser écrire par le formulaire, c'est ce qui produisait des événements affichés
 * « Validé » qu'aucune étape n'avait validés. Refuser en silence aurait été pire — la personne
 * aurait vu son enregistrement passer sans que le champ change, et aurait recommencé.
 *
 * `null` (aucun statut envoyé) n'est PAS une erreur : c'est « ne touche pas au champ ». Un
 * formulaire qui ne porte pas la case ne doit pas remettre un événement en brouillon.
 */
function statutSaisi(formData: FormData, actuel: string | null = null): { ok: true; statut: string | null } | { ok: false; error: string } {
  const brut = fdStr(formData, "status");
  // `=== null` ET PAS `!brut`, et ce n'est pas de la coquetterie : la dérivation de contrats
  // (`actions/contrat.ts`) déduit « champ OBLIGATOIRE » d'une garde `if (!v)` dans le corps, et
  // celle-ci est un SUCCÈS — « aucun statut envoyé, on ne touche pas au champ ». Mesuré sur
  // l'artefact régénéré : avec `!brut`, `status` sortait `obligatoire: true` sur `createEvent`
  // et `updateEvent`, donc `validerEntree` aurait refusé une création d'événement sans statut —
  // une action DÉCRITE et INAPPELABLE, le défaut exact de §118.87c.
  if (brut === null) return { ok: true, statut: null };
  // LES ÉTATS D'ORGANISATION (Direction, 27/10) : les événements sont EXTERNES, on ne les écrit plus.
  // Un formulaire qui RENVOIE l'état qu'un ancien événement porte déjà ne l'écrit pas : il n'y touche pas.
  if (estStatutOrganisation(brut)) return brut === actuel ? { ok: true, statut: null } : { ok: false, error: REFUS_ORGANISATION };
  if (estStatutDuCircuit(brut)) {
    return {
      ok: false,
      error:
        "« Validé » et « En attente de validation » sont décidés par le circuit de prise en charge, "
        + "pas saisis à la main : soumettez l'événement au circuit (bloc « Demande de prise en charge ») "
        + "et l'état suivra la décision.",
    };
  }
  const statut = statutManuelOuRien(brut);
  if (!statut) return { ok: false, error: `État d'événement inconnu : « ${brut} ».` };
  return { ok: true, statut };
}

// ─────────────────────────── Événements ───────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QUE LA DIRECTION A RENDU OBLIGATOIRE SUR UN ÉVÉNEMENT (22/09/2026) — §118.142.
 *
 * « Mets la création de la demande quasi tout obligatoire comme sponsoring […] vraiment avec
 * budget obligatoire. » Le formulaire les marque `required`, et ce n'est PAS la garde : un champ
 * de formulaire se forge, et l'écran n'est pas la seule porte (le chemin générique d'Adam poste
 * la même action). C'est ICI que l'obligation est tenue.
 *
 * ELLE NOMME TOUT CE QUI MANQUE EN UNE FOIS. Un refus par aller-retour ferait ressaisir quinze
 * champs une fois par champ manquant (§118.18) — et c'est le formulaire le plus long du pôle.
 *
 * LE BUDGET EST LA PIÈCE MAÎTRESSE, et ce n'est pas une question de complétude : sans lui, le
 * moteur lit un montant de ZÉRO, refuse de franchir une porte de contrôle sur un montant inconnu
 * (à juste titre, §118.132) et la porte du Directeur Général reste ouverte sur un événement de
 * 80 000 DZD. La plainte « le DG n'a pas à valider en dessous du seuil » se ferme ici.
 *
 * LA LISTE EST LA MÊME POUR LA CRÉATION ET LA MODIFICATION : un formulaire qui exige à la
 * création et laisse vider à la modification n'exige rien du tout — il suffit d'enregistrer deux
 * fois. `updateEvent` lit donc la même fonction.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
/**
 * LE NOM EST GARDÉ À PART, et ce n'est pas une incohérence — c'est le CONTRAT D'ACTION.
 *
 * `actions/contrat.ts` DÉDUIT « champ obligatoire » d'une garde `if (!v)` lue dans le corps ; il
 * ne sait pas lire une liste rendue par une fonction. En basculant tous les champs dans
 * `champsManquants`, le nom est sorti `obligatoire: false` de l'artefact régénéré — mesuré, pas
 * supposé (§118.137). La carte de confirmation d'Adam ne l'aurait plus demandé, et CHAQUE appel
 * aurait été refusé pour un champ que le contrat déclarait facultatif.
 *
 * Le nom reste donc gardé par une ligne que la dérivation LIT, et il quitte la liste : un champ
 * gardé deux fois donnerait deux messages pour la même absence. La propriété « tout ce qui
 * manque, en une fois » (§118.18) vaut pour les quatorze autres — et le nom est précisément le
 * champ qu'aucun formulaire ne laisse passer, `required` en HTML depuis toujours.
 */
function champsManquants(formData: FormData): string[] {
  // Clés LITTÉRALES : voir `ad-pro/pickers.ts` — la dérivation des contrats ne suit pas les
  // clés d'un délégué importé, et le repli du produit s'appelle désormais `product` partout.
  const medecins = lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor"));
  const produits = readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product"));
  const budget = fdNum(formData, "estimatedBudget");
  return [
    !fdStr(formData, "type") ? "le type" : null,
    !fdStr(formData, "scope") ? "la portée" : null,
    !fdStr(formData, "format") ? "le format" : null,
    !fdDate(formData, "startDate") ? "la date de début" : null,
    !fdDate(formData, "endDate") ? "la date de fin" : null,
    !fdStr(formData, "location") ? "le lieu / la salle" : null,
    !fdStr(formData, "city") ? "la ville (wilaya)" : null,
    !fdStr(formData, "country") ? "le pays" : null,
    !fdStr(formData, "specialty") ? "la spécialité" : null,
    !medecins ? "le ou les médecins concernés" : null,
    !produits ? "le ou les produits concernés" : null,
    // UN BUDGET DE ZÉRO N'EST PAS UN BUDGET RENSEIGNÉ : c'est exactement la valeur que le moteur
    // lit sur un champ vide, et celle qui laisse la porte du DG ouverte.
    budget == null || budget <= 0 ? "le budget estimé (DZD, supérieur à zéro)" : null,
    !fdStr(formData, "responsibleId") ? "le responsable interne" : null,
    !fdStr(formData, "description") ? "la description" : null,
  ].filter((x): x is string => x !== null);
}

export async function createEvent(formData: FormData): Promise<ActionResult> {
  const user = await requireUserAuNomDeLaVue();
  if (!userCan(user, "EVENTS", "CREATE")) return { ok: false, error: "Non autorisé." };
  // Sous « Vue exacte », la demande se crée AU NOM de la personne visualisée (test de son parcours) : voir `vue-exacte.ts`.
  const name = fdStr(formData, "name");
  if (!name) return { ok: false, error: "Le nom de l'événement est obligatoire." };
  const manquants = champsManquants(formData);
  const couple = {
    medecins: lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor")),
    produits: readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product")),
  };
  if (manquants.length > 0) {
    return { ok: false, error: `Demande incomplète — il manque : ${manquants.join(", ")}.` };
  }
  // LE TYPE D'UN ÉVÉNEMENT EXTERNE (Direction, 27/10) : staff, webinaire, congrès, journée, autre.
  if (!estTypeExterne(fdStr(formData, "type"))) {
    return { ok: false, error: `Type d'événement inconnu — choisissez : ${TYPES_EVENEMENT_EXTERNE.map(([, l]) => l.toLowerCase()).join(", ")}.` };
  }
  const saisi = statutSaisi(formData);
  if (!saisi.ok) return saisi;
  const created = await prisma.event.create({
    data: {
      // LA GAMME QUI PORTE LA DEMANDE — c'est SON budget Ad&Pro qui est engagé.
      // Lue d'abord SUR LE DEMANDEUR : un KAM rattaché à sa BU n'a plus le champ, et une valeur
      // postée n'entre pas en ligne de compte pour lui (`gammeImposee`).
      businessUnitId: await gammeImposee(user, fdStr(formData, "businessUnitId") || null),
      name,
      // Entité : la portée en cours, à défaut la société d'appartenance du créateur.
      // L'ENTITÉ QUI PAIERA suit la PERSONNE (sa fiche employé, à défaut son
      // département), pas la portée sélectionnée dans la barre : un délégué de Pharmagène qui
      // consulte Adventum ne doit pas imputer sa demande à Adventum. La Direction corrige en
      // validant, au seul moment où quelqu'un a le dossier entier sous les yeux.
      companyId: await moneyEntityOf(user.id),
      type: inEnum(EventType, fdStr(formData, "type"), "CONGRESS"),
      scope: inEnum(EventScope, fdStr(formData, "scope"), "NATIONAL"),
      format: inEnum(EventFormat, fdStr(formData, "format"), "PRESENTIAL"),
      status: inEnum(EventStatus, saisi.statut, "DRAFT"),
      startDate: fdDate(formData, "startDate"),
      endDate: fdDate(formData, "endDate"),
      location: fdStr(formData, "location"),
      city: fdStr(formData, "city"),
      country: fdStr(formData, "country"),
      specialty: fdStr(formData, "specialty"),
      // MÉDECINS ET PRODUITS : plusieurs de chaque, lus par le MÊME lecteur que les cinq autres
      // natures (`ad-pro/pickers.ts`). Deux découpes à la main finiraient par diverger.
      doctor: couple.medecins,
      products: couple.produits,
      description: fdStr(formData, "description"),
      // QUI ORGANISE — l'événement est externe (Direction, 27/10). Ni capacité ni liste d'attente : on ne les tient plus.
      organizer: fdStr(formData, "organizer"),
      estimatedBudget: fdNum(formData, "estimatedBudget"),
      meetingLink: fdStr(formData, "meetingLink"),
      responsibleId: fdStr(formData, "responsibleId"),
      createdById: user.id,
    },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Events", summary: `Événement « ${name} »` });
  revalidatePath("/events");
  // Le tableau « Toutes les demandes » et « Mon espace » lisent aussi la demande qui vient de naître.
  revalidatePath("/ad-pro");
  revalidatePath("/mon-espace");
  return { ok: true, id: created.id };
}

export async function updateEvent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  // LE FORMULAIRE COMPLET est à qui TRANCHE les événements, ou à la vue globale (§118.184). Le droit
  // UPDATE seul (délégués, National Sales) l'ouvrait : tout délégué réécrivait l'événement d'un
  // collègue. Le demandeur corrige SA demande par « Modifier la demande » (`updateAdProRequest`).
  const vueGlobale = hasGlobalView(user);
  const tranche = userCan(user, "EVENTS", "VALIDATE");
  if (!vueGlobale && !tranche) {
    return { ok: false, error: "Seuls la Direction et qui valide les événements modifient un événement en entier — le demandeur corrige sa demande depuis « Modifier la demande »." };
  }
  const id = fdStr(formData, "id");
  const name = fdStr(formData, "name");
  if (!id || !name) return { ok: false, error: "Paramètres manquants." };
  // La porte de la FICHE : société, parties prenantes. Hors d'elle, l'événement est introuvable.
  if (!(await canAccessEntity(user, "EVENT", id, "UPDATE"))) return { ok: false, error: "Événement introuvable." };
  const avant = await prisma.event.findUnique({ where: { id } });
  if (!avant) return { ok: false, error: "Événement introuvable." };
  const portee = porteeModificationEvenement({
    vueGlobale, tranche,
    decided: avant.requestStatus ? isAdProDecided("EVENT", avant.requestStatus) : false,
  });
  // LA MÊME LISTE QU'À LA CRÉATION : exiger à la création et laisser vider à la modification
  // n'exige rien du tout — il suffirait d'enregistrer une seconde fois.
  const manquants = champsManquants(formData);
  const couple = {
    medecins: lireMedecinsDemande(formData.getAll("doctorIds").map(String), fdStr(formData, "doctorHorsAnnuaire"), fdStr(formData, "doctor")),
    produits: readMultiField(formData.getAll("productIds").map(String), fdStr(formData, "product")),
  };
  if (manquants.length > 0) {
    return { ok: false, error: `Demande incomplète — il manque : ${manquants.join(", ")}.` };
  }
  const saisi = statutSaisi(formData, avant.status);
  if (!saisi.ok) return saisi;
  // UN TYPE HORS DE LA LISTE EXTERNE ne s'écrit plus — sauf celui que l'événement porte déjà (rejoué tel quel).
  const typeSaisi = fdStr(formData, "type");
  if (typeSaisi !== avant.type && !estTypeExterne(typeSaisi)) {
    return { ok: false, error: `Type d'événement inconnu — choisissez : ${TYPES_EVENEMENT_EXTERNE.map(([, l]) => l.toLowerCase()).join(", ")}.` };
  }
  // LA GAMME NE SE CHANGE PAS PAR QUELQU'UN DONT LA GAMME EST DÉDUITE : le champ ne lui est plus
  // proposé, et une valeur postée est une valeur forgée (ne pas y toucher = `undefined`).
  const gammeDeLEditeur = await businessUnitDuDemandeur(user);
  const data = {
    businessUnitId: gammeDeLEditeur ? undefined : fdStr(formData, "businessUnitId") || undefined,
    name,
    type: inEnum(EventType, fdStr(formData, "type"), "CONGRESS"),
    scope: inEnum(EventScope, fdStr(formData, "scope"), "NATIONAL"),
    format: inEnum(EventFormat, fdStr(formData, "format"), "PRESENTIAL"),
    // `undefined` = ON NE TOUCHE PAS. Écrire « DRAFT » par défaut ramènerait en brouillon un
    // événement validé dès qu'un formulaire ne porte pas la case (§118.16).
    status: saisi.statut ? inEnum(EventStatus, saisi.statut, "DRAFT") : undefined,
    startDate: fdDate(formData, "startDate"),
    endDate: fdDate(formData, "endDate"),
    location: fdStr(formData, "location"),
    city: fdStr(formData, "city"),
    country: fdStr(formData, "country"),
    specialty: fdStr(formData, "specialty"),
    doctor: couple.medecins,
    products: couple.produits,
    description: fdStr(formData, "description"),
    // L'ORGANISATEUR : un formulaire qui ne le porte pas (Adam rejoue la fiche) n'y touche pas. La capacité ne s'écrit plus.
    organizer: formData.has("organizer") ? fdStr(formData, "organizer") : undefined,
    estimatedBudget: fdNum(formData, "estimatedBudget"),
    meetingLink: fdStr(formData, "meetingLink"),
    responsibleId: fdStr(formData, "responsibleId"),
  };
  // APRÈS LA DÉCISION, ce qui a fondé l'accord ne se réécrit plus — sauf par la vue globale. On le DIT
  // en nommant les champs, au lieu d'ignorer en silence une modification que la personne croirait faite.
  if (portee === "ORGANISATION") {
    const figes = champsModifies(avant, data);
    if (figes.length > 0) {
      return {
        ok: false,
        error: `La prise en charge est décidée : ${figes.join(", ")} ne se modifie${figes.length > 1 ? "nt" : ""} plus qu'avec la Direction. L'organisation (organisateur, lien, responsable, description, état) reste modifiable.`,
      };
    }
  }
  const changes = [...champsModifies(avant, data), ...champsModifies(avant, data, CHAMPS_ORGANISATION)];
  await prisma.event.update({ where: { id }, data });
  // L'audit qui manquait (audit 360°, R16) : qui a changé quoi, et si c'était après la décision.
  if (changes.length > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Events", entityType: "EVENT", entityId: id,
      summary: `Événement « ${name} » modifié${portee === "TOUT" && avant.requestStatus && isAdProDecided("EVENT", avant.requestStatus) ? " APRÈS DÉCISION" : ""} — ${changes.join(", ")}`,
    });
  }
  revalidatePath(`/events/${id}`);
  return { ok: true };
}

/**
 * SUPPRIMER UN ÉVÉNEMENT — par le cœur réversible, avec ses branches (§118.162).
 *
 * Ce geste écrivait `prisma.event.delete` : ni instantané, ni audit, ni corbeille, ouvert à quatre
 * rôles — et il laissait derrière lui la déclaration d'information médicale, la demande au
 * secrétariat, le circuit de validation de l'événement. Le droit reste celui du module
 * (`EVENTS` › supprimer) ; le RESTE est celui de toutes les suppressions : réversible, tracé, et
 * refusé quand une branche porte un fait qui a quitté l'ERP.
 */
export async function deleteEvent(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const porte = await ouvrirPourEcrire(user, "EVENT", id, "DELETE");
  if (!porte.ok) return porte;
  const nom = (await prisma.event.findUnique({ where: { id }, select: { name: true } }))?.name ?? id;
  const r = await supprimerReversible("EVENT", id, user.id, `Suppression d'un événement — « ${nom} » (restaurable depuis la corbeille)`);
  if (!r.ok) return { ok: false, error: r.error ?? "Suppression impossible." };
  revalidatePath("/events");
  return { ok: true, message: "Événement supprimé — restaurable depuis la corbeille, avec tout ce qui en dépendait." };
}

// ──────────────── Demande de prise en charge (circuit de financement) ────────────────

/**
 * Soumet un événement existant au **circuit de prise en charge**, identique à celui
 * des congrès : la demande (souvent d'un délégué) part vers le **National Sales**
 * (approbation préliminaire + désignation du référent Direction Marketing) → analyse du chef de
 * produit → **Direction** (décision définitive + budget accordé) → **information
 * médicale** (PRIM). Les étapes suivantes sont gérées par `congress-request-actions`
 * avec `type=EVENT` (mêmes composants UI).
 */
export async function submitEventForApproval(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EVENTS", "CREATE")) return { ok: false, error: "Non autorisé." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const ev = await prisma.event.findUnique({ where: { id }, select: { id: true, name: true, requestStatus: true, requesterId: true, createdById: true, businessUnitId: true } });
  if (!ev) return { ok: false, error: "Événement introuvable." };
  // SOUMETTRE ENGAGE LA DÉPENSE D'UN ÉVÉNEMENT : son organisateur le fait, ou qui peut le modifier en
  // entier (la porte de la fiche, §118.184). Un identifiant ne suffisait pas — tout porteur du droit
  // de créer soumettait l'événement d'un collègue. Avant la première soumission, l'événement n'a pas
  // encore de DEMANDEUR (la soumission le pose) : c'est alors son CRÉATEUR qui l'est.
  const sonEvenement = ev.requesterId === user.id || (ev.requesterId === null && ev.createdById === user.id);
  if (!sonEvenement && !(await canAccessEntity(user, "EVENT", id, "UPDATE"))) return { ok: false, error: "Événement introuvable." };
  // UN NOUVEAU CYCLE APRÈS UN REFUS OU UNE ANNULATION (audit 360°, R01 — §118.186). Un événement
  // refusé ne pouvait JAMAIS être resoumis : tout statut de demande non vide fermait la porte. On
  // refuse la prise en charge, pas l'événement ; il peut revenir, autrement chiffré — en disant ce
  // qui a changé, que la nouvelle demande porte jusqu'à son premier validateur.
  const relance = ev.requestStatus === "REJECTED" || ev.requestStatus === "CANCELLED";
  if (ev.requestStatus && !relance) return { ok: false, error: "Une demande de prise en charge est déjà en cours pour cet événement." };
  const motifRelance = fdStr(formData, "note");
  if (relance && motifRelance === null) return { ok: false, error: "Dites ce qui a changé depuis le refus : la nouvelle demande part avec ce motif." };

  // Routage intelligent : on saute les étapes d'approbation au niveau/en dessous du créateur.
  const pmId = fdStr(formData, "productManagerId");
  if (pmId) {
    const okPm = await prisma.user.count({ where: { id: pmId, isActive: true, ...anyRoleFilter(PRODUCT_MANAGER_ROLES) } });
    if (!okPm) return { ok: false, error: "Le référent Direction Marketing sélectionné est introuvable." };
  }
  // La Direction, elle, CHOISIT : trancher tout de suite, ou demander d'abord l'avis d'un chef
  // de produit. `adProInit` ignore ce drapeau pour les autres rangs — le choix ne se vole pas.
  const init = adProInit(user, "EVENTS", pmId);
  /*
   * LA GAMME VIENT DE LA LIGNE, PAS DU FORMULAIRE — et c'est un défaut mesuré, pas une précaution.
   *
   * Cette action SOUMET un événement qui EXISTE déjà ; elle lisait pourtant
   * `fdStr(formData, "businessUnitId")`, et le seul appelant du dépôt (`funding-panel.tsx`)
   * n'envoie que `id`. La lecture rendait donc `""`, `referentAInscrire` rendait `null`, et le
   * référent n'était JAMAIS inscrit sur un événement — un mécanisme écrit, testé, et sans effet
   * par sa porte réelle (§118.14). Vu en relisant le diff de l'artefact régénéré, qui a montré
   * `submitEventForApproval` gagner un champ `businessUnitId` qu'aucun écran ne remplit (§118.137).
   *
   * La ligne fait FOI : la gamme d'un événement est un fait de l'enregistrement, et lui préférer
   * une valeur de formulaire laisserait forger la gamme dont on prend le référent.
   */
  const referentGamme = await referentAInscrire(ev.businessUnitId);
  const now = new Date();

  const ecrireLaDemande = () => prisma.event.update({
    where: { id },
    data: {
      // Un nouveau cycle efface la DÉCISION précédente de la ligne — elle reste lisible dans
      // l'historique du circuit, motif compris ; laissée ici, la fiche afficherait le refus d'hier
      // au-dessus de la demande d'aujourd'hui.
      ...(relance
        ? {
            rejectionReason: null, finalById: null, finalAt: null, finalNote: null, finalAmount: null,
            preliminaryById: null, preliminaryAt: null, preliminaryNote: null, productManagerBudget: null, productManagerNotes: null,
          }
        : {}),
      requestStatus: init.status as CongressRequestStatus,
      requesterId: ev.requesterId ?? user.id,
      status: "AWAITING_VALIDATION",
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
    },
  });
  if (relance) {
    // Le moteur rouvre l'instance close sur l'étape d'entrée et prévient cette étape — l'aiguillage
    // d'origine ci-dessous ne connaît que les premières soumissions. La demande s'écrit SOUS LA
    // PRISE du circuit (`preparer`) : écrite avant, un circuit occupé laissait l'événement « en
    // attente » sur un circuit encore refusé — et la relance suivante répondait « déjà en cours ».
    const r = await relancerCycle({
      viewer: { id: user.id, role: user.role, secondaryRole: user.secondaryRole ?? null, name: user.name },
      entityType: "EVENT", entityId: id, note: motifRelance!,
      preparer: async () => { await ecrireLaDemande(); },
    });
    if (!r.ok) return { ok: false, error: r.error };
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Events", entityType: "EVENT", entityId: id, summary: `Nouvelle demande de prise en charge après refus — ${ev.name}` });
    revalidatePath(`/events/${id}`);
    revalidatePath("/events");
    return { ok: true, message: `Nouvelle demande envoyée — elle attend « ${r.etape} ».` };
  }
  await ecrireLaDemande();
  await recordAudit({ actorId: user.id, action: "CREATE", module: "Events", entityType: "EVENT", entityId: id, summary: `Demande de prise en charge — ${ev.name}` });
  // LE CIRCUIT NAÎT AVEC LA DEMANDE et prévient chaque acteur de SON parcours (décision #1, 27/10/2026).
  await ouvrirLeCircuit("EVENT", id);
  revalidatePath(`/events/${id}`);
  revalidatePath("/events");
  return { ok: true };
}

// ─────────────────────────── Inscriptions ───────────────────────────

/**
 * INSCRIPTION PUBLIQUE — FERMÉE (Direction, 27/10). Les événements Ad & Pro sont EXTERNES : on s'y inscrit chez
 * l'organisateur. Le formulaire partageable et sa liste d'attente n'ont plus d'objet ; l'action refuse et le dit.
 */
export async function publicRegister(formData: FormData): Promise<ActionResult> {
  if (!fdStr(formData, "eventId")) return { ok: false, error: "Événement introuvable." };
  return { ok: false, error: REFUS_INSCRIPTION_PUBLIQUE };
}

/** Ajout d'un participant en interne (staff). */
export async function addRegistration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const eventId = fdStr(formData, "eventId");
  const firstName = fdStr(formData, "firstName");
  const lastName = fdStr(formData, "lastName");
  if (!eventId || !firstName || !lastName) return { ok: false, error: "Nom et prénom obligatoires." };
  // LA PORTE DE L'ÉVÉNEMENT (audit 27/10, SA-13) : le droit du module ET la fiche — société, parties prenantes.
  const porte = await ouvrirPourEcrire(user, "EVENT", eventId, "UPDATE");
  if (!porte.ok) return porte;
  if (estStatutInscriptionRetire(fdStr(formData, "status"))) return { ok: false, error: REFUS_LISTE_ATTENTE };
  await prisma.eventRegistration.create({
    data: {
      eventId, firstName, lastName,
      specialty: fdStr(formData, "specialty"), institution: fdStr(formData, "institution"),
      city: fdStr(formData, "city"), email: fdStr(formData, "email"), phone: fdStr(formData, "phone"),
      role: inEnum(ParticipantRole, fdStr(formData, "role"), "DOCTOR"),
      comment: fdStr(formData, "comment"),
      status: inEnum(RegistrationStatus, fdStr(formData, "status"), "CONFIRMED"), source: "internal",
    },
  });
  revalidatePath(`/events/${eventId}`);
  return { ok: true };
}

export async function setRegistrationStatus(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  const status = fdStr(formData, "status");
  if (!id || !status) return { ok: false, error: "Paramètres manquants." };
  const porte = await ouvrirPourEcrire(user, "EVENT_REGISTRATION", id, "UPDATE");
  if (!porte.ok) return porte;
  if (estStatutInscriptionRetire(status)) return { ok: false, error: REFUS_LISTE_ATTENTE };
  const reg = await prisma.eventRegistration.update({
    where: { id },
    data: {
      status: inEnum(RegistrationStatus, status, "REGISTERED"),
      checkedInAt: status === "PRESENT" ? new Date() : undefined,
    },
    select: { eventId: true },
  });
  revalidatePath(`/events/${reg.eventId}`);
  return { ok: true };
}

/** Check-in par jeton QR : marque « présent ». */
export async function checkInByToken(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "EVENTS", "UPDATE")) return { ok: false, error: "Non autorisé." };
  const token = fdStr(formData, "token");
  if (!token) return { ok: false, error: "Jeton manquant." };
  const reg = await prisma.eventRegistration.findUnique({ where: { qrToken: token }, select: { id: true, eventId: true } });
  if (!reg) return { ok: false, error: "Participant introuvable." };
  const porte = await ouvrirPourEcrire(user, "EVENT_REGISTRATION", reg.id, "UPDATE");
  if (!porte.ok) return porte;
  await prisma.eventRegistration.update({ where: { id: reg.id }, data: { status: "PRESENT", checkedInAt: new Date() } });
  revalidatePath(`/events/${reg.eventId}`);
  return { ok: true, id: reg.eventId };
}

export async function deleteRegistration(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Identifiant manquant." };
  const porte = await ouvrirPourEcrire(user, "EVENT_REGISTRATION", id, "UPDATE");
  if (!porte.ok) return porte;
  const reg = await prisma.eventRegistration.delete({ where: { id }, select: { eventId: true } });
  revalidatePath(`/events/${reg.eventId}`);
  return { ok: true };
}
