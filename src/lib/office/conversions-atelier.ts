/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES MOTEURS DE CONVERSION DE L'ATELIER (J3, décision 0017) — ce qui produit les octets, et la file.
 *
 * Bibliothèque ERP, SANS droits : elle ne lit ni n'écrit aucun fichier du Drive. Le socle IA
 * (`platform/ia/artifact/atelier/conversions.ts`) lit la source et dépose le résultat À TRAVERS LE PORT, sous les
 * droits de la personne ; ici, on transforme des octets et on tient la file `AtelierConversion`.
 *
 * Les voies, dans l'ordre où on les essaie :
 *   WORKER   LibreOffice headless, dans l'image du worker (J2) — fidèle. Choisie quand le worker BAT
 *            (il a pris une tâche dans les cinq dernières minutes) : la demande entre en FILE, le worker
 *            la prend à son passage suivant (`atelier.conversions`).
 *   EDITEUR  le Document Server OnlyOffice, quand il est configuré — fidèle (la voie d'avant J3).
 *   LOCAL    LibreOffice présent dans CE processus (poste de développement, conteneur) — fidèle.
 *   RENDU    le rendu PDF de ce dépôt (`docxToPdf`) — Word seulement, mise en page approchée, DIT.
 *   MAISON   ce que le dépôt compose lui-même : un tableau Word → un classeur vérifié ; un PDF → un Word
 *            (texte et paragraphes — la mise en page n'est pas reprise, et c'est DIT).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { convertConfigured, convertDocument } from "@/lib/office-convert";
import { appBaseUrl, makeFileReadToken } from "@/lib/onlyoffice";
import { adaptateurPour } from "@/lib/artifact/adapters/registry";
import { vueDuModele } from "@/lib/artifact/render/view";
import { lireTextePdf } from "@/lib/artifact/pdf/read";
import { composerDocx, MIME_DOCX, paragraphe } from "@/lib/artifact/factory/word";
import { construireClasseurVerifie } from "@/lib/artifact/sheets/build";
import { sansBloquer } from "@/lib/journal";

export type VersFormat = "PDF" | "XLSX" | "DOCX";
export type Voie = "WORKER" | "EDITEUR" | "LOCAL" | "RENDU" | "MAISON";

export const LIBELLE_VOIE: Record<Voie, string> = {
  WORKER: "LibreOffice, sur le worker",
  EDITEUR: "l'éditeur Office du serveur (OnlyOffice)",
  LOCAL: "LibreOffice, sur ce serveur",
  RENDU: "le rendu PDF intégré (mise en page approchée)",
  MAISON: "la composition intégrée",
};

export const MIME_CONVERSION: Record<VersFormat, string> = {
  PDF: "application/pdf",
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  DOCX: MIME_DOCX,
};
const EXT: Record<string, string> = { DOCX: "docx", PPTX: "pptx", XLSX: "xlsx", PDF: "pdf" };
/** Le worker « bat » s'il a pris une tâche dans les cinq dernières minutes — même seuil que sa sonde (J2). */
const WORKER_VIVANT_MS = 5 * 60_000;

export async function workerActif(maintenant = new Date()): Promise<boolean> {
  if (process.env.ATELIER_WORKER === "off") return false;
  const n = await prisma.tacheDeFond.count({
    where: { executeur: "worker", dernierDebutA: { gte: new Date(maintenant.getTime() - WORKER_VIVANT_MS) } },
  }).catch(sansBloquer("atelier.workerActif", 0));
  return n > 0;
}

let sofficeConnu: string | null | undefined;
/** LibreOffice est-il dans CE processus ? Cherché une fois (`soffice`, `libreoffice`). */
export async function libreOfficeLocal(): Promise<string | null> {
  if (sofficeConnu !== undefined) return sofficeConnu;
  if (process.env.ATELIER_LIBREOFFICE === "off") return (sofficeConnu = null);
  for (const bin of ["soffice", "libreoffice"]) {
    const ok = await new Promise<boolean>((r) => execFile(bin, ["--version"], { timeout: 15_000 }, (e) => r(!e)));
    if (ok) return (sofficeConnu = bin);
  }
  return (sofficeConnu = null);
}

/** CONVERTIT par LibreOffice headless, dans un dossier jetable, profil isolé (deux conversions ne se gênent pas). */
export async function convertirParLibreOffice(bin: string, octets: Buffer, extSource: string, vers: "pdf" | "docx" | "xlsx"): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), "atelier-"));
  try {
    const source = path.join(dir, `source.${extSource}`);
    await writeFile(source, octets);
    await new Promise<void>((ok, ko) => execFile(bin, [
      `-env:UserInstallation=file://${path.join(dir, "profil")}`, "--headless", "--norestore", "--convert-to", vers, "--outdir", dir, source,
    ], { timeout: 120_000 }, (e, _o, err) => (e ? ko(new Error(`LibreOffice : ${String(err || e.message).slice(0, 300)}`)) : ok())));
    return await readFile(path.join(dir, `source.${vers}`));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(sansBloquer("atelier.convertir.nettoyage"));
  }
}

/** Les conversions possibles depuis un format — ce que l'écran propose. */
export function conversionsPossibles(format: string | null): VersFormat[] {
  if (format === "DOCX") return ["PDF", "XLSX"];
  if (format === "PPTX" || format === "XLSX") return ["PDF"];
  if (format === "PDF") return ["DOCX"];
  return [];
}


/** Le tableau → un classeur : une feuille par tableau du Word, l'en-tête en titres, les nombres en nombres. */
async function tableauxEnClasseur(octets: Buffer): Promise<{ octets: Buffer; note: string } | { erreur: string }> {
  const vue = vueDuModele((await adaptateurPour("DOCX").ouvrir(octets)).modele());
  if (vue.kind !== "DOCX") return { erreur: "document illisible" };
  const tables = vue.blocs.filter((b) => b.type === "tableau" && b.lignes.length > 0);
  if (!tables.length) return { erreur: "ce document Word ne contient aucun tableau à mettre dans Excel" };
  const nombre = (v: string): number | string => {
    const t = v.replace(/[\s  ]/g, "").replace(/(DZD|DA|€|%)$/i, "").replace(",", ".");
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : v;
  };
  const feuilles = tables.slice(0, 20).map((t, i) => {
    const [entete = [], ...corps] = t.lignes;
    const colonnes = entete.map((titre, j) => ({ cle: `c${j + 1}`, titre: titre || `Colonne ${j + 1}` }));
    return {
      nom: `Tableau ${i + 1}`,
      colonnes,
      lignes: corps.map((l) => Object.fromEntries(colonnes.map((c, j) => [c.cle, nombre(l[j] ?? "")]))),
    };
  });
  const c = await construireClasseurVerifie({ feuilles });
  return { octets: c.octets, note: `${feuilles.length} tableau${feuilles.length > 1 ? "x" : ""} repris, une feuille chacun` };
}

/** Le PDF → un Word : le texte, page par page, en paragraphes. La mise en page ne suit pas — c'est dit. */
async function pdfEnWord(octets: Buffer, titre: string): Promise<{ octets: Buffer; note: string } | { erreur: string }> {
  const lu = await lireTextePdf(octets, { max: 300 });
  const blocs: string[] = [];
  for (const p of lu.pages) {
    const paras = p.texte.replace(/\r/g, "").split(/\n\s*\n/).map((x) => x.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean);
    for (const t of paras) blocs.push(paragraphe(t, { apresPt: 6 }));
  }
  if (!blocs.length) return { erreur: "ce PDF n'a pas de texte lisible (pages scannées) : rien à reprendre dans un Word" };
  const doc = composerDocx({ blocs, titre });
  const sans = lu.sansTexte.length ? ` ; ${lu.sansTexte.length} page${lu.sansTexte.length > 1 ? "s" : ""} sans texte (scannées) non reprises` : "";
  return { octets: doc.octets, note: `texte et paragraphes repris de ${lu.pages.length} page${lu.pages.length > 1 ? "s" : ""} — la mise en page, les images et les tableaux ne suivent pas${sans}${lu.tronque ? " ; document tronqué à 300 pages" : ""}` };
}

export const nomSans = (nom: string) => nom.replace(/\.[^.]+$/, "");

export interface SourceConversion { nodeId: string; version: number; format: string; nom: string }

/**
 * PRODUIT les octets convertis par la voie choisie, puis les RELIT (§48) : un fichier vide ou illisible ne devient
 * pas un document. `userId` ne sert qu'à l'éditeur Office (jeton de lecture signé, 5 minutes).
 */
export async function produire(userId: string, src: SourceConversion, octets: Buffer, vers: VersFormat, voie: Voie): Promise<{ octets: Buffer; note: string | null }> {
  let r: { octets: Buffer; note: string | null };
  if (voie === "MAISON") {
    const m = vers === "XLSX" ? await tableauxEnClasseur(octets) : await pdfEnWord(octets, nomSans(src.nom));
    if ("erreur" in m) throw new Error(m.erreur);
    r = m;
  } else if (voie === "EDITEUR") {
    const token = makeFileReadToken(src.nodeId, userId, 300);
    r = { octets: await convertDocument({ srcUrl: `${appBaseUrl()}/api/onlyoffice/file?token=${token}`, fromExt: EXT[src.format]!, outputType: "pdf", key: `atelier_${src.nodeId}_${src.version}` }), note: null };
  } else if (voie === "LOCAL" || voie === "WORKER") {
    const bin = await libreOfficeLocal();
    if (!bin) throw new Error(voie === "WORKER" ? "LibreOffice est absent de ce worker" : "LibreOffice n'est pas installé sur ce serveur");
    r = { octets: await convertirParLibreOffice(bin, octets, EXT[src.format]!, "pdf"), note: null };
  } else {
    const d = await docxToPdf(octets);
    if (!d.ok) throw new Error(d.error);
    r = { octets: d.pdf, note: `rendu intégré : ${d.pages} page${d.pages > 1 ? "s" : ""}, mise en page approchée${d.limites?.length ? ` (${d.limites.join(", ")})` : ""}` };
  }
  if (!r.octets.length) throw new Error("le fichier produit est vide");
  await adaptateurPour(vers).ouvrir(r.octets);
  return r;
}

/** Choisit la voie — et dit pourquoi aucune n'existe quand c'est le cas. */
export async function choisirVoie(format: string, vers: VersFormat): Promise<{ voie: Voie } | { refus: string }> {
  if (!conversionsPossibles(format).includes(vers)) return { refus: `un ${format} ne se convertit pas en ${vers} ici` };
  if (vers !== "PDF") return { voie: "MAISON" };
  if (await workerActif()) return { voie: "WORKER" };
  if (convertConfigured()) return { voie: "EDITEUR" };
  if (await libreOfficeLocal()) return { voie: "LOCAL" };
  if (format === "DOCX") return { voie: "RENDU" };
  return { refus: `aucune voie fidèle n'est disponible pour convertir un ${format === "PPTX" ? "PowerPoint" : "classeur"} en PDF : le worker (LibreOffice) ne tourne pas et l'éditeur Office n'est pas configuré` };
}

// ─────────────────────────── La file ───────────────────────────

export const fileConversions = {
  creer: (d: { userId: string; nodeId: string; version: number; sessionId: string | null; vers: VersFormat; voie: Voie }) =>
    prisma.atelierConversion.create({ data: { ...d, etat: d.voie === "WORKER" ? "EN_FILE" : "EN_COURS" } }),
  reussie: (id: string, resultatId: string, resultatNom: string, note: string | null) =>
    prisma.atelierConversion.update({ where: { id }, data: { etat: "FAITE", resultatId, resultatNom, note } }),
  echouee: (id: string, erreur: string) => prisma.atelierConversion.update({ where: { id }, data: { etat: "ECHEC", erreur: erreur.slice(0, 500) } }),
  enFile: (max: number) => prisma.atelierConversion.findMany({ where: { etat: "EN_FILE", voie: "WORKER" }, orderBy: { createdAt: "asc" }, take: max }),
  /** Réclamation atomique : deux exécutants ne prennent jamais la même. */
  prendre: async (id: string) => (await prisma.atelierConversion.updateMany({ where: { id, etat: "EN_FILE" }, data: { etat: "EN_COURS" } })).count === 1,
  /** Une demande en file depuis plus de 15 min (worker arrêté entre-temps) échoue en le disant. */
  expirer: () => prisma.atelierConversion.updateMany({
    where: { etat: "EN_FILE", createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { etat: "ECHEC", erreur: "le worker n'a pas pris la conversion à temps — relancez-la" },
  }),
  async recentes(userId: string) {
    const lignes = await prisma.atelierConversion.findMany({
      where: { userId, createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } }, orderBy: { createdAt: "desc" }, take: 8,
    });
    return lignes.map((l) => ({
      id: l.id, nodeId: l.nodeId, vers: l.vers, voie: l.voie as Voie, libelleVoie: LIBELLE_VOIE[l.voie as Voie] ?? l.voie,
      etat: l.etat, resultat: l.resultatId ? { nodeId: l.resultatId, nom: l.resultatNom ?? "" } : null, note: l.note, erreur: l.erreur,
      quand: l.createdAt.toISOString(),
    }));
  },
};
