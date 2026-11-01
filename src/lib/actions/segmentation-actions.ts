"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/session";
import { type SessionUser } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { lireRegles, STATUTS, SEGMENTS, LETTRES_FORCABLES, type Statut } from "@/lib/segmentation/regles";
import { impactDesRegles, segmenterPraticien, SOURCE_EFFACEMENT } from "@/lib/segmentation/moteur";
import { apercuImport, appliquerImport, chargerFaits, chargerStrategie, chargerSecteurs, type ApercuImport, type BilanImport } from "@/lib/segmentation/service";
import { apercuImportDirection, appliquerImportDirection, type ApercuDirection, type BilanDirection } from "@/lib/segmentation/import-direction";
import { ouvrirCycle, cloreCycle } from "@/lib/segmentation/cycle-service";
import { droitsSegmentation, porteeSegmentation, type DroitsSegmentation } from "@/lib/segmentation/droits";

/**
 * SEGMENTATION STUDIO — les gestes. Chaque écriture vérifie le DROIT (module SEGMENTATION) et la PORTÉE
 * (un KAM ne touche que son panel), et s'inscrit au journal d'audit. Les règles ne se modifient jamais :
 * on PUBLIE la version suivante, après l'aperçu de son impact.
 */

type R<T = object> = ({ ok: true } & T) | { ok: false; error: string };
const MODULE = "SEGMENTATION";
const CHEMIN = "/segmentation";

function porteeDe(user: SessionUser): Prisma.MedicalDoctorWhereInput {
  return porteeSegmentation(user);
}

async function dansLaPortee(user: SessionUser, doctorId: string): Promise<boolean> {
  const n = await prisma.medicalDoctor.count({ where: { AND: [{ id: doctorId }, porteeDe(user)] } });
  return n > 0;
}

/**
 * LE DROIT DU GESTE (Direction, 07/10) — lu par `droitsSegmentation` : Voir, Modifier (Q1, Q2, statut), Créer (panel),
 * Valider (règles, import, stratégie), et FORCER une lettre, qui n'appartient qu'à qui le Super Admin l'a accordé
 * (SEGMENTATION_POTENTIEL) — et qui ouvre alors tous les autres gestes.
 */
const GESTE: Record<"VIEW" | "UPDATE" | "CREATE" | "VALIDATE" | "FORCER", keyof DroitsSegmentation> = {
  VIEW: "voir", UPDATE: "saisir", CREATE: "panel", VALIDATE: "valider", FORCER: "forcer",
};

async function exiger(action: "VIEW" | "UPDATE" | "CREATE" | "VALIDATE" | "FORCER") {
  const user = await requireUser();
  if (!droitsSegmentation(user)[GESTE[action]]) {
    return { user, refus: action === "FORCER" ? "Forcer le potentiel demande l'autorisation du Super Admin (Administration › Accès)." : "Action non autorisée sur la segmentation (Administration › Accès)." };
  }
  return { user, refus: null as string | null };
}

// ───────────────────────────── Stratégie & produits classés ─────────────────────────────

/** Les produits classés doivent être au CATALOGUE de la BU (Force de vente) — la phrase du refus, ou `null`. */
async function produitsHorsCatalogue(businessUnitId: string, productIds: string[]): Promise<string | null> {
  const catalogue = new Set((await prisma.promoProduct.findMany({ where: { businessUnitId, isActive: true, productId: { in: productIds } }, select: { productId: true } })).map((p) => p.productId));
  const hors = productIds.filter((id) => !catalogue.has(id));
  return hors.length ? "Un produit classé doit être au catalogue de la BU : ajoutez-le dans Force de vente › Business Units, puis classez-le ici." : null;
}

export async function creerStrategie(input: { businessUnitId: string; nom: string; productIds: string[] }): Promise<R<{ id: string }>> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const nom = input.nom.replace(/\s+/g, " ").trim();
  const ids = [...new Set(input.productIds.filter(Boolean))];
  if (!nom) return { ok: false, error: "Nommez la stratégie." };
  if (ids.length === 0) return { ok: false, error: "Classez au moins un produit." };
  if (ids.length > 3) return { ok: false, error: "Une stratégie classe au plus trois produits à la fois (le catalogue de la BU peut en compter davantage)." };
  const bu = await prisma.businessUnit.findUnique({ where: { id: input.businessUnitId }, select: { id: true, name: true } });
  if (!bu) return { ok: false, error: "Business Unit introuvable." };
  // UNE PORTE DE VÉRITÉ (Direction, 06/10) : une seule stratégie active par BU, et des produits de SON catalogue.
  const existante = await prisma.segmentationStrategie.findFirst({ where: { businessUnitId: bu.id, statut: "ACTIVE" }, select: { id: true } });
  if (existante) return { ok: false, error: `La segmentation de la BU ${bu.name} est déjà active : changez son classement dans l'onglet Règles.` };
  const horsCatalogue = await produitsHorsCatalogue(bu.id, ids);
  if (horsCatalogue) return { ok: false, error: horsCatalogue };
  const s = await prisma.segmentationStrategie.create({
    data: { businessUnitId: bu.id, nom, createdById: user.id, produits: { create: ids.map((productId, i) => ({ productId, rang: i + 1, createdById: user.id })) } },
    select: { id: true },
  });
  await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, summary: `Stratégie de segmentation « ${nom} » créée pour la BU ${bu.name} (${ids.length} produit(s) classé(s)).` });
  revalidatePath(CHEMIN);
  return { ok: true, id: s.id };
}

/** Change le CLASSEMENT (≤ 3) : les lignes en vigueur se ferment, les nouvelles s'ouvrent — l'historique reste. */
export async function classerProduits(strategieId: string, productIds: string[]): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0 || ids.length > 3) return { ok: false, error: "Classez entre un et trois produits." };
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  if (s.produits.map((p) => p.productId).join() === ids.join()) return { ok: true };
  const horsCatalogue = await produitsHorsCatalogue(s.businessUnit.id, ids);
  if (horsCatalogue) return { ok: false, error: horsCatalogue };
  const maintenant = new Date();
  await prisma.$transaction([
    prisma.segmentationStrategieProduit.updateMany({ where: { strategieId, jusqua: null }, data: { jusqua: maintenant } }),
    prisma.segmentationStrategieProduit.createMany({ data: ids.map((productId, i) => ({ strategieId, productId, rang: i + 1, depuis: maintenant, createdById: user.id })) }),
  ]);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "classement", oldValue: s.produits.map((p) => p.nom).join(" > "), newValue: ids.join(" > "), summary: `Classement des produits de « ${s.nom} » modifié.` });
  revalidatePath(CHEMIN);
  return { ok: true };
}

// ───────────────────────────── Règles versionnées ─────────────────────────────

const jsonOuNul = (s: string): unknown => { try { return JSON.parse(s); } catch { return null; } };

export interface ApercuRegles { praticiens: number; changements: { nom: string; produit: string | null; avant: string; apres: string }[]; total: number }

/** L'IMPACT d'un contenu de règles comparé à la version en vigueur — rien n'est écrit. */
export async function apercuRegles(strategieId: string, contenuJson: string): Promise<R<{ apercu: ApercuRegles }>> {
  const { refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const lu = lireRegles(jsonOuNul(contenuJson));
  if (!lu.ok) return { ok: false, error: lu.erreurs.join(" ") };
  const { faits, lignes } = await chargerFaits(strategieId);
  const avant = s.regle?.regles ?? lu.regles;
  const { changements, praticiens } = impactDesRegles(faits, avant, lu.regles, new Date(), s.contexte);
  const nomDe = new Map(lignes.map((l) => [l.doctorId, l.nom]));
  const produitDe = new Map(s.produits.map((p) => [p.productId, p.nom]));
  return {
    ok: true,
    apercu: {
      praticiens, total: changements.length,
      changements: changements.slice(0, 200).map((c) => ({ nom: nomDe.get(c.doctorId) ?? c.doctorId, produit: c.productId ? produitDe.get(c.productId) ?? c.productId : null, avant: c.avant, apres: c.apres })),
    },
  };
}

/** PUBLIE la version suivante. La précédente reste intacte — les cycles passés gardent leurs règles. */
export async function publierRegles(strategieId: string, contenuJson: string, note: string): Promise<R<{ version: number }>> {
  return gesteReversible(await requireUser(), { capaciteId: "segmentation-actions:publierRegles", libelle: "Règles de segmentation publiées" }, async () => {
    const { user, refus } = await exiger("VALIDATE");
    if (refus) return { ok: false, error: refus };
    const s = await chargerStrategie(strategieId);
    if (!s) return { ok: false, error: "Stratégie introuvable." };
    const lu = lireRegles(jsonOuNul(contenuJson));
    if (!lu.ok) return { ok: false, error: lu.erreurs.join(" ") };
    const classes = new Set(s.produits.map((p) => p.productId));
    if (lu.regles.produits.some((p) => !classes.has(p.productId))) return { ok: false, error: "Les règles visent un produit qui n'est pas classé dans la stratégie." };
    const version = (s.regle?.version ?? 0) + 1;
    await prisma.segmentationRegle.create({ data: { strategieId, version, contenu: lu.regles as unknown as Prisma.InputJsonValue, note: note.trim() || null, publieeParId: user.id } });
    await recordAudit({ actorId: user.id, action: "VALIDATE", module: MODULE, field: "regles", oldValue: s.regle ? `v${s.regle.version}` : null, newValue: `v${version}`, summary: `Règles de segmentation « ${s.nom} » publiées en version ${version}.${note.trim() ? ` ${note.trim()}` : ""}` });
    revalidatePath(CHEMIN);
    return { ok: true, version };
  });
}

// ───────────────────────────── Import d'un classeur ─────────────────────────────

async function fichierDe(fd: FormData): Promise<{ buffer: Buffer; nom: string } | null> {
  const f = fd.get("fichier");
  if (!f || typeof f === "string") return null;
  return { buffer: Buffer.from(await f.arrayBuffer()), nom: f.name || "classeur.xlsx" };
}

export async function apercuImportSegmentation(fd: FormData): Promise<ApercuImport | { ok: false; error: string }> {
  const { refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const f = await fichierDe(fd);
  if (!f) return { ok: false, error: "Choisissez un fichier Excel." };
  try {
    return await apercuImport(String(fd.get("strategieId") ?? ""), f.buffer);
  } catch (e) {
    return { ok: false, error: `Lecture du classeur impossible : ${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function importerSegmentation(fd: FormData): Promise<BilanImport | { ok: false; error: string }> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const f = await fichierDe(fd);
  if (!f) return { ok: false, error: "Choisissez un fichier Excel." };
  const strategieId = String(fd.get("strategieId") ?? "");
  let reglesContenu: unknown;
  const brut = fd.get("regles");
  if (typeof brut === "string" && brut.trim()) { try { reglesContenu = JSON.parse(brut); } catch { return { ok: false, error: "Règles illisibles." }; } }
  const r = await appliquerImport(user.id, strategieId, f.buffer, f.nom, { reglesContenu });
  if (r.ok) {
    await recordAudit({ actorId: user.id, action: "IMPORT", module: MODULE, entityId: r.importId, summary: `Import de segmentation « ${f.nom} » : ${r.crees} praticien(s) créé(s), ${r.misAJour} complété(s), ${r.observations} observation(s)${r.reglePubliee ? `, règles v${r.reglePubliee} publiées` : ""}.` });
    revalidatePath(CHEMIN);
  }
  return r;
}

// ───────────────────────────── Le classeur de la Direction, en une fois ─────────────────────────────

/**
 * L'APERÇU de l'import « en une fois » (Direction, 08/10) : BU reconnue (ou choisie), stratégie et produit, praticiens
 * retrouvés / créés dans l'annuaire, établissements et spécialités reliés, lettres, écarts gardés, règles lues. Rien
 * n'est écrit.
 */
export async function apercuImportClasseurDirection(fd: FormData): Promise<ApercuDirection | { ok: false; error: string }> {
  const { refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const f = await fichierDe(fd);
  if (!f) return { ok: false, error: "Choisissez le fichier Excel." };
  try {
    return await apercuImportDirection(f.buffer, f.nom, String(fd.get("businessUnitId") ?? "") || null);
  } catch (e) {
    return { ok: false, error: `Lecture du classeur impossible : ${e instanceof Error ? e.message : String(e)}` };
  }
}

/**
 * L'IMPORT « en une fois » : stratégie, produit classé, annuaire, référentiels, fiches, réponses, règles — et les
 * lettres du fichier gardées là où le calcul diffère, ce qui revient à FORCER une lettre : réservé à qui peut forcer
 * (Super Admin, ou droit accordé) dès que le fichier en porte.
 */
export async function importerClasseurDirection(fd: FormData): Promise<BilanDirection | { ok: false; error: string }> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const f = await fichierDe(fd);
  if (!f) return { ok: false, error: "Choisissez le fichier Excel." };
  const r = await appliquerImportDirection(user.id, f.buffer, f.nom, String(fd.get("businessUnitId") ?? "") || null, { peutForcer: droitsSegmentation(user).forcer });
  if (r.ok && !r.rien) {
    await recordAudit({
      actorId: user.id, action: "IMPORT", module: MODULE, entityId: r.strategieId,
      summary: `Import du classeur de segmentation « ${f.nom} » : ${r.crees} praticien(s) créé(s) dans l'annuaire ${r.annuaire}, ${r.completes} complété(s), ${r.fiches} fiche(s), ${r.observations} réponse(s), ${r.lettresGardees} lettre(s) du fichier gardée(s)${r.reglesVersion ? `, règles v${r.reglesVersion} publiées` : ""}.`,
    });
    revalidatePath(CHEMIN);
  }
  return r;
}

// ───────────────────────────── Terrain : potentiel, statut, panel ─────────────────────────────

const nombreOuNul = (v: string | null | undefined): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(",", "."));
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

/** Le KAM renseigne un FAIT (« 27 patients / semaine », « 3 sur 10 ») — AMD calcule la conséquence. */
export async function enregistrerPotentiel(input: { strategieId: string; doctorId: string; productId: string | null; potentiel: string; sur10: string; commentaire?: string; effacer?: "q1" | "q2" }): Promise<R> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  if (!(await dansLaPortee(user, input.doctorId))) return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  // EFFACER une réponse (Direction, 08/10) : une observation SANS valeur, dont la source dit le champ vidé — la lettre
  // retombe en NA, et l'historique garde la réponse d'avant.
  if (input.effacer === "q1" || input.effacer === "q2") {
    const s = await chargerStrategie(input.strategieId);
    if (!s) return { ok: false, error: "Stratégie introuvable." };
    const productId = s.produits[0]?.productId ?? null;
    const champ = input.effacer === "q1" ? "potentiel" : "prescriptionsSur10";
    if (champ === "prescriptionsSur10" && !productId) return { ok: false, error: "Classez d'abord un produit dans la stratégie." };
    await prisma.hcpObservation.create({ data: { doctorId: input.doctorId, strategieId: s.id, productId, source: SOURCE_EFFACEMENT[champ], auteurId: user.id } });
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "potentiel", newValue: `${input.effacer.toUpperCase()} effacée`, summary: "Réponse terrain effacée (NA) — l'historique la garde." });
    revalidatePath(CHEMIN);
    return { ok: true };
  }
  const potentiel = nombreOuNul(input.potentiel), sur10 = nombreOuNul(input.sur10);
  if (Number.isNaN(potentiel) || Number.isNaN(sur10)) return { ok: false, error: "Valeurs numériques positives attendues." };
  if (sur10 !== null && sur10 > 10) return { ok: false, error: "« Sur 10 patients » : une valeur entre 0 et 10." };
  if (potentiel === null && sur10 === null) return { ok: false, error: "Renseignez au moins une valeur." };
  const s = await chargerStrategie(input.strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const productId = input.productId && s.produits.some((p) => p.productId === input.productId) ? input.productId : s.produits[0]?.productId ?? null;
  await prisma.hcpObservation.create({
    data: {
      doctorId: input.doctorId, strategieId: s.id, productId, potentiel, prescriptionsSur10: sur10,
      metrique: s.regle?.regles?.produits.find((p) => p.productId === productId)?.metrique ?? null,
      source: "TERRAIN", auteurId: user.id, commentaire: input.commentaire?.trim() || null,
    },
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "potentiel", newValue: `${potentiel ?? "—"} ; ${sur10 ?? "—"}/10`, summary: "Potentiel terrain renseigné (historisé)." });
  revalidatePath(CHEMIN);
  return { ok: true };
}

export async function changerStatut(input: { strategieId: string; doctorId: string; statut: string | null; zone?: string | null }): Promise<R> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  if (!(await dansLaPortee(user, input.doctorId))) return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  const statut = input.statut && (STATUTS as readonly string[]).includes(input.statut) ? (input.statut as Statut) : null;
  if (input.statut && !statut) return { ok: false, error: "Statut inconnu." };
  const avant = await prisma.segmentationFiche.findUnique({ where: { strategieId_doctorId: { strategieId: input.strategieId, doctorId: input.doctorId } }, select: { statut: true, zone: true } });
  if (!avant) return { ok: false, error: "Ce praticien n'est pas dans le panel de la stratégie." };
  const zone = input.zone === undefined ? avant.zone : input.zone?.trim() || null;
  await prisma.segmentationFiche.update({ where: { strategieId_doctorId: { strategieId: input.strategieId, doctorId: input.doctorId } }, data: { statut, zone, updatedById: user.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "statut", oldValue: `${avant.statut ?? "—"} · ${avant.zone ?? "—"}`, newValue: `${statut ?? "—"} · ${zone ?? "—"}`, summary: "Statut stratégique / zone modifiés." });
  revalidatePath(CHEMIN);
  return { ok: true };
}

export async function ajouterAuPanel(strategieId: string, doctorIds: string[], statut: string | null): Promise<R<{ ajoutes: number }>> {
  const { user, refus } = await exiger("CREATE");
  if (refus) return { ok: false, error: refus };
  const s = await prisma.segmentationStrategie.findUnique({ where: { id: strategieId }, select: { id: true } });
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const st = statut && (STATUTS as readonly string[]).includes(statut) ? statut : null;
  const ids = (await prisma.medicalDoctor.findMany({ where: { AND: [{ id: { in: doctorIds } }, { archivedAt: null }, porteeDe(user)] }, select: { id: true } })).map((d) => d.id);
  let ajoutes = 0;
  for (const doctorId of ids) {
    await prisma.segmentationFiche.upsert({ where: { strategieId_doctorId: { strategieId, doctorId } }, update: { retireeLe: null, updatedById: user.id }, create: { strategieId, doctorId, statut: st, source: "MANUEL", createdById: user.id } });
    ajoutes++;
  }
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, summary: `${ajoutes} praticien(s) ajouté(s) au panel de segmentation.` });
  revalidatePath(CHEMIN);
  return { ok: true, ajoutes };
}

export async function retirerDuPanel(strategieId: string, doctorId: string): Promise<R> {
  const { user, refus } = await exiger("CREATE");
  if (refus) return { ok: false, error: refus };
  if (!(await dansLaPortee(user, doctorId))) return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  await prisma.segmentationFiche.updateMany({ where: { strategieId, doctorId, retireeLe: null }, data: { retireeLe: new Date(), updatedById: user.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: doctorId, summary: "Retiré du panel de segmentation (fiche gardée pour l'historique)." });
  revalidatePath(CHEMIN);
  return { ok: true };
}

// ───────────────────────────── Dérogations ─────────────────────────────

/** Pose une DÉROGATION motivée : la valeur calculée du moment est gardée à côté de la valeur posée. */
export async function poserDerogation(input: { strategieId: string; doctorId: string; nature: "CIBLAGE" | "SEGMENT"; productId?: string | null; valeur: string; motif: string; expireLe?: string | null }): Promise<R> {
  const { user, refus } = await exiger("FORCER");
  if (refus) return { ok: false, error: refus };
  if (!(await dansLaPortee(user, input.doctorId))) return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  const motif = input.motif.replace(/\s+/g, " ").trim();
  if (motif.length < 3) return { ok: false, error: "Le motif est obligatoire." };
  if (input.nature === "CIBLAGE" && !["CIBLE", "NON_CIBLE"].includes(input.valeur)) return { ok: false, error: "Valeur de ciblage inconnue." };
  if (input.nature === "SEGMENT" && (!(SEGMENTS as readonly string[]).includes(input.valeur) || !input.productId)) return { ok: false, error: "Segment A, B, C ou D, pour un produit classé." };
  const s = await chargerStrategie(input.strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  if (input.productId && !s.produits.some((p) => p.productId === input.productId)) return { ok: false, error: "Produit non classé dans la stratégie." };
  const expireLe = input.expireLe ? new Date(input.expireLe) : null;
  if (expireLe && Number.isNaN(expireLe.getTime())) return { ok: false, error: "Date d'échéance illisible." };
  // La valeur CALCULÉE au moment de la décision — ce que la dérogation remplace, gardé lisible.
  let valeurCalculee: string | null = null;
  if (s.regle?.regles) {
    const { faits } = await chargerFaits(s.id, { id: input.doctorId });
    const f = faits[0];
    if (f) {
      const r = segmenterPraticien({ ...f, derogations: [] }, s.regle.regles, new Date(), s.contexte);
      valeurCalculee = input.nature === "CIBLAGE" ? (r.cible ? "CIBLE" : "NON_CIBLE") : r.produits.find((p) => p.productId === input.productId)?.calcule ?? null;
    }
  }
  await prisma.$transaction([
    // Une seule dérogation en vigueur par (praticien, nature, produit) : la précédente est levée, pas effacée.
    prisma.segmentationDerogation.updateMany({ where: { strategieId: s.id, doctorId: input.doctorId, nature: input.nature, productId: input.productId ?? null, leveeLe: null }, data: { leveeLe: new Date(), leveeParId: user.id } }),
    prisma.segmentationDerogation.create({ data: { strategieId: s.id, doctorId: input.doctorId, nature: input.nature, productId: input.productId ?? null, valeur: input.valeur, valeurCalculee, motif, expireLe, auteurId: user.id } }),
  ]);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: input.nature === "CIBLAGE" ? "ciblage" : "segment", oldValue: valeurCalculee, newValue: input.valeur, summary: `Dérogation : ${motif}` });
  revalidatePath(CHEMIN);
  return { ok: true };
}

export async function leverDerogation(id: string): Promise<R> {
  const { user, refus } = await exiger("FORCER");
  if (refus) return { ok: false, error: refus };
  const d = await prisma.segmentationDerogation.findUnique({ where: { id }, select: { doctorId: true, leveeLe: true, valeur: true } });
  if (!d || d.leveeLe) return { ok: false, error: "Dérogation introuvable ou déjà levée." };
  if (!(await dansLaPortee(user, d.doctorId))) return { ok: false, error: "Ce praticien n'est pas dans votre panel." };
  await prisma.segmentationDerogation.update({ where: { id }, data: { leveeLe: new Date(), leveeParId: user.id } });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: d.doctorId, summary: `Dérogation levée (${d.valeur}) : le calcul s'applique de nouveau.` });
  revalidatePath(CHEMIN);
  return { ok: true };
}

// ───────────────────────────── La lettre forcée, le secteur, l'ajout au panel ─────────────────────────────

/**
 * FORCER LA LETTRE d'un praticien (produit #1) — H, A, B, C, D ou « non ciblé », motif obligatoire (Direction, 07/10).
 * Réservé à qui le Super Admin l'a accordé. La décision précédente est LEVÉE (jamais effacée) ; la lettre calculée du
 * moment est gardée à côté de la forcée, et le tout entre au journal.
 */
export async function forcerLettre(input: { strategieId: string; doctorId: string; lettre: string; motif: string }): Promise<R> {
  const { user, refus } = await exiger("FORCER");
  if (refus) return { ok: false, error: refus };
  const lettre = (LETTRES_FORCABLES as readonly string[]).includes(input.lettre) ? input.lettre : null;
  if (!lettre) return { ok: false, error: "Lettre inconnue (H, A, B, C, D ou non ciblé)." };
  const motif = input.motif.replace(/\s+/g, " ").trim();
  if (motif.length < 3) return { ok: false, error: "Le motif est obligatoire." };
  const s = await chargerStrategie(input.strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const p1 = s.produits[0]?.productId;
  if (!p1) return { ok: false, error: "Classez d'abord un produit dans la stratégie." };
  const { faits } = await chargerFaits(s.id, { id: input.doctorId });
  const f = faits[0];
  if (!f) return { ok: false, error: "Ce praticien n'est pas dans le panel de la stratégie." };
  const calculee = s.regle?.regles ? segmenterPraticien({ ...f, derogations: [] }, s.regle.regles, new Date(), s.contexte).lettreCalculee : null;
  const maintenant = new Date();
  await prisma.$transaction([
    prisma.segmentationDerogation.updateMany({
      where: { strategieId: s.id, doctorId: input.doctorId, leveeLe: null, OR: [{ nature: "CIBLAGE" }, { nature: "SEGMENT", productId: p1 }] },
      data: { leveeLe: maintenant, leveeParId: user.id },
    }),
    prisma.segmentationDerogation.create({
      data: lettre === "NC"
        ? { strategieId: s.id, doctorId: input.doctorId, nature: "CIBLAGE", productId: null, valeur: "NON_CIBLE", valeurCalculee: calculee, motif, auteurId: user.id }
        : { strategieId: s.id, doctorId: input.doctorId, nature: "SEGMENT", productId: p1, valeur: lettre, valeurCalculee: calculee, motif, auteurId: user.id },
    }),
  ]);
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "potentiel-force", oldValue: calculee, newValue: lettre, summary: `Potentiel forcé à ${lettre === "NC" ? "non ciblé" : lettre} (calculé : ${calculee ?? "—"}) — ${motif}` });
  revalidatePath(CHEMIN);
  return { ok: true };
}

/** RENDRE LA LETTRE CALCULÉE : la décision manuelle en vigueur est levée (elle reste dans l'historique). */
export async function rendreLettreCalculee(input: { strategieId: string; doctorId: string }): Promise<R> {
  const { user, refus } = await exiger("FORCER");
  if (refus) return { ok: false, error: refus };
  const s = await chargerStrategie(input.strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const p1 = s.produits[0]?.productId ?? null;
  const n = await prisma.segmentationDerogation.updateMany({
    where: { strategieId: s.id, doctorId: input.doctorId, leveeLe: null, OR: [{ nature: "CIBLAGE" }, { nature: "SEGMENT", productId: p1 }] },
    data: { leveeLe: new Date(), leveeParId: user.id },
  });
  if (n.count === 0) return { ok: false, error: "Aucune lettre forcée sur ce praticien." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "potentiel-force", newValue: "calculé", summary: "Potentiel forcé levé : la lettre calculée s'applique de nouveau." });
  revalidatePath(CHEMIN);
  return { ok: true };
}

/** RANGER UNE FICHE DANS UN SECTEUR DE LA BU — ou la rendre au calcul (secteur de son établissement) avec `null`. */
export async function changerSecteur(input: { strategieId: string; doctorId: string; secteurId: string | null }): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const s = await prisma.segmentationStrategie.findUnique({ where: { id: input.strategieId }, select: { id: true, businessUnitId: true } });
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const secteurId = input.secteurId || null;
  if (secteurId && !(await chargerSecteurs(s.businessUnitId)).some((x) => x.id === secteurId)) return { ok: false, error: "Ce secteur n'appartient pas à la BU." };
  const r = await prisma.segmentationFiche.updateMany({ where: { strategieId: s.id, doctorId: input.doctorId }, data: { secteurId, updatedById: user.id } });
  if (r.count === 0) return { ok: false, error: "Ce praticien n'est pas dans le panel de la stratégie." };
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityType: "DOCTOR", entityId: input.doctorId, field: "secteur", newValue: secteurId ?? "calculé", summary: secteurId ? "Fiche de segmentation rangée à la main dans un secteur." : "Secteur de la fiche rendu au calcul (établissement)." });
  revalidatePath(CHEMIN);
  return { ok: true };
}

export interface PraticienTrouve { id: string; nom: string; etablissement: string | null; specialite: string | null }

/** Les praticiens de l'annuaire (dans sa portée) qui ne sont PAS encore au panel — pour les y ajouter. */
export async function chercherPraticiensHorsPanel(input: { strategieId: string; q: string }): Promise<R<{ praticiens: PraticienTrouve[] }>> {
  const { user, refus } = await exiger("CREATE");
  if (refus) return { ok: false, error: refus };
  const q = input.q.replace(/\s+/g, " ").trim();
  if (q.length < 2) return { ok: true, praticiens: [] };
  const docs = await prisma.medicalDoctor.findMany({
    where: {
      AND: [
        porteeDe(user), { archivedAt: null },
        { segmentationFiches: { none: { strategieId: input.strategieId, retireeLe: null } } },
        { OR: [{ name: { contains: q, mode: "insensitive" } }, { institution: { contains: q, mode: "insensitive" } }, { institutionRef: { name: { contains: q, mode: "insensitive" } } }] },
      ],
    },
    orderBy: { name: "asc" }, take: 20,
    select: { id: true, name: true, institution: true, institutionRef: { select: { name: true } }, specialty: true, specialtyRef: { select: { name: true } } },
  });
  return { ok: true, praticiens: docs.map((d) => ({ id: d.id, nom: d.name, etablissement: d.institutionRef?.name ?? d.institution ?? null, specialite: d.specialtyRef?.name ?? d.specialty ?? null })) };
}

// ───────────────────────────── Spécialités visées par produit ─────────────────────────────

/**
 * LES SPÉCIALITÉS QU'UN PRODUIT VISE DANS LA BU (cahier des charges §6) — une partie de celles de la BU, jamais
 * au-delà. Porté par `PromoProduct` (le produit × BU qui existe déjà) ; créé s'il manque. Vide = toutes.
 */
export async function ciblerSpecialitesProduit(strategieId: string, productId: string, specialtyIds: string[]): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const s = await chargerStrategie(strategieId);
  if (!s) return { ok: false, error: "Stratégie introuvable." };
  const produit = s.produits.find((p) => p.productId === productId);
  if (!produit) return { ok: false, error: "Produit non classé dans la stratégie." };
  const ids = [...new Set(specialtyIds.filter(Boolean))];
  const deLaBu = new Set((await prisma.businessUnitSpecialty.findMany({ where: { businessUnitId: s.businessUnit.id }, select: { specialtyId: true } })).map((x) => x.specialtyId));
  const hors = ids.filter((i) => !deLaBu.has(i));
  if (hors.length) return { ok: false, error: "Un produit ne vise que des spécialités de sa BU : ajoutez-les d'abord à la BU (Force de vente › Business Units)." };
  await prisma.$transaction(async (tx) => {
    let promo = await tx.promoProduct.findFirst({ where: { businessUnitId: s.businessUnit.id, productId }, select: { id: true } });
    promo ??= await tx.promoProduct.create({ data: { name: produit.nom, businessUnitId: s.businessUnit.id, productId }, select: { id: true } });
    await tx.promoProductSpecialite.deleteMany({ where: { promoProductId: promo.id, specialtyId: { notIn: ids } } });
    if (ids.length) await tx.promoProductSpecialite.createMany({ data: ids.map((specialtyId) => ({ promoProductId: promo!.id, specialtyId, createdById: user.id })), skipDuplicates: true });
  });
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "specialites-produit", newValue: ids.join(","), summary: `Spécialités visées par ${produit.nom} dans la BU ${s.businessUnit.name} : ${ids.length ? `${ids.length} spécialité(s)` : "toutes celles de la BU"}.` });
  revalidatePath(CHEMIN);
  return { ok: true };
}
// ───────────────────────────── Cycles ─────────────────────────────

/** OUVRIR un cycle : il fige règles, contexte, résultats, couverture KAM et capacité (§50). */
export async function ouvrirCycleSegmentation(input: { strategieId: string; debut: string; duree: string; fin: string; libelle: string }): Promise<R<{ id: string }>> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const r = await ouvrirCycle(user.id, input.strategieId, { debut: input.debut, duree: input.duree, fin: input.fin || null, libelle: input.libelle });
  if (r.ok) {
    await recordAudit({ actorId: user.id, action: "CREATE", module: MODULE, entityId: r.id, summary: `Cycle de segmentation ouvert (${input.duree}, à partir du ${input.debut}) : règles et résultats figés.` });
    revalidatePath(CHEMIN);
  }
  return r;
}

/** CLORE un cycle : les visites réalisées sont figées ; rien ne le recalcule plus. */
export async function cloreCycleSegmentation(cycleId: string): Promise<R> {
  const { user, refus } = await exiger("VALIDATE");
  if (refus) return { ok: false, error: refus };
  const r = await cloreCycle(user.id, cycleId);
  if (r.ok) {
    await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: cycleId, summary: "Cycle de segmentation clos : visites réalisées figées." });
    revalidatePath(CHEMIN);
  }
  return r;
}