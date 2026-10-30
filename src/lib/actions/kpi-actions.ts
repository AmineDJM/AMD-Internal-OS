"use server";

import { revalidatePath } from "next/cache";
import * as XLSX from "xlsx";
import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { fdNum, fdStr, type ActionResult } from "@/lib/actions/types";
import { putBlob } from "@/lib/drive-storage";
import { checkAttachment, rejectionMessage } from "@/lib/files/attachment-policy";
import { getManagerOfUser } from "@/lib/departments";
import { FREQUENCES } from "@/lib/kpi/briques";
import { validerDefinition, type DefinitionKpi } from "@/lib/kpi/definition";
import { fenetre } from "@/lib/kpi/score";
import { lienBilanKpi, lienKpiEquipe } from "@/lib/chemins/espace";
import {
  peutCreerPourEquipe, peutDeclarer, peutGererCatalogue, peutGererPersonne, peutModifierDefinition,
} from "@/lib/kpi/droits";
import {
  apercuDefinitions, chargerBilanKpi, colonnesDefinition, definitionParId, definitionsActives, detailKpi, faitsKpi,
  kpisPourCommentaire, lignesAFiger, nouvelleFamille, sourcesEvaluation,
} from "@/lib/kpi/service";
import { proposerCibles, proposerDefinitions, proposerNiveau, redigerCommentaire } from "@/lib/kpi-luna";
import type { ApercuKpi, BilanKpi, LigneDetail } from "@/lib/kpi/types";
import type { HorsBriques } from "@/lib/kpi/luna-pur";
import { sansBloquer } from "@/lib/journal";
import { inscrirePiece } from "@/modules/bibliotheque/api-inscription";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * KPI & BILANS — les gestes (KPI sans code, Direction 08/10). Chaque action revérifie ses droits : le périmètre est
 * l'arbre de Mon équipe (`faitsKpi`), la règle est `kpi/droits.ts`. Luna rédige et propose ; aucune action ne lui
 * laisse écrire un chiffre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODULE = "KPI";

function revalider() {
  revalidatePath("/mon-equipe");
  revalidatePath("/mon-espace/bilan");
  revalidatePath("/admin/kpi");
}

function lireDefinitions(json: string | null): { ok: true; defs: DefinitionKpi[] } | { ok: false; error: string } {
  let brut: unknown;
  try { brut = JSON.parse(json ?? "[]"); } catch { return { ok: false, error: "Définitions illisibles." }; }
  const liste = Array.isArray(brut) ? brut : [brut];
  if (liste.length === 0 || liste.length > 6) return { ok: false, error: "Une à six définitions à la fois." };
  const defs: DefinitionKpi[] = [];
  for (const x of liste) {
    const r = validerDefinition(x);
    if (!r.ok) return { ok: false, error: r.erreurs.join(" ") };
    defs.push(r.def);
  }
  return { ok: true, defs };
}

// ── Lire ─────────────────────────────────────────────────────────────────────────────────────

/** Le bilan d'une personne (panneau de Mon équipe, Mon bilan). */
export async function bilanKpi(personneId: string, periode: string): Promise<{ ok: true; bilan: BilanKpi } | { ok: false; error: string }> {
  const user = await enLecture(requireUser);
  const b = await chargerBilanKpi(user, personneId, periode || null);
  return b ? { ok: true, bilan: b } : { ok: false, error: "Ce bilan ne vous est pas ouvert." };
}

/** « D'où vient le chiffre » : les lignes qui composent le numérateur et le dénominateur. */
export async function origineKpi(definitionId: string, personneId: string, periode: string): Promise<{ ok: true; blocs: { titre: string; lignes: LigneDetail[] }[] } | { ok: false; error: string }> {
  const user = await enLecture(requireUser);
  const blocs = await detailKpi(user, definitionId, personneId, periode);
  return blocs ? { ok: true, blocs } : { ok: false, error: "Ce détail ne vous est pas ouvert." };
}

/** Le catalogue : toutes les définitions actives (Super Admin), ou celles de mon équipe, avec leurs affectations. */
export async function catalogueKpi(): Promise<{
  ok: boolean;
  error?: string;
  definitions: { id: string; famille: string; version: number; nom: string; nature: string; portee: string; modifiable: boolean; def: DefinitionKpi }[];
  affectations: { id: string; famille: string; cible: string; role: string | null; managerUserId: string | null; userId: string | null; poids: number }[];
}> {
  const user = await enLecture(requireUser);
  const { faits } = await faitsKpi(user);
  if (!faits.superAdmin && !peutCreerPourEquipe(faits)) return { ok: false, error: "Réservé à qui encadre une équipe.", definitions: [], affectations: [] };
  const defs = await definitionsActives();
  const affect = await prisma.kpiAssignment.findMany({
    where: faits.superAdmin ? {} : { OR: [{ managerUserId: user.id }, { userId: { in: [...faits.equipe] } }] },
    select: { id: true, famille: true, cible: true, role: true, managerUserId: true, userId: true, poids: true },
  });
  const familles = new Set(affect.map((a) => a.famille));
  const visibles = faits.superAdmin ? defs : defs.filter((d) => familles.has(d.famille) || d.createdById === user.id);
  return {
    ok: true,
    definitions: visibles.map((d) => ({ id: d.id, famille: d.famille, version: d.version, nom: d.def.nom, nature: d.def.nature, portee: d.portee, modifiable: peutModifierDefinition(faits, d), def: d.def })),
    affectations: affect,
  };
}

// ── Créer avec Luna ──────────────────────────────────────────────────────────────────────────

/** (a) Une phrase → des définitions (Luna, sinon le repli par mots-clés). */
export async function proposerKpiDepuisPhrase(formData: FormData): Promise<{
  ok: boolean; error?: string; message?: string; propositions?: { def: DefinitionKpi; explication: string | null }[];
  rejets?: string[]; horsBriques?: HorsBriques | null; parLuna?: boolean; note?: string | null;
}> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  if (!peutCreerPourEquipe(faits)) return { ok: false, error: "Créer un KPI est réservé à qui encadre une équipe." };
  const phrase = fdStr(formData, "phrase");
  if (!phrase || phrase.length < 6) return { ok: false, error: "Décrivez ce que vous voulez mesurer, en une phrase." };
  const r = await proposerDefinitions(phrase.slice(0, 1500), user.id);
  return { ok: true, ...r };
}

/**
 * L'aperçu sur les 3 derniers mois réels de l'équipe — rien n'est enregistré. Les cibles vides sont PROPOSÉES par Luna
 * d'après l'historique mensuel (3 à 6 mois) de l'équipe et de la personne visée (`pour`), avec leur justification ;
 * sans Luna ou sans historique, c'est la règle fixe (moyenne ↔ meilleur de l'équipe).
 */
export async function apercuKpi(formData: FormData): Promise<{ ok: true; apercu: ApercuKpi } | { ok: false; error: string }> {
  const user = await enLecture(requireUser);
  const { faits } = await faitsKpi(user);
  if (!peutCreerPourEquipe(faits)) return { ok: false, error: "Réservé à qui encadre une équipe." };
  const lu = lireDefinitions(fdStr(formData, "definitions"));
  if (!lu.ok) return lu;
  return { ok: true, apercu: await apercuDefinitions(user, lu.defs, { pour: fdStr(formData, "pour"), cibler: (entrees) => proposerCibles(entrees, user.id) }) };
}

/**
 * AJOUTER des KPI : de nouvelles familles, et leur affectation — à mon équipe (EQUIPE), à une personne de mon
 * équipe (PERSONNE), ou à un rôle (ROLE : le catalogue, Super Admin seul).
 */
export async function creerKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const lu = lireDefinitions(fdStr(formData, "definitions"));
  if (!lu.ok) return lu;
  const pour = fdStr(formData, "pour") ?? "EQUIPE";
  const cibleUserId = fdStr(formData, "userId");
  const role = fdStr(formData, "role");
  const poids = Math.min(100, Math.max(1, fdNum(formData, "poids") ?? 10));
  if (pour === "ROLE") {
    if (!peutGererCatalogue(faits)) return { ok: false, error: "Les modèles par rôle sont tenus par le Super Admin." };
    if (!role) return { ok: false, error: "Choisissez le rôle." };
  } else if (pour === "PERSONNE") {
    if (!cibleUserId || !peutGererPersonne(faits, cibleUserId) || !(faits.superAdmin || faits.gestes.creer)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  } else if (!peutCreerPourEquipe(faits)) {
    return { ok: false, error: "Créer un KPI est réservé à qui encadre une équipe." };
  }
  const portee = pour === "ROLE" ? "CATALOGUE" : "EQUIPE";
  await prisma.$transaction(async (tx) => {
    for (const def of lu.defs) {
      const famille = nouvelleFamille();
      await tx.kpiDefinition.create({ data: { famille, version: 1, statut: "ACTIF", portee, createdById: user.id, ...colonnesDefinition(def) } });
      await tx.kpiAssignment.create({
        data: {
          famille, cible: pour === "ROLE" ? "ROLE" : pour === "PERSONNE" ? "PERSONNE" : "EQUIPE",
          role: pour === "ROLE" ? role : null, userId: pour === "PERSONNE" ? cibleUserId : null,
          managerUserId: pour === "EQUIPE" ? user.id : null, poids, createdById: user.id,
        },
      });
    }
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, summary: `${lu.defs.length} KPI créé(s) : ${lu.defs.map((d) => d.nom).join(", ")}` });
  revalider();
  return { ok: true, message: `${lu.defs.length} KPI ajouté${lu.defs.length > 1 ? "s" : ""}.` };
}

/** MODIFIER un KPI = une NOUVELLE VERSION ; l'ancienne est archivée, les revues signées la gardent. */
export async function modifierKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const id = fdStr(formData, "definitionId");
  const d = id ? await definitionParId(id) : null;
  if (!d || d.statut !== "ACTIF") return { ok: false, error: "KPI introuvable ou déjà remplacé." };
  if (!peutModifierDefinition(faits, d)) return { ok: false, error: "Seul l'auteur du KPI (ou le Super Admin) le modifie." };
  const lu = lireDefinitions(fdStr(formData, "definition"));
  if (!lu.ok) return lu;
  const def = lu.defs[0]!;
  if (def.nature !== d.def.nature) return { ok: false, error: "La nature d'un KPI ne change pas : créez-en un autre." };
  const nouvelle = await prisma.$transaction(async (tx) => {
    const max = await tx.kpiDefinition.aggregate({ where: { famille: d.famille }, _max: { version: true } });
    await tx.kpiDefinition.update({ where: { id: d.id }, data: { statut: "ARCHIVE" } });
    return tx.kpiDefinition.create({
      data: { famille: d.famille, version: (max._max.version ?? d.version) + 1, statut: "ACTIF", portee: d.portee, createdById: d.createdById ?? user.id, ...colonnesDefinition(def) },
      select: { id: true, version: true },
    });
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: nouvelle.id, summary: `KPI « ${def.nom} » : version ${nouvelle.version}` });
  revalider();
  return { ok: true, id: nouvelle.id, message: `Version ${nouvelle.version} enregistrée. Les revues déjà signées gardent la leur.` };
}

/** Archiver un KPI (toutes ses affectations tombent ; l'historique et les revues signées restent). */
export async function archiverKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const id = fdStr(formData, "definitionId");
  const d = id ? await definitionParId(id) : null;
  if (!d) return { ok: false, error: "KPI introuvable." };
  if (!peutModifierDefinition(faits, d)) return { ok: false, error: "Seul l'auteur du KPI (ou le Super Admin) le retire." };
  await prisma.$transaction([
    prisma.kpiDefinition.updateMany({ where: { famille: d.famille, statut: "ACTIF" }, data: { statut: "ARCHIVE" } }),
    prisma.kpiAssignment.deleteMany({ where: { famille: d.famille } }),
  ]);
  await recordAudit({ actorId: user.id, action: "DELETE", module: MODULE, entityId: d.id, summary: `KPI « ${d.def.nom} » retiré` });
  revalider();
  return { ok: true, message: "KPI retiré." };
}

/** Poser ou régler une affectation (et son poids). ROLE : Super Admin ; EQUIPE : à mon nom ; PERSONNE : mon équipe. */
export async function reglerAffectationKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const famille = fdStr(formData, "famille");
  const cible = fdStr(formData, "cible") ?? "EQUIPE";
  const role = fdStr(formData, "role");
  const cibleUserId = fdStr(formData, "userId");
  const poids = fdNum(formData, "poids");
  const assignmentId = fdStr(formData, "assignmentId");
  if (poids === null || poids < 0 || poids > 100) return { ok: false, error: "Poids de 0 à 100." };
  // RÉGLER LE POIDS d'une affectation existante — sans en créer une autre à mon nom.
  if (assignmentId) {
    const a = await prisma.kpiAssignment.findUnique({ where: { id: assignmentId } });
    if (!a) return { ok: false, error: "Affectation introuvable." };
    const permis = faits.superAdmin
      || (a.cible === "EQUIPE" && a.managerUserId === user.id && faits.gestes.creer)
      || (a.cible === "PERSONNE" && !!a.userId && peutGererPersonne(faits, a.userId));
    if (!permis) return { ok: false, error: "Cette affectation n'est pas la vôtre." };
    await prisma.kpiAssignment.update({ where: { id: a.id }, data: { poids } });
    revalider();
    return { ok: true, message: "Poids enregistré." };
  }
  if (!famille) return { ok: false, error: "KPI introuvable." };
  if (!(await prisma.kpiDefinition.findFirst({ where: { famille, statut: "ACTIF" }, select: { id: true } }))) return { ok: false, error: "KPI introuvable." };
  let where: { famille: string; cible: string; role?: string | null; managerUserId?: string | null; userId?: string | null };
  if (cible === "ROLE") {
    if (!peutGererCatalogue(faits) || !role) return { ok: false, error: "Les modèles par rôle sont tenus par le Super Admin." };
    where = { famille, cible, role };
  } else if (cible === "PERSONNE") {
    if (!cibleUserId || !peutGererPersonne(faits, cibleUserId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
    where = { famille, cible, userId: cibleUserId };
  } else {
    if (!peutCreerPourEquipe(faits)) return { ok: false, error: "Réservé à qui encadre une équipe." };
    where = { famille, cible: "EQUIPE", managerUserId: user.id };
  }
  const existe = await prisma.kpiAssignment.findFirst({ where, select: { id: true } });
  if (existe) await prisma.kpiAssignment.update({ where: { id: existe.id }, data: { poids } });
  else await prisma.kpiAssignment.create({ data: { ...where, poids, createdById: user.id } });
  revalider();
  return { ok: true, message: "Affectation enregistrée." };
}

export async function retirerAffectationKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const id = fdStr(formData, "assignmentId");
  const a = id ? await prisma.kpiAssignment.findUnique({ where: { id } }) : null;
  if (!a) return { ok: false, error: "Affectation introuvable." };
  const permis = faits.superAdmin
    || (a.cible === "EQUIPE" && a.managerUserId === user.id && faits.gestes.creer)
    || (a.cible === "PERSONNE" && !!a.userId && peutGererPersonne(faits, a.userId));
  if (!permis) return { ok: false, error: "Cette affectation n'est pas la vôtre." };
  await prisma.kpiAssignment.delete({ where: { id: a.id } });
  revalider();
  return { ok: true, message: "Affectation retirée." };
}

/** La fréquence de revue de MON équipe (Direction, 08/10 : « revue au choix du manager »). */
export async function reglerFrequenceRevue(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  if (!faits.superAdmin && !(faits.gestes.valider && faits.equipe.size > 0)) return { ok: false, error: "Réservé à qui encadre une équipe." };
  const frequence = fdStr(formData, "frequence");
  if (!frequence || !(FREQUENCES as readonly string[]).includes(frequence)) return { ok: false, error: "Fréquence inconnue." };
  await prisma.kpiReviewSetting.upsert({ where: { managerUserId: user.id }, create: { managerUserId: user.id, frequence }, update: { frequence } });
  revalider();
  return { ok: true, message: "Fréquence de revue enregistrée." };
}

// ── Évalué ───────────────────────────────────────────────────────────────────────────────────

async function contexteGestion(formData: FormData) {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const definitionId = fdStr(formData, "definitionId");
  const cibleUserId = fdStr(formData, "userId");
  const periode = fdStr(formData, "periode");
  const f = periode ? fenetre(periode) : null;
  const d = definitionId ? await definitionParId(definitionId) : null;
  return { user, faits, d, cibleUserId, f };
}

/** (c) Luna propose un niveau, avec ses preuves citées. Le manager valide ou corrige. */
export async function proposerNiveauKpi(formData: FormData): Promise<ActionResult> {
  const { user, faits, d, cibleUserId, f } = await contexteGestion(formData);
  if (!d || !f || !cibleUserId || d.def.nature !== "EVALUE" || !d.def.grille) return { ok: false, error: "KPI évalué introuvable." };
  if (!peutGererPersonne(faits, cibleUserId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  const sources = await sourcesEvaluation(cibleUserId, f);
  const r = await proposerNiveau({ nomKpi: d.def.nom, grille: d.def.grille, sources }, user.id);
  if (!r.ok) return { ok: false, error: r.raison };
  await prisma.kpiEvaluation.upsert({
    where: { definitionId_userId_periode: { definitionId: d.id, userId: cibleUserId, periode: f.cle } },
    create: { definitionId: d.id, userId: cibleUserId, periode: f.cle, propositionNiveau: r.niveau, propositionPreuves: r.preuves, justification: r.justification, proposeLe: new Date() },
    update: { propositionNiveau: r.niveau, propositionPreuves: r.preuves, justification: r.justification, proposeLe: new Date() },
  });
  revalider();
  return { ok: true, message: `Luna propose le niveau ${r.niveau} — à valider ou corriger.` };
}

export async function validerEvaluationKpi(formData: FormData): Promise<ActionResult> {
  const { user, faits, d, cibleUserId, f } = await contexteGestion(formData);
  if (!d || !f || !cibleUserId || d.def.nature !== "EVALUE" || !d.def.grille) return { ok: false, error: "KPI évalué introuvable." };
  if (!peutGererPersonne(faits, cibleUserId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  const niveau = fdNum(formData, "niveau");
  if (niveau === null || !Number.isInteger(niveau) || niveau < 1 || niveau > d.def.grille.length) return { ok: false, error: `Niveau de 1 à ${d.def.grille.length}.` };
  const commentaire = fdStr(formData, "commentaire")?.slice(0, 1000) ?? null;
  await prisma.kpiEvaluation.upsert({
    where: { definitionId_userId_periode: { definitionId: d.id, userId: cibleUserId, periode: f.cle } },
    create: { definitionId: d.id, userId: cibleUserId, periode: f.cle, niveau, commentaire, valideParId: user.id, valideLe: new Date() },
    update: { niveau, commentaire, valideParId: user.id, valideLe: new Date() },
  });
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE, entityId: d.id, summary: `« ${d.def.nom} » : niveau ${niveau} (${f.cle})` });
  revalider();
  return { ok: true, message: "Niveau enregistré." };
}

// ── Déclaré ──────────────────────────────────────────────────────────────────────────────────

/** Déclarer une valeur (une formation suivie…) avec sa pièce. Pour soi seulement. */
export async function declarerKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const definitionId = fdStr(formData, "definitionId");
  const periode = fdStr(formData, "periode");
  const libelle = fdStr(formData, "libelle");
  const valeur = fdNum(formData, "valeur") ?? 1;
  const d = definitionId ? await definitionParId(definitionId) : null;
  const f = periode ? fenetre(periode) : null;
  if (!d || d.def.nature !== "DECLARE" || !f) return { ok: false, error: "KPI déclaré introuvable." };
  if (!peutDeclarer(faits, user.id)) return { ok: false, error: "Vous ne pouvez pas déclarer." };
  if (!libelle) return { ok: false, error: "Dites ce que vous déclarez (« Formation pharmacovigilance, 12/10 »)." };
  if (valeur <= 0 || valeur > 1000) return { ok: false, error: "Valeur invalide." };
  const fichier = formData.get("piece");
  let piece: { pieceBlobId: string; pieceNom: string; pieceMime: string; empreinte: string; taille: number } | null = null;
  if (fichier instanceof File && fichier.size > 0) {
    const bytes = Buffer.from(await fichier.arrayBuffer());
    const v = checkAttachment(fichier.name, bytes, fichier.type);
    if (!v.ok) return { ok: false, error: rejectionMessage(v.reason!, v.safeName) };
    const { blobId, sha256 } = await putBlob(bytes);
    piece = { pieceBlobId: blobId, pieceNom: v.safeName, pieceMime: v.mime, empreinte: sha256, taille: bytes.length };
  }
  if (!piece) return { ok: false, error: "Joignez la pièce qui le prouve (attestation, programme…)." };
  const cree = await prisma.kpiDeclaration.create({
    data: { definitionId: d.id, userId: user.id, periode: f.cle, libelle: libelle.slice(0, 200), valeur, pieceBlobId: piece.pieceBlobId, pieceNom: piece.pieceNom, pieceMime: piece.pieceMime },
  });
  // La pièce qui prouve la déclaration entre à la bibliothèque (J1), ouverte par la règle du bilan KPI.
  await inscrirePiece({
    blobId: piece.pieceBlobId, empreinte: piece.empreinte, nom: piece.pieceNom, mime: piece.pieceMime, taille: piece.taille, source: "AUTRE",
    objet: { famille: "KPI_PIECE", id: cree.id }, proprietaireId: user.id, role: "justificatif",
  });
  const n1 =await getManagerOfUser(user.id).catch(sansBloquer("kpi-actions.declarerKpi.getManagerOfUser", null));
  if (n1?.userId) {
    await notifyUser({ userId: n1.userId, type: "GENERIC", title: "Déclaration à valider", body: `${user.name} — ${d.def.nom} : ${libelle.slice(0, 80)}`, link: lienKpiEquipe(f.cle) });
  }
  revalider();
  return { ok: true, id: cree.id, message: "Déclaration envoyée à votre responsable." };
}

export async function deciderDeclarationKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const id = fdStr(formData, "declarationId");
  const decision = fdStr(formData, "decision");
  const motif = fdStr(formData, "motif");
  const x = id ? await prisma.kpiDeclaration.findUnique({ where: { id } }) : null;
  if (!x) return { ok: false, error: "Déclaration introuvable." };
  if (!peutGererPersonne(faits, x.userId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  if (decision !== "VALIDEE" && decision !== "REFUSEE") return { ok: false, error: "Décision inconnue." };
  if (decision === "REFUSEE" && !motif) return { ok: false, error: "Un refus se motive." };
  await prisma.kpiDeclaration.update({ where: { id: x.id }, data: { statut: decision, motif: motif?.slice(0, 500) ?? null, valideParId: user.id, valideLe: new Date() } });
  await notifyUser({ userId: x.userId, type: "GENERIC", title: decision === "VALIDEE" ? "Déclaration validée" : "Déclaration refusée", body: `${x.libelle}${motif ? ` — ${motif.slice(0, 80)}` : ""}`, link: lienBilanKpi(x.periode) });
  revalider();
  return { ok: true, message: decision === "VALIDEE" ? "Déclaration validée." : "Déclaration refusée." };
}

// ── Importé ──────────────────────────────────────────────────────────────────────────────────

const normaliser = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();

/** « 2026-10 », « 10/2026 », « 2026-T4 », une date → la clé de période ; sinon null. */
function clePeriodeLue(v: unknown): string | null {
  if (v instanceof Date && !Number.isNaN(v.getTime())) return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}`;
  const s = String(v ?? "").trim().toUpperCase();
  if (fenetre(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) return fenetre(`${m[2]}-${m[1]!.padStart(2, "0")}`) ? `${m[2]}-${m[1]!.padStart(2, "0")}` : null;
  return null;
}

/** IMPORTER les valeurs d'un KPI importé : une ligne par personne et par période (colonnes choisies une fois). */
export async function importerKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits, equipe } = await faitsKpi(user);
  const definitionId = fdStr(formData, "definitionId");
  const d = definitionId ? await definitionParId(definitionId) : null;
  if (!d || d.def.nature !== "IMPORTE" || d.statut !== "ACTIF") return { ok: false, error: "KPI importé introuvable." };
  if (!faits.superAdmin && !peutModifierDefinition(faits, d)) return { ok: false, error: "Seul l'auteur du KPI (ou le Super Admin) importe ses valeurs." };
  const fichier = formData.get("fichier");
  if (!(fichier instanceof File) || fichier.size === 0) return { ok: false, error: "Choisissez un fichier (Excel ou CSV)." };
  if (fichier.size > 10 * 1024 * 1024) return { ok: false, error: "Fichier trop lourd (10 Mo au plus)." };
  const colPersonne = fdStr(formData, "colonnePersonne") ?? "personne";
  const colPeriode = fdStr(formData, "colonnePeriode") ?? "periode";
  const colValeur = fdStr(formData, "colonneValeur") ?? "valeur";
  const bytes = Buffer.from(await fichier.arrayBuffer());
  let lignes: Record<string, unknown>[];
  try {
    const wb = XLSX.read(bytes, { type: "buffer", cellDates: true });
    const feuille = wb.Sheets[wb.SheetNames[0]!];
    lignes = feuille ? XLSX.utils.sheet_to_json<Record<string, unknown>>(feuille, { defval: null }) : [];
  } catch {
    return { ok: false, error: "Le fichier ne se lit pas (Excel ou CSV attendu)." };
  }
  if (lignes.length === 0) return { ok: false, error: "Le fichier est vide." };
  const col = (l: Record<string, unknown>, nom: string) => { const k = Object.keys(l).find((x) => normaliser(x) === normaliser(nom)); return k ? l[k] : undefined; };
  // Les personnes reconnues : mon équipe (ou tout le monde pour le Super Admin), par e-mail ou par nom exact.
  const candidats = faits.superAdmin
    ? await prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, email: true } })
    : await prisma.user.findMany({ where: { id: { in: equipe.map((e) => e.userId) } }, select: { id: true, name: true, email: true } });
  const parCle = new Map<string, string>();
  for (const c of candidats) { parCle.set(normaliser(c.email), c.id); parCle.set(normaliser(c.name), c.id); }
  const rejets: string[] = [];
  const valeurs: { userId: string; periode: string; valeur: number }[] = [];
  lignes.slice(0, 5000).forEach((l, i) => {
    const qui = parCle.get(normaliser(String(col(l, colPersonne) ?? "")));
    const periode = clePeriodeLue(col(l, colPeriode));
    const brut = col(l, colValeur);
    const valeur = typeof brut === "number" ? brut : Number(String(brut ?? "").replace(/\s|%/g, "").replace(",", "."));
    if (!qui) rejets.push(`ligne ${i + 2} : personne non reconnue`);
    else if (!periode) rejets.push(`ligne ${i + 2} : période illisible`);
    else if (!Number.isFinite(valeur)) rejets.push(`ligne ${i + 2} : valeur illisible`);
    else valeurs.push({ userId: qui, periode, valeur });
  });
  if (valeurs.length === 0) return { ok: false, error: `Aucune ligne retenue (${rejets.slice(0, 3).join(" ; ")}). Vérifiez les noms de colonnes : « ${colPersonne} », « ${colPeriode} », « ${colValeur} ».` };
  const { blobId } = await putBlob(bytes);
  const imp = await prisma.kpiImport.create({
    data: { famille: d.famille, definitionId: d.id, nomFichier: fichier.name.slice(0, 200), blobId, colonnePersonne: colPersonne, colonnePeriode: colPeriode, colonneValeur: colValeur, lignes: valeurs.length, rejets: rejets.slice(0, 200), importeParId: user.id },
  });
  for (const v of valeurs) {
    await prisma.kpiValue.upsert({
      where: { definitionId_userId_periode: { definitionId: d.id, userId: v.userId, periode: v.periode } },
      create: { definitionId: d.id, userId: v.userId, periode: v.periode, valeur: v.valeur, importId: imp.id, calculeLe: new Date() },
      update: { valeur: v.valeur, importId: imp.id, sourceManquante: null, calculeLe: new Date() },
    });
  }
  await recordAudit({ actorId: user.id, action: "UPLOAD", module: MODULE, entityId: imp.id, summary: `Import « ${d.def.nom} » : ${valeurs.length} ligne(s), ${rejets.length} écartée(s)` });
  revalider();
  return { ok: true, message: `${valeurs.length} valeur(s) importée(s)${rejets.length ? `, ${rejets.length} ligne(s) écartée(s)` : ""}.` };
}

// ── La revue ─────────────────────────────────────────────────────────────────────────────────

/** (d) Le brouillon du commentaire par Luna (repli : écrit depuis les chiffres). Le manager le relit. */
export async function commentaireLunaKpi(formData: FormData): Promise<ActionResult & { texte?: string }> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const cibleUserId = fdStr(formData, "userId");
  const periode = fdStr(formData, "periode");
  if (!cibleUserId || !periode || !peutGererPersonne(faits, cibleUserId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  const b = await chargerBilanKpi(user, cibleUserId, periode);
  if (!b) return { ok: false, error: "Bilan introuvable." };
  if (b.figee) return { ok: false, error: "La revue est signée." };
  const r = await redigerCommentaire(b.nom.split(" ")[0] ?? b.nom, b.periode.libelle, kpisPourCommentaire(b), user.id);
  await prisma.kpiReview.upsert({
    where: { userId_periode: { userId: cibleUserId, periode: b.periode.cle } },
    create: { userId: cibleUserId, periode: b.periode.cle, frequence: fenetre(b.periode.cle)!.frequence, commentaireLuna: r.texte },
    update: { commentaireLuna: r.texte },
  });
  revalider();
  return { ok: true, texte: r.texte, message: r.parLuna ? "Brouillon rédigé par Luna — relisez-le." : "Brouillon écrit depuis les chiffres (Luna indisponible)." };
}

/** SIGNER LA REVUE : le score et chaque ligne (version, valeur, note, poids) sont FIGÉS. */
export async function signerRevueKpi(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const { faits } = await faitsKpi(user);
  const cibleUserId = fdStr(formData, "userId");
  const periode = fdStr(formData, "periode");
  const commentaire = fdStr(formData, "commentaire")?.slice(0, 3000) ?? null;
  if (!cibleUserId || !periode || !fenetre(periode)) return { ok: false, error: "Période invalide." };
  if (!peutGererPersonne(faits, cibleUserId)) return { ok: false, error: "Cette personne n'est pas dans votre équipe." };
  const b = await chargerBilanKpi(user, cibleUserId, periode);
  if (!b) return { ok: false, error: "Bilan introuvable." };
  if (b.figee) return { ok: false, error: "Cette revue est déjà signée." };
  if (b.kpis.length === 0) return { ok: false, error: "Aucun KPI ne s'applique à cette personne." };
  const lignes = lignesAFiger(b);
  await prisma.kpiReview.upsert({
    where: { userId_periode: { userId: cibleUserId, periode: b.periode.cle } },
    create: {
      userId: cibleUserId, periode: b.periode.cle, frequence: fenetre(b.periode.cle)!.frequence, score: b.score, kpiSansDonnee: b.sansDonnee,
      detail: lignes as unknown as object, statut: "SIGNEE", signeeParId: user.id, signeeLe: new Date(), commentaireManager: commentaire,
    },
    update: { score: b.score, kpiSansDonnee: b.sansDonnee, detail: lignes as unknown as object, statut: "SIGNEE", signeeParId: user.id, signeeLe: new Date(), commentaireManager: commentaire },
  });
  await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE, entityId: cibleUserId, summary: `Revue ${b.periode.libelle} de ${b.nom} signée — score ${b.score ?? "—"}` });
  await notifyUser({ userId: cibleUserId, type: "GENERIC", title: `Votre revue de ${b.periode.libelle} est signée`, body: `Score ${b.score ?? "—"}${commentaire ? ` — ${commentaire.slice(0, 80)}` : ""}`, link: lienBilanKpi(b.periode.cle) });
  revalider();
  return { ok: true, message: "Revue signée." };
}
