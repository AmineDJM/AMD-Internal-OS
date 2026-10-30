/**
 * LE BANC DES CONVERSIONS HAUTE FIDÉLITÉ (décision 0019) — `npm run conversions:bench`.
 *
 * Passe chaque PDF du corpus versionné (`scripts/conversions/corpus/`, régénérable par `generer_corpus.py`) dans le
 * moteur du worker (`convertirHauteFidelite`, le même appel que la file `AtelierConversion`), puis MESURE le Word
 * obtenu contre `attendu.json` (`src/lib/office/conversions-mesure.ts`) :
 *   CER ≤ 1 % · 100 % des images (nombre + dimensions) · 0 caractère interdit · 100 % des paragraphes arabes en RTL ·
 *   tableaux reconstruits (lignes × colonnes).
 * Puis Word → PDF (LibreOffice) sur les sources Word du corpus, mesuré en ALLER-RETOUR (le PDF produit, relu par le
 * moteur, doit redonner le texte), et PDF → Excel (une feuille par tableau attendu).
 *
 * Aucun appel réseau, aucune base : seulement le moteur local (Python de `CONVERSIONS_PYTHON`, tesseract, LibreOffice).
 * Rapport : tableau à l'écran + `scripts/bench/resultats/conversions.json`. Sortie 1 si un critère tombe.
 * Options : `-- --seulement=ar-note,scan-ar` · `-- --sans-office`.
 */

import fs from "node:fs";
import path from "node:path";
import PizZip from "pizzip";
import { convertirHauteFidelite, etatMoteur } from "@/lib/office/conversions-haute-fidelite";
import { analyserDocx, mesurer, tauxErreurCaracteres, type Attendu, type Mesure } from "@/lib/office/conversions-mesure";

const CORPUS = path.join(process.cwd(), "scripts", "conversions", "corpus");
const SEUIL_CER = 0.01;

type Ligne = { fichier: string; producteur: string; secondes: number; mesure: Mesure; ok: boolean; motifs: string[]; ocr?: unknown };

function verdict(m: Mesure, att: Attendu): string[] {
  const motifs: string[] = [];
  if (m.cer > SEUIL_CER) motifs.push(`CER ${(m.cer * 100).toFixed(2)} % > 1 %`);
  if (m.interdits.length) motifs.push(`${m.interdits.length} caractère(s) interdit(s) : ${[...new Set(m.interdits.map((i) => `${i.code} ${i.motif}`))].slice(0, 3).join(", ")}`);
  if (!att.scan && (m.images.dimensionsJustes < m.images.attendues)) motifs.push(`images ${m.images.dimensionsJustes}/${m.images.attendues} (nombre + dimensions)`);
  if (m.rtl.justes < m.rtl.paragraphesArabes) motifs.push(`RTL ${m.rtl.justes}/${m.rtl.paragraphesArabes} : « ${m.rtl.fautes[0]} »`);
  if (m.tableaux.justes < m.tableaux.attendus.length) motifs.push(`tableaux ${m.tableaux.trouves.join(", ") || "aucun"} au lieu de ${m.tableaux.attendus.join(", ")}`);
  return motifs;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const seulement = args.find((a) => a.startsWith("--seulement="))?.split("=")[1]?.split(",") ?? null;
  const moteur = await etatMoteur(true);
  if (!moteur.pret) {
    console.error(`Moteur incomplet : ${moteur.manquants.join(", ") || moteur.erreur}. (CONVERSIONS_PYTHON=${process.env.CONVERSIONS_PYTHON ?? "python3"})`);
    process.exit(2);
  }
  const attendu = JSON.parse(fs.readFileSync(path.join(CORPUS, "attendu.json"), "utf8")) as Record<string, Attendu & { producteur: string }>;
  const lignes: Ligne[] = [];
  for (const [fichier, att] of Object.entries(attendu)) {
    if (seulement && !seulement.some((s) => fichier.startsWith(s))) continue;
    const debut = Date.now();
    const r = await convertirHauteFidelite(fs.readFileSync(path.join(CORPUS, fichier)), "PDF", "DOCX");
    const m = mesurer(analyserDocx(r.octets), att);
    const motifs = verdict(m, att);
    lignes.push({ fichier, producteur: att.producteur, secondes: (Date.now() - debut) / 1000, mesure: m, ok: motifs.length === 0, motifs, ocr: r.bilan.ocr ?? undefined });
  }

  // Word → PDF (LibreOffice), mesuré en aller-retour ; PDF → Excel.
  const office: { fichier: string; conversion: string; cer?: number; pages?: number; polices?: string[]; feuilles?: number; attendues?: number; ok: boolean }[] = [];
  if (!args.includes("--sans-office")) {
    for (const [fichier, att] of Object.entries(attendu)) {
      const docx = fichier.replace(/\.pdf$/, ".docx");
      if (att.producteur !== "LibreOffice" || !fs.existsSync(path.join(CORPUS, docx)) || (seulement && !seulement.some((s) => fichier.startsWith(s)))) continue;
      const pdf = await convertirHauteFidelite(fs.readFileSync(path.join(CORPUS, docx)), "DOCX", "PDF");
      const retour = await convertirHauteFidelite(pdf.octets, "PDF", "DOCX");
      const cer = tauxErreurCaracteres(att.texte.join("\n"), analyserDocx(retour.octets).texte);
      const polices = (pdf.bilan.polices as string[] | undefined) ?? [];
      const arabeOk = !att.arabes.length || polices.some((p) => /Naskh|Amiri|Arab/i.test(p));
      office.push({ fichier: docx, conversion: "Word → PDF (aller-retour)", cer, pages: pdf.bilan.pages as number, polices, ok: cer <= SEUIL_CER && arabeOk });
      if (att.tableaux.length) {
        const x = await convertirHauteFidelite(fs.readFileSync(path.join(CORPUS, fichier)), "PDF", "XLSX");
        const zip = new PizZip(x.octets);
        const feuilles = Object.keys(zip.files).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).length;
        office.push({ fichier, conversion: "PDF → Excel", feuilles, attendues: att.tableaux.length, ok: feuilles === att.tableaux.length });
      }
    }
  }

  const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
  console.log("\nPDF → Word — moteur haute fidélité (pdf2docx + PyMuPDF corrigés, tesseract)\n");
  console.log("fichier                  producteur      CER      images  interdits  RTL      tableaux  durée   verdict");
  for (const l of lignes) {
    const m = l.mesure;
    console.log([
      l.fichier.padEnd(24), l.producteur.padEnd(15), pct(m.cer).padStart(8),
      `${m.images.dimensionsJustes}/${m.images.attendues}`.padStart(7), String(m.interdits.length).padStart(10),
      `${m.rtl.justes}/${m.rtl.paragraphesArabes}`.padStart(8), `${m.tableaux.justes}/${m.tableaux.attendus.length}`.padStart(9),
      `${l.secondes.toFixed(1)} s`.padStart(7), l.ok ? "  OK" : `  ÉCHEC — ${l.motifs.join(" ; ")}`,
    ].join(" "));
  }
  if (office.length) {
    console.log("\nWord → PDF (LibreOffice) et PDF → Excel\n");
    for (const o of office) {
      console.log(`${o.fichier.padEnd(24)} ${o.conversion.padEnd(26)} ${o.cer !== undefined ? `CER ${pct(o.cer)}` : `${o.feuilles}/${o.attendues} feuilles`}${o.polices ? `  polices : ${o.polices.join(", ")}` : ""}  ${o.ok ? "OK" : "ÉCHEC"}`);
    }
  }
  const rapport = { date: new Date().toISOString(), moteur: moteur.detail, seuilCer: SEUIL_CER, pdfVersWord: lignes, office };
  fs.mkdirSync(path.join(process.cwd(), "scripts", "bench", "resultats"), { recursive: true });
  fs.writeFileSync(path.join(process.cwd(), "scripts", "bench", "resultats", "conversions.json"), JSON.stringify(rapport, null, 1) + "\n");
  const echecs = lignes.filter((l) => !l.ok).length + office.filter((o) => !o.ok).length;
  console.log(`\n${lignes.length + office.length - echecs}/${lignes.length + office.length} conformes — rapport : scripts/bench/resultats/conversions.json`);
  process.exit(echecs ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
