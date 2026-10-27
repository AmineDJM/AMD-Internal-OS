import { createHash } from "crypto";
import * as XLSX from "xlsx";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { analyserClasseur, cleBrute, type ChampConso, type Feuilles, type AnalyseFeuille } from "./lecture";
import { resolveur, cleDoublon, chevauche, type Memoire } from "./resolution";

/**
 * CONSUMPTION INTELLIGENCE — le côté BASE du pipeline :
 *   upload → analyse (feuilles, en-têtes, colonnes, format, périodes) → résolution (établissement, produit) →
 *   normalisation (unités) → validation → doublons (fichier déjà importé, lignes déjà importées, périodes qui se
 *   chevauchent) → REVUE humaine si besoin → VALIDATION (les lignes OK comptent, les correspondances s'apprennent).
 * Le fichier original est gardé ; chaque ligne garde sa feuille et sa ligne source.
 */

export function lireFeuilles(buffer: Buffer): Feuilles {
  const wb = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const out: Feuilles = {};
  for (const n of wb.SheetNames) out[n] = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[n], { header: 1, defval: null, blankrows: true, raw: true });
  return out;
}

async function chargerMemoire(): Promise<{ colonnes: Map<string, ChampConso>; resolution: Memoire }> {
  const rows = await prisma.consommationMemoire.findMany({ select: { nature: true, cle: true, valeur: true } });
  const colonnes = new Map<string, ChampConso>(), etablissements = new Map<string, string>(), produits = new Map<string, string>();
  for (const r of rows) {
    if (r.nature === "COLONNE") colonnes.set(r.cle, r.valeur as ChampConso);
    else if (r.nature === "ETABLISSEMENT") etablissements.set(r.cle, r.valeur);
    else if (r.nature === "PRODUIT") produits.set(r.cle, r.valeur);
  }
  return { colonnes, resolution: { etablissements, produits } };
}

async function chargerReferentiels() {
  const [etablissements, produits] = await Promise.all([
    prisma.medicalInstitution.findMany({ select: { id: true, name: true, isActive: true, wilaya: true } }),
    prisma.product.findMany({
      where: { isActive: true },
      select: { id: true, code: true, canonicalName: true, identityKey: true, dci: true, dosage: true, dosageUnit: true, form: true, packaging: true, aliases: { select: { label: true } } },
    }),
  ]);
  return { etablissements, produits: produits.map((p) => ({ ...p, aliases: p.aliases.map((a) => a.label) })) };
}

const d = (s: string | null | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);

export type ResultatAnalyse = { ok: true; importId: string; lignes: number; ok_: number; aRevoir: number; doublons: number } | { ok: false; error: string };

/** UPLOAD + ANALYSE : le fichier est lu, résolu, dédoublonné, et enregistré EN REVUE — rien ne compte encore. */
export async function importerConsommation(auteurId: string, buffer: Buffer, nomFichier: string): Promise<ResultatAnalyse> {
  const empreinte = createHash("sha256").update(buffer).digest("hex");
  const deja = await prisma.consommationImport.findUnique({ where: { empreinte }, select: { id: true, nomFichier: true, createdAt: true } });
  if (deja) return { ok: false, error: `Ce fichier a déjà été importé (« ${deja.nomFichier} », le ${deja.createdAt.toLocaleDateString("fr-FR")}) — rien n'est additionné une seconde fois.` };
  const memoire = await chargerMemoire();
  const { feuilles, ignorees } = analyserClasseur(lireFeuilles(buffer), memoire.colonnes);
  if (feuilles.length === 0) return { ok: false, error: "Aucune feuille de ce fichier n'a la forme d'une consommation (une colonne produit ou molécule, et des quantités)." };
  const ref = await chargerReferentiels();
  const resoudre = resolveur(ref.etablissements, ref.produits, memoire.resolution);

  // Les lignes DÉJÀ COMPTÉES (imports validés) : doublons exacts et périodes qui se chevauchent.
  const existantes = await prisma.consommationLigne.findMany({
    where: { statut: "OK", import: { statut: "VALIDE" } },
    select: { institutionId: true, etablissementBrut: true, productId: true, produitBrut: true, molecule: true, periodeDebut: true, periodeFin: true, quantite: true },
  });
  const clesExistantes = new Set(existantes.map((e) => cleDoublon({ ...e, periodeDebut: e.periodeDebut?.toISOString().slice(0, 10) ?? null, periodeFin: e.periodeFin?.toISOString().slice(0, 10) ?? null, quantite: e.quantite === null ? null : Number(e.quantite) })));
  const periodesExistantes = new Map<string, { debut: string; fin: string }[]>();
  for (const e of existantes) {
    if (!e.institutionId || !e.periodeDebut || !e.periodeFin) continue;
    const k = `${e.institutionId}|${e.productId ?? cleBrute(e.produitBrut ?? e.molecule)}`;
    (periodesExistantes.get(k) ?? periodesExistantes.set(k, []).get(k)!).push({ debut: e.periodeDebut.toISOString().slice(0, 10), fin: e.periodeFin.toISOString().slice(0, 10) });
  }

  const vues = new Set<string>();
  const data: Prisma.ConsommationLigneCreateManyInput[] = [];
  let ok = 0, aRevoir = 0, doublons = 0;
  for (const f of feuilles) for (const l of f.lignes) {
    const r = resoudre(l);
    const cle = cleDoublon({ ...r, ...l, periodeDebut: l.periode?.debut ?? null, periodeFin: l.periode?.fin ?? null });
    const anomalies = [...l.anomalies, ...r.raisons];
    let statut: string = r.statut;
    if (clesExistantes.has(cle)) { statut = "DOUBLON"; anomalies.push("Ligne déjà importée par un fichier validé — non additionnée."); }
    else if (vues.has(cle)) { statut = "DOUBLON"; anomalies.push("Ligne en double dans ce fichier — non additionnée."); }
    else if (r.institutionId && l.periode) {
      const k = `${r.institutionId}|${r.productId ?? cleBrute(l.produitBrut ?? l.molecule)}`;
      const p = periodesExistantes.get(k)?.find((x) => chevauche(x, l.periode!));
      if (p) { statut = "A_REVOIR"; anomalies.push(`Période ${l.periode.libelle} chevauchant une période déjà importée (${p.debut} → ${p.fin}) : à trancher pour ne pas compter deux fois.`); }
    }
    vues.add(cle);
    if (statut === "OK") ok++; else if (statut === "DOUBLON") doublons++; else aRevoir++;
    data.push({
      importId: "", feuille: l.feuille, ligneSource: l.ligneSource,
      periodeDebut: d(l.periode?.debut), periodeFin: d(l.periode?.fin),
      institutionId: r.institutionId, etablissementBrut: l.etablissementBrut, productId: r.productId, produitBrut: l.produitBrut,
      molecule: l.molecule, dosage: l.dosage, presentation: l.presentation,
      quantiteSource: l.quantiteSource, uniteSource: l.uniteSource, quantite: l.quantite, unite: l.unite,
      valeur: l.valeur, devise: l.devise, confiance: r.confiance, statut,
      anomalies: anomalies.length || r.propositionProduit ? ({ messages: anomalies, propositionProduit: r.propositionProduit, candidatsEtablissement: r.candidatsEtablissement } as Prisma.InputJsonValue) : undefined,
    });
  }
  const analyse = { feuilles: feuilles.map(({ lignes, ...reste }) => ({ ...reste, lignes: lignes.length })), ignorees } satisfies { feuilles: (Omit<AnalyseFeuille, "lignes"> & { lignes: number })[]; ignorees: string[] };
  const imp = await prisma.$transaction(async (tx) => {
    const i = await tx.consommationImport.create({
      data: { nomFichier, empreinte, taille: buffer.length, fichier: buffer, analyse: analyse as unknown as Prisma.InputJsonValue, auteurId, rapport: { lignes: data.length, ok, aRevoir, doublons } },
      select: { id: true },
    });
    for (let k = 0; k < data.length; k += 1000) await tx.consommationLigne.createMany({ data: data.slice(k, k + 1000).map((x) => ({ ...x, importId: i.id })) });
    return i;
  }, { timeout: 120_000, maxWait: 20_000 });
  return { ok: true, importId: imp.id, lignes: data.length, ok_: ok, aRevoir, doublons };
}

/** Recalcule le statut d'une ligne après une correction de la revue (mêmes règles que l'import). */
function statutApres(l: { institutionId: string | null; productId: string | null; molecule: string | null; periodeDebut: Date | null; quantite: Prisma.Decimal | null }): "OK" | "A_REVOIR" {
  const q = l.quantite === null ? null : Number(l.quantite);
  return l.institutionId && l.periodeDebut && q !== null && q >= 0 && (l.productId || l.molecule) ? "OK" : "A_REVOIR";
}

/**
 * REVUE : « cette valeur brute est CET établissement / CE produit ». Appliqué à toutes les lignes de l'import qui
 * portent la même valeur brute, et MÉMORISÉ pour les prochains fichiers (affiché comme tel, révisable).
 */
export async function confirmerCorrespondance(auteurId: string, importId: string, nature: "ETABLISSEMENT" | "PRODUIT", brut: string, cibleId: string): Promise<{ ok: true; lignes: number } | { ok: false; error: string }> {
  const cle = cleBrute(brut);
  if (!cle) return { ok: false, error: "Valeur brute vide." };
  const imp = await prisma.consommationImport.findUnique({ where: { id: importId }, select: { statut: true } });
  if (!imp) return { ok: false, error: "Import introuvable." };
  if (imp.statut !== "EN_REVUE") return { ok: false, error: "Cet import n'est plus en revue." };
  const existe = nature === "ETABLISSEMENT"
    ? await prisma.medicalInstitution.count({ where: { id: cibleId } })
    : await prisma.product.count({ where: { id: cibleId } });
  if (!existe) return { ok: false, error: "Cible introuvable." };
  const lignes = await prisma.consommationLigne.findMany({
    where: { importId, statut: { not: "DOUBLON" } },
    select: { id: true, etablissementBrut: true, produitBrut: true, molecule: true, institutionId: true, productId: true, periodeDebut: true, quantite: true },
  });
  const visees = lignes.filter((l) => cleBrute(nature === "ETABLISSEMENT" ? l.etablissementBrut : (l.produitBrut ?? l.molecule)) === cle);
  await prisma.$transaction(async (tx) => {
    for (const l of visees) {
      const maj = nature === "ETABLISSEMENT" ? { ...l, institutionId: cibleId } : { ...l, productId: cibleId };
      await tx.consommationLigne.update({ where: { id: l.id }, data: { ...(nature === "ETABLISSEMENT" ? { institutionId: cibleId } : { productId: cibleId }), statut: statutApres(maj), confiance: 99 } });
    }
    await tx.consommationMemoire.upsert({
      where: { nature_cle: { nature, cle } },
      update: { valeur: cibleId, confirmeParId: auteurId, utilisations: { increment: 1 } },
      create: { nature, cle, valeur: cibleId, confirmeParId: auteurId, utilisations: 1 },
    });
  });
  return { ok: true, lignes: visees.length };
}

/** Écarter une ligne (total, ligne parasite) — gardée, marquée IGNOREE, jamais supprimée. */
export async function ignorerLigne(ligneId: string): Promise<void> {
  await prisma.consommationLigne.update({ where: { id: ligneId }, data: { statut: "IGNOREE" } });
}

/** VALIDE l'import : ses lignes OK comptent désormais ; les colonnes reconnues sont mémorisées comme confirmées. */
export async function validerImport(auteurId: string, importId: string): Promise<{ ok: true; comptees: number; exclues: number } | { ok: false; error: string }> {
  const imp = await prisma.consommationImport.findUnique({ where: { id: importId }, select: { statut: true, analyse: true } });
  if (!imp) return { ok: false, error: "Import introuvable." };
  if (imp.statut !== "EN_REVUE") return { ok: false, error: "Cet import n'est pas en revue." };
  const [comptees, exclues] = await Promise.all([
    prisma.consommationLigne.count({ where: { importId, statut: "OK" } }),
    prisma.consommationLigne.count({ where: { importId, statut: { not: "OK" } } }),
  ]);
  const analyse = imp.analyse as { feuilles?: { colonnes?: { texte: string; champ: string | null; origine: string }[] }[] };
  const colonnes = (analyse.feuilles ?? []).flatMap((f) => f.colonnes ?? []).filter((c) => c.champ && c.origine === "ressemblance");
  await prisma.$transaction(async (tx) => {
    await tx.consommationImport.update({ where: { id: importId }, data: { statut: "VALIDE", valideLe: new Date(), valideParId: auteurId, rapport: { comptees, exclues } } });
    for (const c of colonnes) {
      const cle = cleBrute(c.texte);
      if (cle) await tx.consommationMemoire.upsert({ where: { nature_cle: { nature: "COLONNE", cle } }, update: { valeur: c.champ!, utilisations: { increment: 1 } }, create: { nature: "COLONNE", cle, valeur: c.champ!, confirmeParId: auteurId, utilisations: 1 } });
    }
  });
  return { ok: true, comptees, exclues };
}

export async function annulerImport(importId: string): Promise<void> {
  await prisma.consommationImport.update({ where: { id: importId }, data: { statut: "ANNULE" } });
}
