/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CONVERSIONS DE L'ATELIER (J3, décision 0017) — Word → PDF, PowerPoint → PDF, Excel → PDF,
 * tableau → Excel, PDF → Word. Et l'écran dit TOUJOURS par quelle voie.
 *
 * Les voies, dans l'ordre où on les essaie :
 *   WORKER   LibreOffice headless, dans l'image du worker (J2) — fidèle. Choisie quand le worker BAT
 *            (il a pris une tâche dans les cinq dernières minutes) : la demande entre en FILE, le worker
 *            la prend à son passage suivant (`atelier.conversions`), l'écran relit l'état.
 *   EDITEUR  le Document Server OnlyOffice, quand il est configuré — fidèle (la voie d'avant J3).
 *   LOCAL    LibreOffice présent dans CE processus (poste de développement, conteneur) — fidèle.
 *   RENDU    le rendu PDF de ce dépôt (`docxToPdf`) — Word seulement, mise en page approchée, DIT.
 *   MAISON   ce que le dépôt compose lui-même : un tableau Word → un classeur vérifié ; un PDF → un Word
 *            (texte et paragraphes — la mise en page n'est pas reprise, et c'est DIT).
 *
 * Le résultat est un NOUVEAU fichier du Drive de la personne (dossier « Atelier ») : l'original n'est
 * jamais touché ; le port l'inscrit à la Bibliothèque. On convertit la DERNIÈRE VERSION ENREGISTRÉE — des
 * modifications non enregistrées n'y sont pas, et l'écran le dit avant de lancer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { docxToPdf } from "@/lib/payslip/to-pdf";
import { convertConfigured, convertDocument } from "@/lib/office-convert";
import { appBaseUrl, makeFileReadToken } from "@/lib/onlyoffice";
import { adaptateurPour, formatDeFichier } from "@/lib/artifact/adapters/registry";
import { vueDuModele } from "@/lib/artifact/render/view";
import { lireTextePdf } from "@/lib/artifact/pdf/read";
import { composerDocx, MIME_DOCX, paragraphe } from "@/lib/artifact/factory/word";
import { construireClasseurVerifie } from "@/lib/artifact/sheets/build";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { sansBloquer } from "@/lib/journal";
import { droitsSurDocument } from "./service";

export type VersFormat = "PDF" | "XLSX" | "DOCX";
export type Voie = "WORKER" | "EDITEUR" | "LOCAL" | "RENDU" | "MAISON";

export const LIBELLE_VOIE: Record<Voie, string> = {
  WORKER: "LibreOffice, sur le worker",
  EDITEUR: "l'éditeur Office du serveur (OnlyOffice)",
  LOCAL: "LibreOffice, sur ce serveur",
  RENDU: "le rendu PDF intégré (mise en page approchée)",
  MAISON: "la composition intégrée",
};

export const DOSSIER_ATELIER = "Atelier";
const MIME: Record<VersFormat, string> = {
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

export interface DemandeConversion {
  ok: boolean;
  motif: string | null;
  id: string | null;
  voie: Voie | null;
  etat: "EN_FILE" | "FAITE" | "ECHEC" | null;
  resultat: { nodeId: string; nom: string } | null;
  note: string | null;
}

const nomSans = (nom: string) => nom.replace(/\.[^.]+$/, "");

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

/** Exécute une conversion par une voie IMMÉDIATE (tout sauf le worker). */
async function convertirMaintenant(
  user: { id: string }, src: { nodeId: string; version: number; format: string; nom: string }, octets: Buffer, vers: VersFormat, voie: Voie,
): Promise<{ octets: Buffer; note: string | null }> {
  if (voie === "MAISON") {
    const r = vers === "XLSX" ? await tableauxEnClasseur(octets) : await pdfEnWord(octets, nomSans(src.nom));
    if ("erreur" in r) throw new Error(r.erreur);
    return r;
  }
  if (voie === "EDITEUR") {
    const token = makeFileReadToken(src.nodeId, user.id, 300);
    return { octets: await convertDocument({ srcUrl: `${appBaseUrl()}/api/onlyoffice/file?token=${token}`, fromExt: EXT[src.format]!, outputType: "pdf", key: `atelier_${src.nodeId}_${src.version}` }), note: null };
  }
  if (voie === "LOCAL") {
    const bin = await libreOfficeLocal();
    if (!bin) throw new Error("LibreOffice n'est pas installé sur ce serveur");
    return { octets: await convertirParLibreOffice(bin, octets, EXT[src.format]!, "pdf"), note: null };
  }
  // RENDU
  const r = await docxToPdf(octets);
  if (!r.ok) throw new Error(r.error);
  return { octets: r.pdf, note: `rendu intégré : ${r.pages} page${r.pages > 1 ? "s" : ""}, mise en page approchée${r.limites?.length ? ` (${r.limites.join(", ")})` : ""}` };
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

async function deposer(user: { id: string }, nom: string, vers: VersFormat, octets: Buffer) {
  return portsArtefact.documents.creerFichier(user.id, { nom: `${nomSans(nom)}.${vers.toLowerCase()}`, octets, mime: MIME[vers], dossier: DOSSIER_ATELIER });
}

/**
 * DEMANDE une conversion de la dernière version ENREGISTRÉE d'un fichier. Droits relus : il faut pouvoir LIRE
 * la source (le résultat atterrit dans le Drive de la personne, l'original n'est pas touché).
 */
export async function demanderConversion(user: CurrentUser, nodeId: string, vers: VersFormat, sessionId: string | null = null): Promise<DemandeConversion> {
  const rien = { id: null, voie: null, etat: null, resultat: null, note: null };
  const droits = await droitsSurDocument(user.id, nodeId);
  if (!droits.voir) return { ok: false, motif: "Ce document n'existe pas, ou vous n'y avez pas accès.", ...rien };
  const fiche = await portsArtefact.documents.decrire(user.id, nodeId);
  if (!fiche?.format) return { ok: false, motif: "Ce fichier n'est ni un Word, ni un PowerPoint, ni un Excel, ni un PDF.", ...rien };
  const choix = await choisirVoie(fiche.format, vers);
  if ("refus" in choix) return { ok: false, motif: `Conversion impossible : ${choix.refus}.`, ...rien };
  const ligne = await prisma.atelierConversion.create({
    data: { userId: user.id, nodeId, version: fiche.version, sessionId, vers, voie: choix.voie, etat: choix.voie === "WORKER" ? "EN_FILE" : "EN_COURS" },
  });
  if (choix.voie === "WORKER") {
    return { ok: true, motif: null, id: ligne.id, voie: "WORKER", etat: "EN_FILE", resultat: null, note: "en file : le worker la prend à son prochain passage (une minute au plus)" };
  }
  return executer(ligne.id, user, { nodeId, version: fiche.version, format: fiche.format, nom: fiche.nom }, vers, choix.voie);
}

async function executer(id: string, user: { id: string }, src: { nodeId: string; version: number; format: string; nom: string }, vers: VersFormat, voie: Voie): Promise<DemandeConversion> {
  try {
    const octets = await portsArtefact.documents.lire(user.id, src.nodeId, src.version);
    if (!octets) throw new Error("la source n'est plus accessible");
    let r: { octets: Buffer; note: string | null };
    if (voie === "WORKER") {
      const bin = await libreOfficeLocal();
      if (!bin) throw new Error("LibreOffice est absent de ce worker");
      r = { octets: await convertirParLibreOffice(bin, octets, EXT[src.format]!, "pdf"), note: null };
    } else {
      r = await convertirMaintenant(user, src, octets, vers, voie);
    }
    // Ce qui sort se RELIT avant d'être déposé (§48) : un fichier vide ou illisible ne devient pas un document.
    if (!r.octets.length || !formatDeFichier(`x.${vers.toLowerCase()}`, MIME[vers])) throw new Error("le fichier produit est vide");
    await adaptateurPour(vers).ouvrir(r.octets);
    const cree = await deposer(user, src.nom, vers, r.octets);
    const nom = `${nomSans(src.nom)}.${vers.toLowerCase()}`;
    await prisma.atelierConversion.update({ where: { id }, data: { etat: "FAITE", resultatId: cree.nodeId, resultatNom: nom, note: r.note } });
    return { ok: true, motif: null, id, voie, etat: "FAITE", resultat: { nodeId: cree.nodeId, nom }, note: r.note };
  } catch (e) {
    const erreur = (e as Error).message.slice(0, 500);
    await prisma.atelierConversion.update({ where: { id }, data: { etat: "ECHEC", erreur } });
    return { ok: false, motif: `La conversion (${LIBELLE_VOIE[voie]}) a échoué : ${erreur}`, id, voie, etat: "ECHEC", resultat: null, note: null };
  }
}

/**
 * LE PASSAGE DU WORKER (`atelier.conversions`) : il prend les demandes en file, une à une, sous réclamation
 * atomique (deux exécutants ne prennent jamais la même). Ailleurs que sur le worker, il ne fait rien —
 * c'est LibreOffice de l'image qui fait la différence.
 */
export async function traiterConversionsEnFile(opts: { executeur: string; max?: number }): Promise<{ faites: number; echecs: number }> {
  const bilan = { faites: 0, echecs: 0 };
  if (opts.executeur !== "worker") return bilan;
  const enFile = await prisma.atelierConversion.findMany({ where: { etat: "EN_FILE", voie: "WORKER" }, orderBy: { createdAt: "asc" }, take: opts.max ?? 5 });
  for (const c of enFile) {
    const pris = await prisma.atelierConversion.updateMany({ where: { id: c.id, etat: "EN_FILE" }, data: { etat: "EN_COURS" } });
    if (pris.count !== 1) continue;
    const fiche = await portsArtefact.documents.decrire(c.userId, c.nodeId);
    if (!fiche?.format) {
      await prisma.atelierConversion.update({ where: { id: c.id }, data: { etat: "ECHEC", erreur: "la source n'est plus accessible" } });
      bilan.echecs += 1;
      continue;
    }
    const r = await executer(c.id, { id: c.userId }, { nodeId: c.nodeId, version: c.version, format: fiche.format, nom: fiche.nom }, c.vers as VersFormat, "WORKER");
    if (r.ok) bilan.faites += 1; else bilan.echecs += 1;
  }
  // Une demande en file depuis plus de 15 min (worker arrêté entre-temps) échoue en le disant — jamais d'attente infinie.
  await prisma.atelierConversion.updateMany({
    where: { etat: "EN_FILE", createdAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { etat: "ECHEC", erreur: "le worker n'a pas pris la conversion à temps — relancez-la" },
  });
  return bilan;
}

/** Les conversions récentes de la personne (l'écran les montre sous l'Atelier). */
export async function conversionsRecentes(userId: string) {
  const lignes = await prisma.atelierConversion.findMany({
    where: { userId, createdAt: { gte: new Date(Date.now() - 6 * 3600_000) } },
    orderBy: { createdAt: "desc" }, take: 8,
  });
  return lignes.map((l) => ({
    id: l.id, nodeId: l.nodeId, vers: l.vers, voie: l.voie as Voie, libelleVoie: LIBELLE_VOIE[l.voie as Voie] ?? l.voie,
    etat: l.etat, resultat: l.resultatId ? { nodeId: l.resultatId, nom: l.resultatNom ?? "" } : null, note: l.note, erreur: l.erreur,
    quand: l.createdAt.toISOString(),
  }));
}
