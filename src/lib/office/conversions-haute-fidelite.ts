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

/** CONVERTIT des octets. `extension` : celle du fichier d'origine pour une image (png, jpg, tif…). */
export async function convertirHauteFidelite(octets: Buffer, de: FormatSource, vers: FormatCible, o: { extension?: string; langues?: string } = {}): Promise<ResultatHauteFidelite> {
  if (!CONVERSIONS_HAUTE_FIDELITE[de]?.includes(vers)) throw new Error(`conversion ${de} → ${vers} non prise en charge`);
  const dir = await mkdtemp(path.join(tmpdir(), "amd-conv-"));
  try {
    const ext = de === "IMAGE" ? (o.extension ?? "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png" : EXT_SOURCE[de];
    const source = path.join(dir, `source.${ext}`);
    const sortie = path.join(dir, `resultat.${EXT_CIBLE[vers]}`);
    await writeFile(source, octets);
    const r = await lancer(["--source", source, "--de", de, "--vers", vers, "--sortie", sortie, "--langues", o.langues ?? "ara+fra+eng"], DELAI_MS);
    if (!r.ok) throw new Error(r.erreur ?? "échec du moteur de conversion");
    return { octets: await readFile(sortie), bilan: r.bilan ?? {} };
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
    return morceaux.join(" ; ");
  }
  if (vers === "XLSX") return String(b.note ?? `${n("tableaux")} tableau(x) repris`);
  if (vers === "IMAGES") return `${n("images")} diapositive${n("images") > 1 ? "s" : ""} en images PNG (${n("ppp")} ppp), dans un ZIP`;
  if (de === "IMAGE") return "image gardée telle quelle, texte reconnu (OCR) en calque cherchable";
  return `${n("pages")} page${n("pages") > 1 ? "s" : ""}, polices embarquées, images sans perte`;
}
