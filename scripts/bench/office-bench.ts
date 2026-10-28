/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DU LIVE OFFICE (§97) — les cibles de §29, MESURÉES.
 *
 * §29 pose deux chiffres : une modification simple sous une à deux secondes, une suppression de
 * page PDF « quasi instantanée ». Une cible sans mesure est un vœu. Ce banc exerce le VRAI
 * chemin — ouverture, analyse, commande, sérialisation, relecture — sur de VRAIS fichiers, et
 * rend des P50 / P95.
 *
 *   npx tsx scripts/bench/office-bench.ts
 *
 * ── CE QUI EST MESURÉ, ET CE QUI NE L'EST PAS ───────────────────────────────────────────
 *
 * MESURÉ : l'ouverture (décompression + analyse + construction du modèle), l'application d'une
 * commande, la sérialisation, la rastérisation d'une page PDF, le décodage d'une phrase.
 *
 * PAS MESURÉ, et dit franchement : la latence réseau, le déchiffrement du blob Drive et l'aller-
 * retour d'action serveur. Ils dépendent de l'hébergement, pas de ce code ; les inventer ici
 * donnerait un chiffre flatteur et faux. Le chrono renvoyé par le moteur (`ResultatEdition.chrono`)
 * les inclut, lui, en production.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { adaptateurDocx } from "@/lib/artifact/adapters/docx/adapter";
import { adaptateurPdf } from "@/lib/artifact/adapters/pdf/adapter";
import { adaptateurXlsx } from "@/lib/artifact/adapters/xlsx/adapter";
import { adaptateurPptx } from "@/lib/artifact/adapters/pptx/adapter";
import { docxDeParagraphes, pdfNumerote, pptxDiapos, xlsxVentes } from "@/lib/artifact/adapters/fixtures";
import { cibleIndex, cibleRole, commande } from "@/lib/artifact/commands/ir";
import { decoder } from "@/lib/artifact/commands/nl";
import { rendrePagePdf } from "@/lib/artifact/render/raster";
import { chercherDansPdf, lireTextePdf } from "@/lib/artifact/pdf/read";
import { construireDeckVerifie } from "@/lib/artifact/decks/build";
import { comparer } from "@/lib/artifact/versions/diff";
import { controlerAvantLivraison } from "@/lib/artifact/qa/checks";
import { ciblePage } from "@/lib/artifact/commands/ir";
import PizZip from "pizzip";
import { percentiles } from "@/lib/artifact/observability/timing";
import type { DocumentOuvert } from "@/lib/artifact/adapters/contract";

const TOURS = 12;

interface Ligne {
  quoi: string;
  taille: string;
  p50: number;
  p95: number;
  max: number;
}

const lignes: Ligne[] = [];

async function mesurer(quoi: string, taille: string, tours: number, travail: () => Promise<void>): Promise<void> {
  // Un tour à blanc : le premier appel paie le chargement du module ESM de MuPDF et la
  // compilation à la volée. Le compter écraserait la médiane et donnerait un chiffre faux dans
  // le mauvais sens — ce n'est pas ce qu'une personne ressent au deuxième clic.
  await travail();
  const t: number[] = [];
  for (let i = 0; i < tours; i += 1) {
    const debut = performance.now();
    await travail();
    t.push(performance.now() - debut);
  }
  const p = percentiles(t);
  lignes.push({ quoi, taille, p50: p.p50, p95: p.p95, max: p.max });
}

/** Un document Word volumineux mais réaliste : un contrat de plusieurs dizaines de pages. */
async function grosDocx(paragraphes: number): Promise<Buffer> {
  const textes = ["Contrat de prestation"];
  for (let i = 1; i <= paragraphes; i += 1) {
    textes.push(`Article ${i} — Le prestataire s'engage à fournir les services décrits en annexe, dans les conditions et délais convenus entre les parties signataires du présent document.`);
  }
  return docxDeParagraphes(textes, { premierEstTitre: true, tableau: [["Poste", "Montant"], ["Conseil", "120 000 DZD"], ["Formation", "80 000 DZD"]] });
}

async function main(): Promise<void> {
  console.log("BANC LIVE OFFICE — cibles §29 : modification simple < 1–2 s, page PDF quasi instantanée\n");

  // ── Word ───────────────────────────────────────────────────────────────────────────
  for (const n of [40, 400]) {
    const octets = await grosDocx(n);
    const ko = Math.round(octets.length / 1024);
    let doc!: DocumentOuvert;
    await mesurer("DOCX ouvrir + modéliser", `${n} ¶ (${ko} Ko)`, TOURS, async () => {
      doc = await adaptateurDocx.ouvrir(octets);
      doc.modele();
    });
    await mesurer("DOCX centrer + 16 pt + Aptos", `${n} ¶`, TOURS, async () => {
      const d = await adaptateurDocx.ouvrir(octets);
      d.appliquer(commande("docx.align", { cible: cibleRole("titre"), alignement: "center" }));
      d.appliquer(commande("docx.format_texte", { cible: cibleIndex(1), taillePt: 16, police: "Aptos" }));
      d.modele();
    });
    await mesurer("DOCX sérialiser", `${n} ¶`, TOURS, async () => {
      await doc.serialiser();
    });
  }

  // ── PDF ────────────────────────────────────────────────────────────────────────────
  for (const n of [20, 300]) {
    const octets = await pdfNumerote(n);
    const ko = Math.round(octets.length / 1024);
    await mesurer("PDF ouvrir + modéliser", `${n} pages (${ko} Ko)`, TOURS, async () => {
      (await adaptateurPdf.ouvrir(octets)).modele();
    });
    await mesurer("PDF supprimer 3 pages", `${n} pages`, TOURS, async () => {
      const d = await adaptateurPdf.ouvrir(octets);
      d.appliquer(commande("pdf.supprimer_pages", { pages: [3, 5, 9] }));
      d.modele();
    });
    await mesurer("PDF rendre UNE page en PNG", `${n} pages`, Math.min(TOURS, 6), async () => {
      await rendrePagePdf(octets, Math.min(7, n));
    });
  }

  // ── Excel ──────────────────────────────────────────────────────────────────────────
  {
    const octets = await xlsxVentes();
    await mesurer("XLSX ouvrir + modéliser", `2 feuilles (${Math.round(octets.length / 1024)} Ko)`, TOURS, async () => {
      (await adaptateurXlsx.ouvrir(octets)).modele();
    });
    await mesurer("XLSX écrire + mettre en forme + trier", "2 feuilles", TOURS, async () => {
      const d = await adaptateurXlsx.ouvrir(octets);
      d.appliquer(commande("xlsx.valeur", { feuille: "Ventes", plage: "B3", texte: "Tlemcen" }));
      d.appliquer(commande("xlsx.format", { feuille: "Ventes", plage: "A1:C1", gras: true, remplissage: "1B7F79" }));
      d.appliquer(commande("xlsx.trier", { feuille: "Ventes", plage: "A2:C5", colonne: 3, direction: "desc" }));
      await d.serialiser();
    });
  }

  // ── PowerPoint ─────────────────────────────────────────────────────────────────────
  {
    const octets = await pptxDiapos(20);
    await mesurer("PPTX ouvrir + modéliser", `20 diapos (${Math.round(octets.length / 1024)} Ko)`, TOURS, async () => {
      (await adaptateurPptx.ouvrir(octets)).modele();
    });
    await mesurer("PPTX texte + format + déplacer", "20 diapos", TOURS, async () => {
      const d = await adaptateurPptx.ouvrir(octets);
      d.appliquer(commande("pptx.texte", { diapo: 2, cible: cibleIndex(1), texte: "Résultats 2026" }));
      d.appliquer(commande("pptx.format_texte", { diapo: 2, cible: cibleIndex(1), taillePt: 40, police: "Aptos" }));
      d.appliquer(commande("pptx.deplacer", { diapo: 2, cible: cibleIndex(1), dxCm: -1.5 }));
      await d.serialiser();
    });
  }

  // ── L'ÉCHELLE — 300 pages Word, 120 diapositives, 500 pages PDF ─────────────────────
  //
  // Les cibles du mandat « Office God Mode », mesurées sur de vrais fichiers. Chaque ligne a un
  // BUDGET (`SEUILS_ECHELLE`) : un banc qui ne peut pas échouer n'est pas un banc.
  {
    // 6 000 paragraphes = ~300 pages, avec les marques de pagination de Word toutes les 20 lignes.
    const textes = ["Contrat cadre de distribution"];
    for (let i = 1; i <= 6000; i += 1) textes.push(i % 40 === 1 ? `Article ${Math.ceil(i / 40)} — Dispositions` : `Paragraphe ${i} : le distributeur s'engage à respecter les conditions décrites en annexe, dans les délais convenus entre les parties.`);
    const base = await docxDeParagraphes(textes, { premierEstTitre: true });
    const zip = new PizZip(base);
    let k = 0;
    zip.file("word/document.xml", zip.file("word/document.xml")!.asText()
      // Les « Article n » deviennent des titres (Heading1) : c'est ce qui fait le plan.
      .replace(/<w:p><w:r><w:t xml:space="preserve">(Article \d+ — Dispositions)<\/w:t>/g, '<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t xml:space="preserve">$1</w:t>')
      .replace(/<w:p>(<w:pPr>.*?<\/w:pPr>)?<w:r>/g, (m, pPr: string | undefined) => {
        k += 1;
        return k > 1 && (k - 1) % 20 === 0 ? `<w:p>${pPr ?? ""}<w:r><w:lastRenderedPageBreak/></w:r><w:r>` : m;
      }));
    const octets = zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
    let doc!: DocumentOuvert;
    await mesurer("DOCX 300 pages : ouvrir + carte des pages + plan", `6 001 ¶ (${Math.round(octets.length / 1024)} Ko)`, 4, async () => {
      doc = await adaptateurDocx.ouvrir(octets);
      doc.modele();
    });
    const m = doc.modele();
    if (m.kind === "DOCX" && (m.pages < 290 || m.paginationSource !== "word" || m.plan.length !== 151)) {
      throw new Error(`carte des pages fausse : ${m.pages} pages (${m.paginationSource}), plan ${m.plan.length}`);
    }
    await mesurer("DOCX 300 pages : réécrire le 3e ¶ de la page 212 + sérialiser", "6 001 ¶", 4, async () => {
      const d = await adaptateurDocx.ouvrir(octets);
      const e = d.appliquer(commande("docx.texte", { cible: ciblePage(212, { index: 3 }), texte: "Clause révisée." }));
      if (!e.ok) throw new Error(e.motif ?? "échec");
      await d.serialiser();
    });
    await mesurer("DOCX 300 pages : comparer deux versions (1 insertion au milieu)", "6 001 ¶", 3, async () => {
      const d = await adaptateurDocx.ouvrir(octets);
      const avant = d.modele();
      d.appliquer(commande("docx.inserer_paragraphe", { cible: cibleIndex(3000), texte: "Clause insérée.", position: "apres" }));
      const c = comparer(avant, d.modele());
      if (c.changements.length !== 1) throw new Error(`comparaison : ${c.changements.length} changement(s) au lieu de 1`);
    });
    await mesurer("DOCX 300 pages : contrôle avant livraison", "6 001 ¶", 4, async () => { controlerAvantLivraison(doc.modele()); });
  }
  {
    const diapos = Array.from({ length: 120 }, (_, i) => ({ titre: `Idée ${i + 1} — un constat par diapositive`, puces: [`Premier point de la diapositive ${i + 1}`, `Deuxième point, chiffré : ${(i * 7) % 100} %`, "Troisième point : la décision attendue"] }));
    let octets!: Buffer;
    await mesurer("PPTX 120 diapos : construire + relire + contrôler", "120 idées", 2, async () => {
      const r = await construireDeckVerifie({ titre: "Revue stratégique", sousTitre: "Comité", diapos });
      if (!r.verification.ok) throw new Error(r.verification.bloquants.join(" ; "));
      octets = r.octets;
    });
    await mesurer("PPTX 120 diapos : ouvrir + modéliser", `${Math.round(octets.length / 1024)} Ko`, 6, async () => { (await adaptateurPptx.ouvrir(octets)).modele(); });
    await mesurer("PPTX 120 diapos : ajouter une idée + déplacer une diapo + sérialiser", "121 diapos", 4, async () => {
      const d = await adaptateurPptx.ouvrir(octets);
      const e = d.appliquer(commande("pptx.ajouter_diapo", { diapo: 60, nom: "Nouvelle idée", texte: "Un point\nUn autre" }));
      if (!e.ok) throw new Error(e.motif ?? "échec");
      d.appliquer(commande("pptx.deplacer_diapo", { diapo: 121, versIndex: 2 }));
      await d.serialiser();
    });
  }
  {
    const octets = await pdfNumerote(500);
    await mesurer("PDF 500 pages : ouvrir + modéliser (aperçu de chaque page)", `${Math.round(octets.length / 1024)} Ko`, 3, async () => { (await adaptateurPdf.ouvrir(octets)).modele(); });
    await mesurer("PDF 500 pages : lire le texte natif de 40 pages", "pages 231-270", 4, async () => {
      const l = await lireTextePdf(octets, { pages: "231-270" });
      if (l.pages.length !== 40 || l.pages[0].texte !== "Page 231") throw new Error("lecture fausse");
    });
    await mesurer("PDF 500 pages : chercher une expression dans tout le document", "500 pages", 3, async () => {
      const r = await chercherDansPdf(octets, "Page 437");
      if (r.pagesTouchees.join() !== "437") throw new Error(`recherche fausse : ${r.pagesTouchees.join(",")}`);
    });
    await mesurer("PDF 500 pages : supprimer 3 pages + sérialiser", "500 pages", 3, async () => {
      const d = await adaptateurPdf.ouvrir(octets);
      d.appliquer(commande("pdf.supprimer_pages", { pages: [3, 250, 499] }));
      await d.serialiser();
    });
  }

  // ── Le décodeur direct (§30) : le chemin SANS modèle ───────────────────────────────
  await mesurer("Décodage d'une phrase (0 modèle)", "—", 200, async () => {
    decoder("Centre le titre, réduis-le à 16", { format: "DOCX", derniereCible: [], activePage: null, activeSlide: null, activeSheet: null });
    decoder("Supprime les pages 12, 14 et 18", { format: "PDF", derniereCible: [], activePage: 1, activeSlide: null, activeSheet: null });
  });

  // ── Le rapport ─────────────────────────────────────────────────────────────────────
  const large = Math.max(...lignes.map((l) => l.quoi.length));
  const largeT = Math.max(...lignes.map((l) => l.taille.length));
  console.log(`${"opération".padEnd(large)}  ${"taille".padEnd(largeT)}  ${"P50".padStart(9)}  ${"P95".padStart(9)}  ${"max".padStart(9)}`);
  console.log("─".repeat(large + largeT + 35));
  for (const l of lignes) {
    console.log(`${l.quoi.padEnd(large)}  ${l.taille.padEnd(largeT)}  ${`${l.p50} ms`.padStart(9)}  ${`${l.p95} ms`.padStart(9)}  ${`${l.max} ms`.padStart(9)}`);
  }

  // ── Le verdict, chiffré ────────────────────────────────────────────────────────────
  const CIBLE_EDITION_MS = 1000;
  const CIBLE_PAGE_PDF_MS = 400;
  const editions = lignes.filter((l) => /centrer|supprimer|écrire|texte \+ format/.test(l.quoi));
  const pages = lignes.filter((l) => l.quoi.includes("rendre UNE page"));
  const lentes = editions.filter((l) => l.p95 > CIBLE_EDITION_MS);
  const lentesPages = pages.filter((l) => l.p95 > CIBLE_PAGE_PDF_MS);

  console.log(`\nCIBLE §29 — modification simple : P95 < ${CIBLE_EDITION_MS} ms (hors réseau)`);
  console.log(lentes.length === 0
    ? `  ✓ les ${editions.length} opérations d'édition tiennent la cible`
    : `  ✗ ${lentes.length} au-dessus : ${lentes.map((l) => `${l.quoi} (${l.taille}) ${l.p95} ms`).join(", ")}`);
  console.log(`CIBLE §29 — page PDF affichée : P95 < ${CIBLE_PAGE_PDF_MS} ms`);
  console.log(lentesPages.length === 0
    ? `  ✓ le rendu d'une page tient la cible, y compris sur 300 pages`
    : `  ✗ ${lentesPages.map((l) => `${l.taille} : ${l.p95} ms`).join(", ")}`);
  // ── L'échelle : un budget par ligne ────────────────────────────────────────────────
  const SEUILS_ECHELLE: [RegExp, number][] = [
    [/DOCX 300 pages : ouvrir/, 4000], [/DOCX 300 pages : réécrire/, 6000], [/DOCX 300 pages : comparer/, 8000], [/DOCX 300 pages : contrôle/, 1500],
    [/PPTX 120 diapos : construire/, 20000], [/PPTX 120 diapos : ouvrir/, 3000], [/PPTX 120 diapos : ajouter/, 5000],
    [/PDF 500 pages : ouvrir/, 6000], [/PDF 500 pages : lire/, 3000], [/PDF 500 pages : chercher/, 8000], [/PDF 500 pages : supprimer/, 3000],
  ];
  const horsBudget = lignes.filter((l) => SEUILS_ECHELLE.some(([re, max]) => re.test(l.quoi) && l.p95 > max));
  console.log(`\nÉCHELLE — 300 pages Word, 120 diapositives, 500 pages PDF : ${SEUILS_ECHELLE.length} budgets`);
  console.log(horsBudget.length === 0
    ? "  ✓ tous les budgets d'échelle sont tenus"
    : `  ✗ ${horsBudget.map((l) => `${l.quoi} ${l.p95} ms`).join(", ")}`);
  console.log("\nNON MESURÉ ICI (dépend de l'hébergement, pas de ce code) : réseau, déchiffrement");
  console.log("du blob Drive, aller-retour d'action serveur. Le chrono du moteur les inclut en production.");
  if (lentes.length > 0 || lentesPages.length > 0 || horsBudget.length > 0) process.exitCode = 1;

  if (lentes.length || lentesPages.length) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
