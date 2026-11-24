"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdBool, fdStr, type ActionResult } from "@/lib/actions/types";
import {
  bilanDesNotes, cleLibre, grillesIdentiques, lireGrille, lireNotes, notesRefusees, refusFinalisation, validerGrille,
  type GrilleCoaching,
} from "@/lib/coaching/grille";
import {
  peutAdministrerLeCoaching, peutFinaliserFiche, peutModifierFiche, peutSupprimerFiche, type FaitsFiche, type LecteurCoaching,
} from "@/lib/coaching/acces";
import { clesDejaEmployees, peutCoacherLeCollaborateur, grilleCourante, lecteurCoaching, publierVersion } from "@/lib/coaching/serveur";
import { formaterJour, jourAlger, jourDe, lireJour } from "@/lib/coaching/dates";
import { MODULE_AUDIT_VISITE } from "@/lib/medical/module-visite";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FICHE DE COACHING — écritures (§118.157).
 *
 * Toutes les RÈGLES vivent dans les modules purs (`coaching/grille.ts`, `coaching/acces.ts`) ;
 * ce fichier charge, vérifie avec elles, écrit, prévient. Chaque refus NOMME ce qui manque et
 * le geste qui le lève (§118.30).
 *
 * LA PORTE DE MODULE est la Visite médicale en LECTURE : le directeur des opérations, qui
 * administre la grille, n'y a que la lecture (`rbac.ts`) — l'écriture d'une fiche vient de la
 * règle du coaching, pas du droit CRUD du module.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE = "MEDICAL" as const;
const AUDIT_MODULE = MODULE_AUDIT_VISITE;
const CHEMIN = "/medical/coaching";

const REFUS_MODULE = `La ${MODULE_AUDIT_VISITE} ne vous est pas ouverte.`;
const REFUS_ADMIN = "La grille de coaching est administrée par le directeur des opérations (Direction des opérations, "
  + "Directeur des Opérations) et le Super Admin. Proposez-leur la modification.";

/** Les longueurs de saisie — un bilan se lit en réunion, pas en une heure. */
const MAX_SECTEUR = 200;
const MAX_BILAN = 4000;

function trop(nom: string, v: string | null, max: number): string | null {
  return v && v.length > max ? `${nom} dépasse ${max} caractères (${v.length}).` : null;
}

function lireJson(s: string | null): { ok: true; valeur: unknown } | { ok: false } {
  if (s === null) return { ok: true, valeur: null };
  try { return { ok: true, valeur: JSON.parse(s) }; } catch { return { ok: false }; }
}

function revalider(id?: string) {
  revalidatePath(CHEMIN);
  if (id) revalidatePath(`${CHEMIN}/${id}`);
}

/**
 * PUBLIER UNE VERSION DE LA GRILLE — le geste du directeur des opérations.
 *
 * Une version par modification, jamais une réécriture : les fiches déjà remplies gardent la
 * grille sous laquelle elles l'ont été. Enregistrer sans rien changer ne crée pas de version.
 *
 * LES CLÉS DES AXES AJOUTÉS sont attribuées ICI : un axe dont la clé n'est pas dans la version
 * courante est un axe NOUVEAU, et il reçoit une clé qui n'a jamais servi. L'éditeur envoie une
 * clé provisoire (`nouveau_1`, `coaching/grille.ts`) ; la laisser décider permettrait de
 * ressusciter la clé d'un axe supprimé. Une clé de la version en vigueur, elle, désigne le
 * MÊME axe — c'est ce qui permet de reformuler un critère sans perdre la comparaison.
 */
export async function enregistrerGrilleCoaching(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "VIEW")) return { ok: false, error: REFUS_MODULE };
  if (!peutAdministrerLeCoaching(user)) return { ok: false, error: REFUS_ADMIN };

  const brut = fdStr(formData, "grille");
  if (!brut) return { ok: false, error: "La grille est vide." };
  const json = lireJson(brut);
  if (!json.ok) return { ok: false, error: "La grille ne se lit pas (JSON invalide)." };
  const valide = validerGrille(json.valeur);
  if (!valide.ok) return { ok: false, error: valide.erreurs.join(" ") };

  const courante = await grilleCourante();
  const clesCourantes = new Set(courante.grille.axes.map((a) => a.cle));
  const employees = await clesDejaEmployees();
  const attribuees = new Set<string>([...employees, ...clesCourantes]);
  const grille: GrilleCoaching = {
    ...valide.grille,
    axes: valide.grille.axes.map((axe) => {
      if (clesCourantes.has(axe.cle)) return axe;
      const cle = cleLibre(attribuees);
      attribuees.add(cle);
      return { ...axe, cle };
    }),
  };

  if (courante.version > 0 && grillesIdentiques(grille, courante.grille)) {
    return { ok: true, id: courante.id, message: `Aucune modification : la version ${courante.version} reste en vigueur.` };
  }
  const note = fdStr(formData, "note");
  const erreurNote = trop("Le motif", note, 300);
  if (erreurNote) return { ok: false, error: erreurNote };

  const version = await publierVersion(grille, note, user.id);
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: AUDIT_MODULE, entityId: version.id,
    summary: `Grille de coaching — version ${version.version} publiée (${grille.axes.length} axe(s))${note ? ` : ${note}` : ""}`,
  });
  revalidatePath(CHEMIN);
  revalidatePath(`${CHEMIN}/grille`);
  return {
    ok: true, id: version.id,
    message: `Version ${version.version} publiée — les nouvelles fiches l'utilisent ; les fiches déjà remplies gardent leur grille.`,
  };
}

/** Les champs d'une fiche communs à la création et à la modification, lus et vérifiés une fois. */
interface Saisie {
  visitDate: Date | null;
  sector: string | null;
  scores: unknown;
  strengths: string | null;
  improvements: string | null;
}

function verifierSaisie(s: Saisie, grille: GrilleCoaching): string[] {
  const erreurs: string[] = [];
  if (s.visitDate && jourDe(s.visitDate) > jourAlger()) {
    erreurs.push(`La tournée du ${formaterJour(s.visitDate)} n'a pas encore eu lieu — une fiche de coaching évalue une visite observée.`);
  }
  for (const e of [trop("Le secteur", s.sector, MAX_SECTEUR), trop("Les points forts", s.strengths, MAX_BILAN), trop("Les points à améliorer", s.improvements, MAX_BILAN)]) {
    if (e) erreurs.push(e);
  }
  const refus = notesRefusees(s.scores, grille);
  if (refus.length) erreurs.push(`Notes refusées : ${refus.join(" ; ")}.`);
  return erreurs;
}

/**
 * CE QUE LE COLLABORATEUR REÇOIT — le texte seul. L'ÉCRITURE de la notification reste dans le
 * corps de chaque action : la dérivation des contrats ne suit qu'un niveau de délégation, et une
 * notification écrite deux appels plus bas disparaîtrait de ce que l'action déclare toucher —
 * la carte cesserait de dire qu'une personne va être prévenue (§118.120, §118.137).
 */
function avisDeFinalisation(id: string, collaboratorId: string, visitDate: Date, par: string, total: number, max: number) {
  return {
    userId: collaboratorId, type: "MEDICAL_TOUR" as const, link: `${CHEMIN}/${id}`,
    title: "Votre fiche de coaching est disponible",
    body: `${par} a finalisé la fiche de votre tournée en double du ${formaterJour(visitDate)} — total ${total} / ${max}.`,
  };
}

/**
 * CRÉER UNE FICHE — le manager, après sa tournée en double.
 *
 * `finaliser` la partage aussitôt avec le collaborateur (elle doit alors être complète) ; sans
 * lui, c'est un brouillon que seuls son auteur et l'administration voient.
 */
export async function creerFicheCoaching(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "VIEW")) return { ok: false, error: REFUS_MODULE };
  const l = await lecteurCoaching(user);

  const collaboratorId = fdStr(formData, "collaboratorId");
  if (!collaboratorId) return { ok: false, error: "Choisissez le collaborateur évalué." };
  if (collaboratorId === user.id) return { ok: false, error: "On ne remplit pas sa propre fiche de coaching : c'est le manager de la tournée en double qui l'écrit." };
  if (!(await peutCoacherLeCollaborateur(l, collaboratorId))) {
    return {
      ok: false,
      error: "Ce collaborateur n'est pas dans votre périmètre de coaching — vous coachez les KAM de vos Business Units "
        + "(Business Units). Le directeur des opérations peut remplir la fiche pour vous.",
    };
  }
  const managerId = await designerManager(l, user.id, fdStr(formData, "managerId"));
  if (!managerId.ok) return { ok: false, error: managerId.error };

  const jourSaisi = fdStr(formData, "visitDate");
  if (!jourSaisi) return { ok: false, error: "Indiquez le jour de la tournée en double." };
  const visitDate = lireJour(jourSaisi);
  if (!visitDate) return { ok: false, error: `« ${jourSaisi} » n'est pas un jour (attendu : AAAA-MM-JJ).` };

  const scoresBrut = lireJson(fdStr(formData, "scores"));
  if (!scoresBrut.ok) return { ok: false, error: "Les notes ne se lisent pas (JSON invalide)." };
  const courante = await grilleCourante();
  if (!courante.id) {
    return { ok: false, error: "La grille de coaching ne se lit pas : le directeur des opérations doit la republier (Visite médicale › Coaching › Grille)." };
  }
  const saisie: Saisie = {
    visitDate,
    sector: fdStr(formData, "sector"),
    scores: scoresBrut.valeur,
    strengths: fdStr(formData, "strengths"),
    improvements: fdStr(formData, "improvements"),
  };
  const erreurs = verifierSaisie(saisie, courante.grille);
  if (erreurs.length) return { ok: false, error: erreurs.join(" ") };

  const notes = lireNotes(saisie.scores, courante.grille);
  const bilan = bilanDesNotes(courante.grille, notes);
  const finaliser = fdBool(formData, "finaliser");
  if (finaliser) {
    const refus = refusFinalisation(bilan);
    if (refus) return { ok: false, error: refus };
  }

  const cree = await prisma.coachingSheet.create({
    data: {
      gridId: courante.id,
      collaboratorId,
      managerId: managerId.id,
      visitDate,
      sector: saisie.sector,
      scores: notes,
      strengths: saisie.strengths,
      improvements: saisie.improvements,
      status: finaliser ? "FINALIZED" : "DRAFT",
      finalizedAt: finaliser ? new Date() : null,
      finalizedById: finaliser ? user.id : null,
      createdById: user.id,
    },
    select: { id: true, collaborator: { select: { name: true } } },
  });
  await recordAudit({
    actorId: user.id, action: "CREATE", module: AUDIT_MODULE, entityId: cree.id,
    summary: `Fiche de coaching — ${cree.collaborator.name}, tournée du ${formaterJour(visitDate)}${finaliser ? `, finalisée (${bilan.total}/${bilan.max})` : " (brouillon)"}`,
  });
  if (finaliser) await notifyUser(avisDeFinalisation(cree.id, collaboratorId, visitDate, user.name, bilan.total, bilan.max));
  revalider(cree.id);
  return { ok: true, id: cree.id, message: finaliser ? "Fiche finalisée et partagée avec le collaborateur." : "Brouillon enregistré." };
}

/**
 * LE MANAGER DE LA FICHE — celui qui a fait la tournée. Par défaut l'auteur ; l'administration
 * peut en désigner un autre (elle recopie la fiche papier d'un superviseur), jamais quelqu'un
 * d'autre ne se donne un autre nom que le sien.
 */
async function designerManager(l: LecteurCoaching, auteurId: string, demande: string | null): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  if (!demande || demande === auteurId) return { ok: true, id: auteurId };
  if (!l.administre) return { ok: false, error: "Vous êtes le manager de vos fiches : seul le directeur des opérations peut en attribuer une à un autre manager." };
  const m = await prisma.user.findUnique({ where: { id: demande }, select: { isActive: true } });
  if (!m?.isActive) return { ok: false, error: "Le manager désigné est introuvable ou inactif." };
  return { ok: true, id: demande };
}


async function chargerFaits(id: string) {
  return prisma.coachingSheet.findUnique({
    where: { id },
    select: {
      id: true, collaboratorId: true, managerId: true, createdById: true, status: true, visitDate: true, scores: true,
      grid: { select: { content: true } },
    },
  });
}

function refusDeModification(l: LecteurCoaching, f: FaitsFiche): string {
  if (f.status === "FINALIZED") return "Cette fiche est finalisée et a été partagée avec le collaborateur : seul le directeur des opérations peut la modifier.";
  if (f.createdById !== l.id && f.managerId !== l.id) return "Seuls l'auteur de la fiche, son manager et le directeur des opérations peuvent la modifier.";
  return "Modification refusée.";
}

/**
 * MODIFIER UNE FICHE. Une clé ABSENTE du formulaire garde sa valeur ; une clé présente et vide
 * l'efface — l'empreinte réelle ne dépasse jamais l'empreinte demandée (§118.16).
 *
 * Les notes se vérifient contre la grille DE LA FICHE, pas contre celle du jour : une fiche de
 * la version 1 se corrige dans les critères de la version 1.
 */
export async function modifierFicheCoaching(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "VIEW")) return { ok: false, error: REFUS_MODULE };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche introuvable." };
  const l = await lecteurCoaching(user);
  const f = await chargerFaits(id);
  // Une fiche qu'on ne peut pas lire n'existe pas pour soi (§118.157, `chargerFicheVisible`).
  if (!f) return { ok: false, error: "Fiche introuvable." };
  if (!peutModifierFiche(l, f)) return { ok: false, error: refusDeModification(l, f) };
  const grille = lireGrille(f.grid.content);
  if (!grille) return { ok: false, error: "La grille de cette fiche ne se lit plus : elle ne peut pas être corrigée ici." };

  const data: Record<string, unknown> = {};
  if (formData.has("collaboratorId")) {
    // `=== null` et non `!v` : ce champ est FACULTATIF ici (clé absente = inchangé), et la
    // dérivation des contrats lit un `if (!v)` comme « obligatoire » (§118.138).
    const collaboratorId = fdStr(formData, "collaboratorId");
    if (collaboratorId === null) return { ok: false, error: "Choisissez le collaborateur évalué." };
    if (collaboratorId !== f.collaboratorId) {
      if (f.status === "FINALIZED") return { ok: false, error: "Le collaborateur d'une fiche finalisée ne change pas : retirez-la et remplissez-en une nouvelle." };
      if (!(await peutCoacherLeCollaborateur(l, collaboratorId))) return { ok: false, error: "Ce collaborateur n'est pas dans votre périmètre de coaching." };
      data.collaboratorId = collaboratorId;
    }
  }
  if (formData.has("managerId")) {
    const m = await designerManager(l, f.managerId ?? user.id, fdStr(formData, "managerId"));
    if (!m.ok) return { ok: false, error: m.error };
    data.managerId = m.id;
  }
  let visitDate = f.visitDate;
  if (formData.has("visitDate")) {
    const d = lireJour(fdStr(formData, "visitDate"));
    if (d === null) return { ok: false, error: "Indiquez le jour de la tournée en double (AAAA-MM-JJ)." };
    visitDate = d;
    data.visitDate = d;
  }
  const saisie: Saisie = {
    visitDate: formData.has("visitDate") ? visitDate : null,
    sector: formData.has("sector") ? fdStr(formData, "sector") : null,
    scores: null,
    strengths: formData.has("strengths") ? fdStr(formData, "strengths") : null,
    improvements: formData.has("improvements") ? fdStr(formData, "improvements") : null,
  };
  let notes = lireNotes(f.scores, grille);
  if (formData.has("scores")) {
    const s = lireJson(fdStr(formData, "scores"));
    if (!s.ok) return { ok: false, error: "Les notes ne se lisent pas (JSON invalide)." };
    saisie.scores = s.valeur;
    notes = lireNotes(s.valeur, grille);
    data.scores = notes;
  }
  const erreurs = verifierSaisie(saisie, grille);
  if (erreurs.length) return { ok: false, error: erreurs.join(" ") };
  if (formData.has("sector")) data.sector = saisie.sector;
  if (formData.has("strengths")) data.strengths = saisie.strengths;
  if (formData.has("improvements")) data.improvements = saisie.improvements;

  const bilan = bilanDesNotes(grille, notes);
  // UNE FICHE FINALISÉE RESTE COMPLÈTE : le collaborateur l'a lue entière, lui retirer une note
  // en ferait une évaluation qu'on n'aurait jamais pu finaliser.
  if (f.status === "FINALIZED" && !bilan.complet) {
    return { ok: false, error: `Une fiche finalisée reste complète. ${refusFinalisation(bilan)}` };
  }
  const finaliser = fdBool(formData, "finaliser") && peutFinaliserFiche(l, f);
  if (finaliser) {
    const refus = refusFinalisation(bilan);
    if (refus) return { ok: false, error: refus };
    Object.assign(data, { status: "FINALIZED", finalizedAt: new Date(), finalizedById: user.id });
  }

  const maj = await prisma.coachingSheet.update({
    where: { id }, data,
    select: { collaboratorId: true, visitDate: true, collaborator: { select: { name: true } } },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: AUDIT_MODULE, entityId: id,
    summary: `Fiche de coaching — ${maj.collaborator.name}, tournée du ${formaterJour(maj.visitDate)} : `
      + (finaliser ? `finalisée (${bilan.total}/${bilan.max})` : f.status === "FINALIZED" ? "modifiée après finalisation" : "brouillon modifié"),
  });
  if (finaliser) await notifyUser(avisDeFinalisation(id, maj.collaboratorId, maj.visitDate, user.name, bilan.total, bilan.max));
  else if (f.status === "FINALIZED") {
    // Le collaborateur a lu cette fiche : la retoucher sans le lui dire en ferait une autre
    // évaluation que celle dont il se souvient.
    await notifyUser({
      userId: maj.collaboratorId, type: "MEDICAL_TOUR", link: `${CHEMIN}/${id}`,
      title: "Votre fiche de coaching a été modifiée",
      body: `${user.name} a modifié la fiche de votre tournée en double du ${formaterJour(maj.visitDate)} — total ${bilan.total} / ${bilan.max}.`,
    });
  }
  revalider(id);
  return { ok: true, id, message: finaliser ? "Fiche finalisée et partagée avec le collaborateur." : "Fiche enregistrée." };
}

/** FINALISER — la fiche complète est partagée avec le collaborateur, qui en est prévenu. */
export async function finaliserFicheCoaching(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "VIEW")) return { ok: false, error: REFUS_MODULE };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche introuvable." };
  const l = await lecteurCoaching(user);
  const f = await chargerFaits(id);
  if (!f) return { ok: false, error: "Fiche introuvable." };
  if (f.status === "FINALIZED") return { ok: false, error: "Cette fiche est déjà finalisée." };
  if (!peutFinaliserFiche(l, f)) return { ok: false, error: "Seuls l'auteur de la fiche, son manager et le directeur des opérations la finalisent." };
  const grille = lireGrille(f.grid.content);
  if (!grille) return { ok: false, error: "La grille de cette fiche ne se lit plus." };
  const bilan = bilanDesNotes(grille, lireNotes(f.scores, grille));
  const refus = refusFinalisation(bilan);
  if (refus) return { ok: false, error: refus };

  // L'ÉCRITURE EST CONDITIONNELLE : deux clics simultanés ne préviennent pas deux fois le
  // collaborateur — seul le passage qui trouve encore un brouillon gagne.
  const { count } = await prisma.coachingSheet.updateMany({
    where: { id, status: "DRAFT" },
    data: { status: "FINALIZED", finalizedAt: new Date(), finalizedById: user.id },
  });
  if (count === 0) return { ok: false, error: "Cette fiche est déjà finalisée." };
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: AUDIT_MODULE, entityId: id,
    summary: `Fiche de coaching finalisée — tournée du ${formaterJour(f.visitDate)} (${bilan.total}/${bilan.max})`,
  });
  await notifyUser(avisDeFinalisation(id, f.collaboratorId, f.visitDate, user.name, bilan.total, bilan.max));
  revalider(id);
  return { ok: true, id, message: "Fiche finalisée et partagée avec le collaborateur." };
}

/**
 * SUPPRIMER — l'auteur retire son brouillon ; l'administration retire toute fiche. Retirer une
 * fiche que le collaborateur a lue se DIT : elle disparaîtrait de son écran sans explication.
 */
export async function supprimerFicheCoaching(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, MODULE, "VIEW")) return { ok: false, error: REFUS_MODULE };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Fiche introuvable." };
  const l = await lecteurCoaching(user);
  const f = await chargerFaits(id);
  if (!f) return { ok: false, error: "Fiche introuvable." };
  if (!peutSupprimerFiche(l, f)) {
    return {
      ok: false,
      error: f.status === "FINALIZED"
        ? "Une fiche finalisée ne se retire que par le directeur des opérations."
        : "Seul l'auteur d'un brouillon (ou le directeur des opérations) le retire.",
    };
  }
  await prisma.coachingSheet.delete({ where: { id } });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: AUDIT_MODULE, entityId: id,
    summary: `Fiche de coaching retirée — tournée du ${formaterJour(f.visitDate)}${f.status === "FINALIZED" ? " (finalisée)" : " (brouillon)"}`,
  });
  if (f.status === "FINALIZED") {
    await notifyUser({
      userId: f.collaboratorId, type: "MEDICAL_TOUR",
      title: "Une fiche de coaching a été retirée",
      body: `${user.name} a retiré la fiche de votre tournée en double du ${formaterJour(f.visitDate)}.`,
      link: CHEMIN,
    });
  }
  revalider();
  return { ok: true, message: "Fiche retirée." };
}
