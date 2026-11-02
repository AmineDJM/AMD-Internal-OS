"use server";

import { revalidatePath } from "next/cache";
import type { MoyenGeneralType } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { createWithRetry, referenceDeSerie } from "@/lib/refs";
import { actionReversible } from "@/lib/effets/reversible";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { conflitsDeReservation } from "./infra/registre-serveur";
import { LIBELLE_TYPE_MOYEN, libelleInstant, lireCreneau, lireTypeMoyen, TYPES_RESERVABLES } from "./domaine/registre";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE REGISTRE DES MOYENS GÉNÉRAUX (lot T3) — créer, modifier, archiver une fiche (véhicule, assurance, contrat de
 * prestataire, entretien, salle, équipement, fournitures) ; réserver une salle ou un véhicule, annuler la réservation.
 *
 * DROITS : le module « Moyens généraux » (`GENERAL_MEANS`) — CRÉER pour une fiche, MODIFIER pour la changer ou
 * l'archiver ; RÉSERVER demande seulement de VOIR le module (l'assistante, l'équipe des moyens généraux) ; annuler une
 * réservation : la personne qui l'a faite, ou qui peut MODIFIER le module.
 * RÉVERSIBLE : chaque action est un geste du journal des effets (`actionReversible`, déclarations `metiers.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PATH = "/moyens-generaux/registre";
const revalider = () => { revalidatePath(PATH); revalidatePath("/moyens-generaux"); };

const dateOuNull = (s: string | null): Date | null | "illisible" => {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return "illisible";
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "illisible" : d;
};

async function prochaineReference(): Promise<string> {
  const annee = new Date().getFullYear();
  return referenceDeSerie({
    modele: "MoyenGeneral", prefixe: "MG", annee,
    existantes: async () => (await prisma.moyenGeneral.findMany({ where: { reference: { startsWith: `MG-${annee}-` } }, select: { reference: true } })).map((r) => r.reference),
  });
}

/** Les champs communs d'une fiche, lus du formulaire — `erreur` dit le premier champ illisible. */
function lireChamps(formData: FormData, creation: boolean) {
  const type = fdStr(formData, "type");
  const t = type ? lireTypeMoyen(type) : null;
  if (creation && !t) return { erreur: "La nature du moyen est obligatoire (véhicule, assurance, contrat de prestataire, entretien, salle, équipement, fournitures)." } as const;
  if (type && !t) return { erreur: `Nature « ${type} » inconnue.` } as const;
  const libelle = fdStr(formData, "libelle");
  if (creation && !libelle) return { erreur: "Le libellé est obligatoire." } as const;
  const montant = fdNum(formData, "montant");
  if (montant !== null && montant < 0) return { erreur: "Un montant ne peut pas être négatif." } as const;
  const echeance = dateOuNull(fdStr(formData, "echeance"));
  const dateDebut = dateOuNull(fdStr(formData, "dateDebut"));
  if (echeance === "illisible" || dateDebut === "illisible") return { erreur: "Une date est illisible (attendu : AAAA-MM-JJ)." } as const;
  if (echeance && dateDebut && echeance < dateDebut) return { erreur: "L'échéance précède la date de début." } as const;
  const rappel = fdNum(formData, "rappelJours");
  const capacite = fdNum(formData, "capacite");
  const data: Record<string, unknown> = {};
  const poser = (cle: string, v: unknown) => { if (formData.has(cle)) data[cle] = v; };
  if (t) data.type = t as MoyenGeneralType;
  if (libelle) data.libelle = libelle;
  poser("description", fdStr(formData, "description"));
  poser("prestataire", fdStr(formData, "prestataire"));
  poser("identifiant", fdStr(formData, "identifiant"));
  poser("periodicite", fdStr(formData, "periodicite"));
  poser("notes", fdStr(formData, "notes"));
  poser("responsableId", fdStr(formData, "responsableId"));
  poser("parentId", fdStr(formData, "parentId"));
  if (formData.has("montant")) data.montant = montant;
  if (formData.has("echeance")) data.echeance = echeance;
  if (formData.has("dateDebut")) data.dateDebut = dateDebut;
  if (rappel !== null) data.rappelJours = Math.max(0, Math.min(365, Math.round(rappel)));
  if (capacite !== null) data.capacite = Math.max(0, Math.round(capacite));
  return { data } as const;
}

export async function creerMoyenGeneral(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  return actionReversible("moyens-generaux-registre-actions:creerMoyenGeneral", "Moyen général enregistré", async () => {
    const user = await requireUser();
    if (!userCan(user, "GENERAL_MEANS", "CREATE")) return { ok: false, error: "Non autorisé : le registre des moyens généraux demande le droit de créer dans « Moyens généraux »." };
    const lu = lireChamps(formData, true);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    const parentId = lu.data.parentId as string | null | undefined;
    if (parentId && !(await prisma.moyenGeneral.findUnique({ where: { id: parentId }, select: { id: true } }))) return { ok: false, error: "Le moyen de rattachement est introuvable." };
    const libelle = lu.data.libelle as string;
    const doublon = await prisma.moyenGeneral.findFirst({
      where: { type: lu.data.type as MoyenGeneralType, libelle: { equals: libelle, mode: "insensitive" }, statut: "ACTIF", ...(lu.data.identifiant ? { identifiant: lu.data.identifiant as string } : {}) },
      select: { reference: true },
    });
    if (doublon) return { ok: false, error: `Ce moyen existe déjà au registre (${doublon.reference}) : modifiez-le plutôt.` };
    const cree = await createWithRetry(async () => prisma.moyenGeneral.create({
      data: { ...(lu.data as object), type: lu.data.type as MoyenGeneralType, libelle, reference: await prochaineReference(), createdById: user.id },
      select: { id: true, reference: true },
    }));
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Moyens généraux", entityId: cree.id, summary: `${LIBELLE_TYPE_MOYEN[lu.data.type as keyof typeof LIBELLE_TYPE_MOYEN]} « ${libelle} » enregistré (${cree.reference})` });
    revalider();
    return { ok: true, id: cree.id, message: `${cree.reference} enregistré au registre des moyens généraux.` };
  });
}

export async function modifierMoyenGeneral(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  return actionReversible("moyens-generaux-registre-actions:modifierMoyenGeneral", "Moyen général modifié", async () => {
    const user = await requireUser();
    if (!userCan(user, "GENERAL_MEANS", "UPDATE")) return { ok: false, error: "Non autorisé : modifier le registre demande le droit de modifier « Moyens généraux »." };
    const id = fdStr(formData, "id");
    const avant = id ? await prisma.moyenGeneral.findUnique({ where: { id }, select: { id: true, reference: true } }) : null;
    if (!avant) return { ok: false, error: "Moyen introuvable." };
    const lu = lireChamps(formData, false);
    if ("erreur" in lu) return { ok: false, error: lu.erreur };
    if (!Object.keys(lu.data).length) return { ok: false, error: "Aucun champ à modifier." };
    await prisma.moyenGeneral.update({ where: { id: avant.id }, data: lu.data as object });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Moyens généraux", entityId: avant.id, summary: `${avant.reference} modifié (${Object.keys(lu.data).join(", ")})` });
    revalider();
    return { ok: true, id: avant.id, message: `${avant.reference} mis à jour.` };
  });
}

export async function archiverMoyenGeneral(formData: FormData): Promise<ActionResult> {
  return actionReversible("moyens-generaux-registre-actions:archiverMoyenGeneral", "Moyen général archivé", async () => {
    const user = await requireUser();
    if (!userCan(user, "GENERAL_MEANS", "UPDATE")) return { ok: false, error: "Non autorisé." };
    const id = fdStr(formData, "id");
    const m = id ? await prisma.moyenGeneral.findUnique({ where: { id }, select: { id: true, reference: true, statut: true } }) : null;
    if (!m) return { ok: false, error: "Moyen introuvable." };
    if (m.statut === "ARCHIVE") return { ok: true, message: `${m.reference} est déjà archivé.` };
    await prisma.moyenGeneral.update({ where: { id: m.id }, data: { statut: "ARCHIVE" } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Moyens généraux", entityId: m.id, summary: `${m.reference} archivé` });
    revalider();
    return { ok: true, message: `${m.reference} archivé.` };
  });
}

export async function reserverMoyenGeneral(_prev: ActionResult | undefined, formData: FormData): Promise<ActionResult> {
  return actionReversible("moyens-generaux-registre-actions:reserverMoyenGeneral", "Réservation enregistrée", async () => {
    const user = await requireUser();
    if (!userCan(user, "GENERAL_MEANS", "VIEW")) return { ok: false, error: "Non autorisé : réserver une salle ou un véhicule passe par le module « Moyens généraux »." };
    const moyenId = fdStr(formData, "moyenId");
    const m = moyenId ? await prisma.moyenGeneral.findUnique({ where: { id: moyenId }, select: { id: true, reference: true, libelle: true, type: true, statut: true, capacite: true } }) : null;
    if (!m || m.statut !== "ACTIF") return { ok: false, error: "Moyen introuvable ou archivé." };
    if (!TYPES_RESERVABLES.includes(m.type)) return { ok: false, error: `Un(e) ${LIBELLE_TYPE_MOYEN[m.type].toLowerCase()} ne se réserve pas.` };
    const objet = fdStr(formData, "objet");
    if (!objet) return { ok: false, error: "L'objet de la réservation est obligatoire." };
    const creneau = lireCreneau(fdStr(formData, "debut"), fdStr(formData, "fin"));
    if (!creneau) return { ok: false, error: "Le créneau est illisible ou sa fin précède son début (attendu : AAAA-MM-JJTHH:MM)." };
    const participants = fdNum(formData, "participants");
    if (participants !== null && m.capacite && participants > m.capacite) return { ok: false, error: `${m.libelle} compte ${m.capacite} places : ${participants} participants n'y tiennent pas.` };
    const conflits = await conflitsDeReservation(m.id, creneau);
    if (conflits.length) return { ok: false, error: `${m.libelle} est déjà réservé(e) sur ce créneau : ${conflits.map((c) => `${libelleInstant(c.debut)} → ${libelleInstant(c.fin)} (${c.objet})`).join(" ; ")}.` };
    const r = await prisma.moyenGeneralReservation.create({
      data: { moyenId: m.id, debut: creneau.debut, fin: creneau.fin, objet, participants: participants !== null ? Math.round(participants) : null, reserveParId: user.id },
      select: { id: true },
    });
    await recordAudit({ actorId: user.id, action: "CREATE", module: "Moyens généraux", entityId: m.id, summary: `${m.reference} réservé du ${libelleInstant(creneau.debut)} au ${libelleInstant(creneau.fin)} — ${objet}` });
    revalider();
    return { ok: true, id: r.id, message: `${m.libelle} réservé(e) du ${libelleInstant(creneau.debut)} au ${libelleInstant(creneau.fin)}.` };
  });
}

export async function annulerReservationMoyenGeneral(formData: FormData): Promise<ActionResult> {
  return actionReversible("moyens-generaux-registre-actions:annulerReservationMoyenGeneral", "Réservation annulée", async () => {
    const user = await requireUser();
    const id = fdStr(formData, "id");
    const r = id ? await prisma.moyenGeneralReservation.findUnique({ where: { id }, select: { id: true, statut: true, reserveParId: true, moyen: { select: { id: true, reference: true } } } }) : null;
    if (!r) return { ok: false, error: "Réservation introuvable." };
    if (r.reserveParId !== user.id && !userCan(user, "GENERAL_MEANS", "UPDATE")) return { ok: false, error: "Seule la personne qui a réservé, ou l'équipe des moyens généraux, peut annuler." };
    if (r.statut === "ANNULEE") return { ok: true, message: "Réservation déjà annulée." };
    await prisma.moyenGeneralReservation.update({ where: { id: r.id }, data: { statut: "ANNULEE" } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Moyens généraux", entityId: r.moyen.id, summary: `Réservation de ${r.moyen.reference} annulée` });
    revalider();
    return { ok: true, message: "Réservation annulée." };
  });
}
