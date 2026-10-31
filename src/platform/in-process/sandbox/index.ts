/**
 * LE BAC À SABLE, côté plateforme — la porte par laquelle Adam EXÉCUTE : SQL en lecture seule,
 * code isolé, opérations d'analyse, conseil de visualisation. Le pont peut connaître l'ERP :
 * c'est ici que le DROIT sur un fichier du Drive se vérifie (`canViewDrive`, nœud par nœud,
 * la même règle que l'écran et que le Live Office) et qu'une lecture SQL libre s'inscrit au
 * journal d'audit sous le nom de la personne. `lib/assistant/` n'importe jamais `lib/sandbox/`.
 */

export { executerSqlLectureSeule, verifierForme, TABLES_AUTORISEES, LIMITE_LIGNES, type ResultatSql } from "@/lib/sandbox/sql";
export { executerJs, verifierCodeJs, JS_DELAI_MS, type ResultatJs } from "@/platform/ia/analyse/js";
export { executerPython, sonderPython, verifierCodePython, PY_DELAI_MS, type ResultatPython, type DisponibilitePython } from "@/platform/ia/analyse/python";
export {
  OPERATIONS, decrire, regrouper, croiser, filtrer, trier, serie, moyenneMobile, croissance, cumul, tendance, rang, anomalies, cohortes, scenario, mediane, percentile,
  type Ligne, type Mesure, type Filtre, type Pas, type Agregat, type Operateur, type Ignore, type Colonne,
} from "@/platform/ia/analyse/analyse";
export { recommanderGraphique, verifierGraphique, type SpecGraphique, type Alerte, type TypeGraphique } from "@/platform/ia/analyse/viz";
export { appliquerEtapes, mesureDe, filtreDe, OPS_PIPELINE, MODE_EMPLOI_PIPELINE, ETAPES_MAX, type ResultatPipeline, type JournalEtape } from "@/platform/ia/analyse/pipeline";
export { passerLaPorte, inspecter, tester, valider, type Attente, type SchemaSortie, type RapportPorte } from "@/platform/ia/analyse/porte";

import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { getBlob } from "@/lib/drive-storage";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { hasGlobalView, type SessionUser } from "@/lib/rbac";

/** La VUE GLOBALE (direction, Super Admin) — le garde de `sql_query`, exposé ici pour que l'outil n'importe pas le RBAC. */
export const aVueGlobale = (user: SessionUser): boolean => hasGlobalView(user);
import type { Ligne } from "@/platform/ia/analyse/analyse";
// K1 (décision 0031) : la lecture des tableurs vit au socle — l'Assistant IA et Adam lisent un fichier de la même façon.
import { cellule, entetesDe, lireCsv, versLignes, LIGNES_TABLEUR_MAX } from "@/platform/ia/analyse/tableur";
import type { ResultatSql } from "@/lib/sandbox/sql";
import { sansBloquer } from "@/lib/journal";

export const LIGNES_DRIVE_MAX = LIGNES_TABLEUR_MAX;

export interface LignesDrive {
  ok: true; nodeId: string; nom: string; feuille: string | null;
  lignes: Ligne[]; colonnes: string[]; total: number; tronque: boolean;
}
export interface RefusDrive { ok: false; erreur: string; candidats?: { id: string; nom: string }[] }

const extDe = (nom: string): string => (nom.split(".").pop() ?? "").toLowerCase();

/**
 * LIRE UN FICHIER DU DRIVE EN LIGNES — sous le droit de la personne. `ref` est un identifiant de
 * nœud ou un nom ; un nom qui désigne plusieurs fichiers rend les CANDIDATS, jamais « le premier ».
 */
export async function lireLignesDrive(user: SessionUser, ref: string, opts: { feuille?: string | null; max?: number } = {}): Promise<LignesDrive | RefusDrive> {
  const max = Math.min(Math.max(opts.max ?? LIGNES_DRIVE_MAX, 1), LIGNES_DRIVE_MAX);
  const r = (ref ?? "").trim();
  if (!r) return { ok: false, erreur: "aucun fichier désigné" };
  let node = await prisma.driveNode.findUnique({ where: { id: r }, select: { id: true, name: true, type: true, isTrashed: true, mimeType: true } }).catch(sansBloquer("sandbox.lireLignesDrive.driveNode", null));
  if (!node) {
    const parNom = await prisma.driveNode.findMany({
      where: { type: "FILE", isTrashed: false, name: { contains: r, mode: "insensitive" } },
      select: { id: true, name: true, type: true, isTrashed: true, mimeType: true }, take: 8, orderBy: { updatedAt: "desc" },
    });
    const visibles: typeof parNom = [];
    for (const n of parNom) if (canViewDrive(await resolveDriveAccess(user, n.id))) visibles.push(n);
    if (visibles.length === 0) return { ok: false, erreur: `aucun fichier visible ne correspond à « ${r} »` };
    if (visibles.length > 1) return { ok: false, erreur: `plusieurs fichiers correspondent à « ${r} » — préciser lequel`, candidats: visibles.map((v) => ({ id: v.id, nom: v.name })) };
    node = visibles[0];
  }
  if (node.isTrashed) return { ok: false, erreur: "ce fichier est dans la corbeille" };
  if (node.type !== "FILE") return { ok: false, erreur: "c'est un dossier, pas un fichier" };
  if (!canViewDrive(await resolveDriveAccess(user, node.id))) return { ok: false, erreur: "ce fichier ne vous est pas ouvert dans le Drive" };
  const version = await prisma.fileVersion.findFirst({ where: { nodeId: node.id }, orderBy: { version: "desc" }, select: { blobId: true } });
  if (!version) return { ok: false, erreur: "ce fichier n'a aucune version lisible" };
  const octets = await getBlob(version.blobId).catch(sansBloquer("sandbox.lireLignesDrive.getBlob", null));
  if (!octets) return { ok: false, erreur: "le contenu du fichier n'a pas pu être lu" };
  const ext = extDe(node.name);
  if (["csv", "tsv", "txt"].includes(ext)) {
    const { entetes, lignes: brutes, total } = lireCsv(octets.toString("utf8"), max);
    const { lignes, tronque } = versLignes(entetes, brutes, max);
    return { ok: true, nodeId: node.id, nom: node.name, feuille: null, lignes, colonnes: entetes, total, tronque };
  }
  if (!["xlsx", "xlsm"].includes(ext)) return { ok: false, erreur: `format non lisible en lignes : .${ext || "?"} (CSV, TSV, XLSX, XLSM)` };
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(octets as unknown as ArrayBuffer); } catch { return { ok: false, erreur: "classeur illisible (protégé, corrompu ou format ancien .xls)" }; }
  const voulu = (opts.feuille ?? "").trim().toLowerCase();
  const ws = (voulu ? wb.worksheets.find((w) => w.name.trim().toLowerCase() === voulu) : null) ?? wb.worksheets.find((w) => w.rowCount > 0) ?? wb.worksheets[0];
  if (!ws) return { ok: false, erreur: voulu ? `feuille « ${opts.feuille} » introuvable (${wb.worksheets.map((w) => w.name).join(", ")})` : "classeur sans feuille" };
  const brutes: unknown[][] = [];
  let total = 0;
  ws.eachRow({ includeEmpty: false }, (row) => {
    total += 1;
    if (brutes.length > max + 1) return;
    const values = Array.isArray(row.values) ? row.values.slice(1) : [];
    brutes.push(values.map(cellule));
  });
  const entetes = entetesDe(brutes[0] ?? []);
  const { lignes, tronque } = versLignes(entetes, brutes.slice(1), max);
  return { ok: true, nodeId: node.id, nom: node.name, feuille: ws.name, lignes, colonnes: entetes, total: Math.max(0, total - 1), tronque };
}

/** Une lecture SQL libre est un pouvoir de direction : elle s'inscrit au journal, sous un nom. */
export async function journaliserSql(user: SessionUser, requete: string, res: ResultatSql): Promise<void> {
  await recordAudit({
    actorId: user.id, action: "EXPORT", module: "ASSISTANT",
    summary: `Bac à sable SQL (lecture seule, ${res.isolation ?? "refusé"}) · ${res.ok ? `${res.lignes.length} ligne(s)${res.tronque ? " (tronqué)" : ""} · ${res.relations.join(", ")}` : `refus : ${res.erreur}`} · ${requete.replace(/\s+/g, " ").slice(0, 160)}`,
  }).catch(sansBloquer("sandbox.journaliserSql.recordAudit"));
}
