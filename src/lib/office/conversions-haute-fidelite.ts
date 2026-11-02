/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MOTEUR HAUTE FIDÉLITÉ (décision 0019) — le pont vers `scripts/conversions/convertir.py`.
 *
 * Le worker (image `Dockerfile.worker`) porte un Python à lui (`/opt/conversions`, paquets ÉPINGLÉS) : pdf2docx +
 * PyMuPDF pour PDF → Word, tesseract ara+fra+eng pour les scans, LibreOffice pour Office → PDF, openpyxl pour
 * PDF → Excel. Ce module n'en sait rien : il écrit la source dans un dossier jetable, appelle le script, relit
 * UNE ligne JSON (`{ok, bilan}` ou `{ok:false, erreur}`) et le fichier produit.
 *
 * Bibliothèque serveur (processus enfant, fichiers) : JAMAIS importée par un composant client.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sansBloquer } from "@/lib/journal";

export type FormatSource = "PDF" | "DOCX" | "PPTX" | "XLSX" | "IMAGE";
export type FormatCible = "PDF" | "DOCX" | "XLSX" | "IMAGES";

/** Ce que le moteur sait faire — la table que l'écran et l'outil de l'Assistant lisent. */
export const CONVERSIONS_HAUTE_FIDELITE: Record<FormatSource, FormatCible[]> = {
  PDF: ["DOCX", "XLSX"],
  DOCX: ["PDF"],
  PPTX: ["PDF", "IMAGES"],
  XLSX: ["PDF"],
  IMAGE: ["PDF", "DOCX"],
};

const SCRIPT = path.join(process.cwd(), "scripts", "conversions", "convertir.py");
/** Une conversion de 300 pages scannées tient sous 10 min sur un worker « starter » ; au-delà, on arrête. */
const DELAI_MS = 10 * 60_000;

/** Le Python du moteur : `CONVERSIONS_PYTHON`, sinon celui de l'image du worker, sinon `python3`. */
export function pythonDuMoteur(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CONVERSIONS_PYTHON) return env.CONVERSIONS_PYTHON;
  if (existsSync("/opt/conversions/bin/python")) return "/opt/conversions/bin/python";
  return "python3";
}

export interface EtatMoteur {
  pret: boolean;
  manquants: string[];
  detail: Record<string, unknown> | null;
  erreur: string | null;
}

function lancer(args: string[], delaiMs: number): Promise<{ ok: boolean; bilan?: Record<string, unknown>; erreur?: string }> {
  return new Promise((resolve) => {
    execFile(pythonDuMoteur(), [SCRIPT, ...args], { timeout: delaiMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      const ligne = String(stdout ?? "").trim().split("\n").filter(Boolean).pop() ?? "";
      try {
        const r = JSON.parse(ligne) as { ok: boolean; bilan?: Record<string, unknown>; erreur?: string };
        resolve(r);
      } catch {
        const motif = e?.killed ? "délai dépassé" : String(stderr || e?.message || "réponse illisible").trim().split("\n").pop();
        resolve({ ok: false, erreur: `moteur de conversion : ${String(motif).slice(0, 300)}` });
      }
    });
  });
}

let etatConnu: { a: number; etat: EtatMoteur } | null = null;

/** Le moteur est-il complet ICI (Python, paquets, tesseract ara/fra/eng, LibreOffice, polices) ? Relu toutes les 10 min. */
export async function etatMoteur(forcer = false): Promise<EtatMoteur> {
  if (process.env.CONVERSIONS_MOTEUR === "off") return { pret: false, manquants: ["CONVERSIONS_MOTEUR=off"], detail: null, erreur: null };
  if (!forcer && etatConnu && Date.now() - etatConnu.a < 10 * 60_000) return etatConnu.etat;
  const r = await lancer(["--verifier"], 60_000);
  const detail = r.ok ? (r.bilan ?? null) : null;
  const etat: EtatMoteur = {
    pret: Boolean(detail?.pret),
    manquants: Array.isArray(detail?.manquants) ? (detail!.manquants as string[]) : r.ok ? [] : ["python"],
    detail,
    erreur: r.ok ? null : (r.erreur ?? "moteur absent"),
  };
  etatConnu = { a: Date.now(), etat };
  return etat;
}

const EXT_SOURCE: Record<FormatSource, string> = { PDF: "pdf", DOCX: "docx", PPTX: "pptx", XLSX: "xlsx", IMAGE: "png" };
const EXT_CIBLE: Record<FormatCible, string> = { PDF: "pdf", DOCX: "docx", XLSX: "xlsx", IMAGES: "zip" };

export interface ResultatHauteFidelite { octets: Buffer; bilan: Record<string, unknown> }

/** Une page que la lecture locale désigne pour l'OCR vision (passage 1 du moteur). */
export interface DemandeVision { page: number; image: Buffer; raison: string; tesseract: string[] }

/**
 * LE LECTEUR VISION (décision 0019, suite) — fourni par l'appelant qui A LE DROIT de l'utiliser (garde de
 * confidentialité passée, réglage du Super Admin, plafond) ; absent, rien ne part. Rend une transcription par page,
 * et ce qu'il faut DIRE (pages lues, refus, coût).
 */
export type LecteurVision = (demandes: DemandeVision[]) => Promise<{ transcriptions: Record<number, string>; note: string | null; coutUsd: number }>;

/**
 * CONVERTIT des octets. `extension` : celle du fichier d'origine pour une image (png, jpg, tif…). `vision` : le lecteur
 * vision autorisé pour CE document — le moteur désigne d'abord les pages que tesseract lit mal (passage 1), le lecteur
 * les transcrit, puis le moteur compose avec ses transcriptions, vérifiées contre tesseract (passage 2).
 */
export async function convertirHauteFidelite(octets: Buffer, de: FormatSource, vers: FormatCible, o: { extension?: string; langues?: string; vision?: LecteurVision } = {}): Promise<ResultatHauteFidelite> {
  if (!CONVERSIONS_HAUTE_FIDELITE[de]?.includes(vers)) throw new Error(`conversion ${de} → ${vers} non prise en charge`);
  const dir = await mkdtemp(path.join(tmpdir(), "amd-conv-"));
  try {
    const ext = de === "IMAGE" ? (o.extension ?? "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png" : EXT_SOURCE[de];
    const source = path.join(dir, `source.${ext}`);
    const sortie = path.join(dir, `resultat.${EXT_CIBLE[vers]}`);
    await writeFile(source, octets);
    const base = ["--source", source, "--de", de, "--vers", vers, "--sortie", sortie, "--langues", o.langues ?? "ara+fra+eng"];
    const lisible = (de === "PDF" || de === "IMAGE") && (vers === "DOCX" || vers === "XLSX");
    const dossierVision = path.join(dir, "vision");
    const r = await lancer(o.vision && lisible ? [...base, "--vision-dossier", dossierVision] : base, DELAI_MS);
    if (!r.ok) throw new Error(r.erreur ?? "échec du moteur de conversion");
    const pages = Array.isArray(r.bilan?.vision_demandes) ? (r.bilan!.vision_demandes as number[]) : [];
    if (!o.vision || !pages.length) return { octets: await readFile(sortie), bilan: r.bilan ?? {} };

    const brutes = JSON.parse(await readFile(path.join(dossierVision, "demandes.json"), "utf8")) as { page: number; image: string; raison: string; tesseract: string[] }[];
    const demandes: DemandeVision[] = await Promise.all(brutes.map(async (d) => ({ page: d.page, raison: d.raison, tesseract: d.tesseract, image: await readFile(d.image) })));
    const v = await o.vision(demandes);
    const lues = Object.keys(v.transcriptions).length;
    if (!lues) return { octets: await readFile(sortie), bilan: { ...(r.bilan ?? {}), vision: { pages: [], note: v.note, coutUsd: v.coutUsd } } };
    const fichier = path.join(dir, "transcriptions.json");
    await writeFile(fichier, JSON.stringify(v.transcriptions));
    const r2 = await lancer([...base, "--transcriptions", fichier], DELAI_MS);
    if (!r2.ok) throw new Error(r2.erreur ?? "échec du moteur de conversion (composition vision)");
    return { octets: await readFile(sortie), bilan: { ...(r2.bilan ?? {}), vision: { pages: Object.keys(v.transcriptions).map(Number), note: v.note, coutUsd: v.coutUsd } } };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(sansBloquer("conversions.hf.nettoyage"));
  }
}

/** La phrase que l'écran et l'Assistant répètent : ce que le moteur a fait, en clair. */
export function noteDuBilan(de: FormatSource, vers: FormatCible, b: Record<string, unknown>): string {
  const n = (k: string) => (typeof b[k] === "number" ? (b[k] as number) : 0);
  if (de === "PDF" && vers === "DOCX" || de === "IMAGE" && vers === "DOCX") {
    const post = (b.post ?? {}) as Record<string, number>;
    const ocr = Array.isArray(b.pages_ocr) ? (b.pages_ocr as number[]) : [];
    const morceaux = [`${n("pages")} page${n("pages") > 1 ? "s" : ""} reconstruite${n("pages") > 1 ? "s" : ""} (mise en page, images, tableaux, polices)`];
    if (post.rtl) morceaux.push(`${post.rtl} paragraphe${post.rtl > 1 ? "s" : ""} de droite à gauche`);
    if (ocr.length) {
      const details = (b.ocr ?? {}) as Record<string, { confiance?: number; reconstruite?: boolean }>;
      const images = Object.values(details).filter((d) => d && d.reconstruite === false).length;
      morceaux.push(`${ocr.length} page${ocr.length > 1 ? "s" : ""} scannée${ocr.length > 1 ? "s" : ""} lue${ocr.length > 1 ? "s" : ""} par OCR (arabe, français, anglais)${images ? ` — ${images} trop peu lisible${images > 1 ? "s" : ""} : image de la page gardée, texte reconnu à la suite` : ""}`);
    }
    if (Array.isArray(b.entetes) && b.entetes.length) morceaux.push("en-tête et pied de page reposés");
    const vision = b.vision as { pages?: number[]; note?: string | null } | undefined;
    if (vision?.pages?.length) {
      const ecarts = Object.values((b.ocr ?? {}) as Record<string, { controle?: { absentes_de_tesseract?: number; absentes_de_la_vision?: number } }>)
        .reduce((n, p) => n + (p?.controle?.absentes_de_tesseract ?? 0) + (p?.controle?.absentes_de_la_vision ?? 0), 0);
      morceaux.push(`page${vision.pages.length > 1 ? "s" : ""} ${vision.pages.join(", ")} transcrite${vision.pages.length > 1 ? "s" : ""} par l'OCR vision (vérifiée${vision.pages.length > 1 ? "s" : ""} contre tesseract${ecarts ? ` : ${ecarts} ligne${ecarts > 1 ? "s" : ""} vue${ecarts > 1 ? "s" : ""} d'un seul côté, à relire` : ", aucun écart de ligne"})`);
    }
    if (vision?.note) morceaux.push(vision.note);
    return morceaux.join(" ; ");
  }
  if (vers === "XLSX") return String(b.note ?? `${n("tableaux")} tableau(x) repris`);
  if (vers === "IMAGES") return `${n("images")} diapositive${n("images") > 1 ? "s" : ""} en images PNG (${n("ppp")} ppp), dans un ZIP`;
  if (de === "IMAGE") return "image gardée telle quelle, texte reconnu (OCR) en calque cherchable";
  return `${n("pages")} page${n("pages") > 1 ? "s" : ""}, polices embarquées, images sans perte`;
}
