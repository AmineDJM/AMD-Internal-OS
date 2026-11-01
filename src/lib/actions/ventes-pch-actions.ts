"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { userCan } from "@/lib/rbac";
import { recordAudit } from "@/lib/audit";
import { fdStr, fdNum, fdCase, type ActionResult } from "@/lib/actions/types";
import {
  apercuFichierPch, appliquerFichierPch, rattacherEtablissementPch, rattacherPostePch, reglerFournisseurPch,
  enregistrerDirectionRegionale, type Apercu,
} from "@/lib/ventes-pch/service";
import { lireChoixPeriode, type ChoixPeriode } from "@/lib/ventes-pch/calculs";

/**
 * VENTES PCH — les gestes : voir l'aperçu d'un ou plusieurs fichiers (rien n'est écrit), les appliquer, rattacher un
 * client à un établissement, un poste PCH à un produit, régler les fournisseurs « à nous » d'un produit, nommer une
 * direction régionale. Droits : module `PCH_VENTES` (Téléverser pour importer, Modifier pour rattacher). Chaque geste
 * qui écrit est tracé au journal d'audit.
 */

const MODULE = "PCH_VENTES";
const CHEMIN = "/sales";

async function exiger(action: "UPLOAD" | "UPDATE") {
  const user = await requireUser();
  return { user, refus: userCan(user, MODULE, action) ? null : "Action non autorisée sur les ventes PCH (Administration › Accès)." };
}

function fichiersDe(formData: FormData): File[] {
  return formData.getAll("fichiers").filter((f): f is File => typeof f !== "string" && f.size > 0);
}

/**
 * LES PÉRIODES CHOISIES, fichier par fichier : un champ `periodes` JSON `{ "<nom du fichier>": { annee, mois } }` (`mois` 1..12,
 * ou « annuel »). Une entrée illisible est ignorée : le fichier garde alors la période lue sur ses dates.
 */
function periodesChoisies(formData: FormData): Map<string, ChoixPeriode> {
  const out = new Map<string, ChoixPeriode>();
  const brut = fdStr(formData, "periodes");
  if (!brut) return out;
  try {
    const o = JSON.parse(brut) as Record<string, { annee?: unknown; mois?: unknown }>;
    for (const [nom, v] of Object.entries(o ?? {})) {
      const c = lireChoixPeriode(v?.annee, v?.mois);
      if (c) out.set(nom, c);
    }
  } catch { /* champ illisible : aucune période choisie */ }
  return out;
}

export type ResultatApercu = { ok: true; apercus: Apercu[]; erreurs: { nomFichier: string; error: string }[] } | { ok: false; error: string };

/** APERÇU : chaque fichier est lu, sa nature et sa période reconnues, ses lignes rattachées — RIEN n'est écrit. */
export async function apercuFichiersVentesPch(formData: FormData): Promise<ResultatApercu> {
  const { refus } = await exiger("UPLOAD");
  if (refus) return { ok: false, error: refus };
  const fichiers = fichiersDe(formData);
  if (!fichiers.length) return { ok: false, error: "Choisissez au moins un fichier." };
  const apercus: Apercu[] = [], erreurs: { nomFichier: string; error: string }[] = [];
  const periodes = periodesChoisies(formData);
  for (const f of fichiers) {
    try {
      const r = await apercuFichierPch(Buffer.from(await f.arrayBuffer()), f.name || "fichier.xlsx", periodes.get(f.name) ?? null);
      if (r.ok) apercus.push(r.apercu); else erreurs.push({ nomFichier: f.name, error: r.error });
    } catch (e) {
      erreurs.push({ nomFichier: f.name, error: `Lecture impossible : ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  return { ok: true, apercus, erreurs };
}

export type ResultatImport = { ok: true; resultats: { nomFichier: string; message: string; ok: boolean }[] } | { ok: false; error: string };

/** APPLIQUER : idempotent (le même fichier ne fait rien), chaque mois du fichier remplace le même mois de sa source. */
export async function appliquerFichiersVentesPch(formData: FormData): Promise<ResultatImport> {
  const { user, refus } = await exiger("UPLOAD");
  if (refus) return { ok: false, error: refus };
  const fichiers = fichiersDe(formData);
  if (!fichiers.length) return { ok: false, error: "Choisissez au moins un fichier." };
  const resultats: { nomFichier: string; message: string; ok: boolean }[] = [];
  const periodes = periodesChoisies(formData);
  for (const f of fichiers) {
    try {
      const r = await appliquerFichierPch(Buffer.from(await f.arrayBuffer()), f.name || "fichier.xlsx", user.id, periodes.get(f.name) ?? null);
      if (!r.ok) { resultats.push({ nomFichier: f.name, message: r.error, ok: false }); continue; }
      if (r.deja) { resultats.push({ nomFichier: f.name, message: "Déjà importé — rien de changé.", ok: true }); continue; }
      const a = r.apercu;
      const quoi = a.nature === "VENTES_DR" ? `ventes ${a.sources.join(", ")}` : "réceptions PCH";
      const message = `${quoi} · ${a.periode.libelle} · ${r.lignes.toLocaleString("fr-FR")} lignes${r.remplacees ? ` (remplacent ${r.remplacees.toLocaleString("fr-FR")})` : ""}`;
      resultats.push({ nomFichier: f.name, message, ok: true });
      await recordAudit({ actorId: user.id, action: "IMPORT", module: MODULE, entityId: r.importId, summary: `Fichier PCH « ${f.name} » importé : ${message}.` });
    } catch (e) {
      resultats.push({ nomFichier: f.name, message: `Import impossible : ${e instanceof Error ? e.message : String(e)}`, ok: false });
    }
  }
  revalidatePath(CHEMIN, "layout");
  return { ok: true, resultats };
}

/** « Ce client de la PCH est cet établissement » (vide = détacher) — toutes ses lignes suivent, mémorisé. */
export async function rattacherEtablissementVentesPch(formData: FormData): Promise<ActionResult> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  const cle = fdStr(formData, "cle");
  const institutionId = fdStr(formData, "institutionId");
  if (!cle) return { ok: false, error: "Client manquant." };
  const r = await rattacherEtablissementPch(cle, institutionId, user.id);
  if (!r.ok) return r;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "etablissement", oldValue: cle, newValue: institutionId ?? "", summary: `Client PCH « ${cle} » ${institutionId ? "rattaché à un établissement" : "détaché"} (${r.lignes} ligne(s)).` });
  revalidatePath(CHEMIN, "layout");
  return { ok: true, message: `${r.lignes} ligne(s) rattachée(s).` };
}

/** « Ce poste PCH est ce produit » (vide = aucun des nôtres) — fait à la main, il ne bougera plus. */
export async function rattacherPosteVentesPch(formData: FormData): Promise<ActionResult> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  const poste = fdNum(formData, "poste");
  const productId = fdStr(formData, "productId");
  if (poste === null) return { ok: false, error: "Poste manquant." };
  const r = await rattacherPostePch(Math.round(poste), productId, user.id);
  if (!r.ok) return r;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "poste", oldValue: String(poste), newValue: productId ?? "", summary: `Poste PCH ${poste} ${productId ? "rattaché à un produit" : "déclaré hors de nos produits"} (${r.lignes} ligne(s)).` });
  revalidatePath(CHEMIN, "layout");
  return { ok: true, message: `${r.lignes} ligne(s) mise(s) à jour.` };
}

/** Un fournisseur PCH « à nous » pour un produit — ses réceptions FO deviennent notre sell-in (ou cessent de l'être). */
export async function reglerFournisseurVentesPch(formData: FormData): Promise<ActionResult> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  const productId = fdStr(formData, "productId");
  const fournisseur = fdStr(formData, "fournisseur");
  const actif = fdCase(formData, "actif") ?? true;
  if (!productId || !fournisseur) return { ok: false, error: "Produit et fournisseur requis." };
  const r = await reglerFournisseurPch(productId, fournisseur, actif, user.id);
  if (!r.ok) return r;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, entityId: productId, field: "fournisseur", newValue: `${fournisseur} : ${actif ? "nous" : "pas nous"}`, summary: `Fournisseur PCH « ${fournisseur} » ${actif ? "compté" : "retiré"} comme le nôtre.` });
  revalidatePath(CHEMIN, "layout");
  return { ok: true };
}

/** Le libellé et les wilayas d'une direction régionale de la PCH. */
export async function enregistrerDrVentesPch(formData: FormData): Promise<ActionResult> {
  const { user, refus } = await exiger("UPDATE");
  if (refus) return { ok: false, error: refus };
  const code = fdStr(formData, "code");
  const libelle = fdStr(formData, "libelle") ?? "";
  const wilayas = (fdStr(formData, "wilayas") ?? "").split(/[,;\n]/);
  if (!code) return { ok: false, error: "Code manquant." };
  const r = await enregistrerDirectionRegionale(code, libelle, wilayas);
  if (!r.ok) return r;
  await recordAudit({ actorId: user.id, action: "UPDATE", module: MODULE, field: "direction_regionale", newValue: `${code} : ${libelle}`, summary: `Direction régionale ${code} : « ${libelle} ».` });
  revalidatePath(CHEMIN, "layout");
  return { ok: true };
}
