import JSZip from "jszip";
import { buildSimplePdf, parsePdfBody } from "@/lib/pdf/simple-pdf";
import type { ArtefactSpec, FeuilleSpec } from "@/lib/missions/artifacts/spec";
import { construireDeckVerifie } from "@/lib/artifact/decks/build";
import { versDeckExecutif } from "@/lib/missions/artifacts/deck";
import { ligneDeTotaux } from "@/lib/missions/artifacts/totaux";
import { construireClasseur } from "@/lib/missions/artifacts/xlsx";
import { celluleCsv } from "@/lib/formats/csv-cellule";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES AUTRES FORMATS (§20) — un livrable n'est pas toujours un classeur.
 *
 * ── CE QUI EST RÉUTILISÉ, ET CE QUI NE POUVAIT PAS L'ÊTRE ───────────────────────────────
 *
 * Le PDF réutilise `src/lib/pdf/simple-pdf.ts` tel quel : c'est un domaine de l'ERP, une façade
 * a le droit de l'appeler, et il fait exactement ce qu'il faut. Le PPTX ne dessine plus rien :
 * il TRADUIT vers `artifact/decks/build.ts`, le constructeur de decks unique (§118.60).
 *
 * Le DOCX est écrit ici, et c'est une duplication PARTIELLE assumée : `assistant/deliverables.ts`
 * sait déjà écrire du DOCX, mais il vit du côté ADAM de la frontière (voir `boundary-scan.ts`).
 * L'importer depuis une façade de l'ERP créerait une dépendance ERP → Adam — le couplage
 * inverse, celui qu'aucun compteur ne surveille et qui rendrait Adam indéracinable.
 *
 * La duplication reste bornée : trente lignes d'OOXML, et deux SPECS DIFFÉRENTES (celle-ci
 * porte des colonnes typées et des feuilles ; l'autre porte des sections de conversation). Le
 * jour où l'on voudra une seule implémentation, la bonne manœuvre sera de déplacer les
 * écrivains PURS dans `src/lib/office/` — pas d'importer l'un depuis l'autre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface RenduArtefact {
  buffer: Buffer;
  mime: string;
  /** Ce qui a été écrit — repris tel quel dans le rapport de contrôle. */
  detail: Record<string, unknown>;
}

export const MIMES: Record<string, string> = {
  XLSX: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  DOCX: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  PDF: "application/pdf",
  CSV: "text/csv",
  ZIP: "application/zip",
};

/** Rend le livrable dans son format. Un format inconnu est une erreur, jamais un repli muet. */
export async function rendre(spec: ArtefactSpec): Promise<RenduArtefact> {
  switch (spec.format) {
    case "XLSX": {
      const r = await construireClasseur(spec);
      return {
        buffer: r.buffer,
        mime: MIMES.XLSX,
        detail: { feuilles: r.feuilles, graphiques: r.graphiques, formules: r.formules },
      };
    }
    case "CSV": {
      const buffer = rendreCsv(spec);
      return { buffer, mime: MIMES.CSV, detail: { feuilles: (spec.sheets ?? []).length } };
    }
    case "DOCX": {
      const buffer = await rendreDocx(spec);
      return { buffer, mime: MIMES.DOCX, detail: { sections: (spec.summary ?? []).length, tableaux: (spec.sheets ?? []).length } };
    }
    case "PDF": {
      const buffer = rendrePdf(spec);
      return { buffer, mime: MIMES.PDF, detail: { sections: (spec.summary ?? []).length } };
    }
    case "PPTX": {
      // `diapositives` était calculé — `1 + summary.length` — donc FAUX dès qu'une section
      // débordait sur deux diapositives ou qu'un tableau en ajoutait une. On rapporte
      // maintenant ce que le constructeur a réellement écrit, relu dans le fichier.
      const d = await rendrePptx(spec);
      // LE CONSTRUCTEUR A REFUSÉ : il rend zéro octet. Laisser passer ce vide ferait échouer
      // l'étape sur « taille : 0 octets », un message qui ne dit rien à personne. On remonte la
      // RAISON — c'est elle qui permet au planificateur de refaire autre chose (§118.30).
      if (d.buffer.length === 0) {
        throw new Error(`le deck a été refusé par le contrôle éditorial : ${d.bloquants.join(" ; ")}`);
      }
      return {
        buffer: d.buffer, mime: MIMES.PPTX,
        detail: {
          diapositives: d.diapositives,
          ...(d.bloquants.length > 0 ? { bloquants: d.bloquants } : {}),
          ...(d.avertissements.length > 0 ? { avertissements: d.avertissements } : {}),
        },
      };
    }
    case "ZIP": {
      const r = await rendreZip(spec);
      return { buffer: r.buffer, mime: MIMES.ZIP, detail: { entrees: r.entrees } };
    }
    default:
      throw new Error(`format de livrable non pris en charge : ${String(spec.format)}`);
  }
}

// ─────────────────────────────────────── CSV ───────────────────────────────────────

/**
 * Un CSV porte UNE table. Quand la spec en compte plusieurs, on prend la première et on le DIT
 * dans le détail — plutôt que de concaténer des tableaux de colonnes différentes, ce qui produit
 * un fichier qu'aucun tableur n'ouvre correctement.
 */
export function rendreCsv(spec: ArtefactSpec): Buffer {
  const f = (spec.sheets ?? [])[0];
  if (!f) return Buffer.from("", "utf8");
  // Neutralise aussi `= + - @` en tête de texte : une valeur ne devient pas une formule dans le tableur.
  const echapper = (v: unknown): string => celluleCsv(v);
  // LA LIGNE DE TOTAUX EST CALCULÉE ICI (§118.59) : le CSV n'a pas de formules, et `totals`
  // n'est plus une intention que seul le classeur honore.
  const totaux = ligneDeTotaux(f);
  const lignes = [
    f.columns.map((c) => echapper(c.header)).join(";"),
    ...f.rows.map((r) => f.columns.map((c) => echapper(r[c.key])).join(";")),
    ...(totaux ? [f.columns.map((c, i) => echapper(i === 0 ? totaux.libelle : totaux.valeurs[c.key] ?? "")).join(";")] : []),
  ];
  // BOM UTF-8 : sans lui, Excel en français affiche « Rémunération » en mojibake.
  return Buffer.from(`﻿${lignes.join("\r\n")}\r\n`, "utf8");
}

// ─────────────────────────────────────── DOCX ──────────────────────────────────────

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const para = (texte: string, o: { bold?: boolean; size?: number; color?: string } = {}): string =>
  `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>`
  + `${o.bold ? "<w:b/>" : ""}${o.size ? `<w:sz w:val="${o.size}"/>` : ""}${o.color ? `<w:color w:val="${o.color}"/>` : ""}`
  + `</w:rPr><w:t xml:space="preserve">${esc(texte)}</w:t></w:r></w:p>`;

function tableauDocx(f: FeuilleSpec, maxLignes = 200): string {
  const cellule = (t: string, entete: boolean) =>
    `<w:tc><w:tcPr>${entete ? '<w:shd w:val="clear" w:fill="F4F6F8"/>' : ""}</w:tcPr>`
    + `<w:p><w:r><w:rPr>${entete ? "<w:b/>" : ""}<w:sz w:val="18"/></w:rPr>`
    + `<w:t xml:space="preserve">${esc(t)}</w:t></w:r></w:p></w:tc>`;
  const ligne = (cells: string[], entete: boolean) => `<w:tr>${cells.map((c) => cellule(c, entete)).join("")}</w:tr>`;
  const bordure = `<w:tblBorders>${["top", "bottom", "left", "right", "insideH", "insideV"]
    .map((b) => `<w:${b} w:val="single" w:sz="4" w:color="D5DAE0"/>`).join("")}</w:tblBorders>`;
  const corps = f.rows.slice(0, maxLignes).map((r) =>
    ligne(f.columns.map((c) => (r[c.key] === null || r[c.key] === undefined ? "" : String(r[c.key]))), false));
  // La ligne de totaux, CALCULÉE — sans elle, la promotion (§118.59) ferait disparaître du
  // rapport un total que le classeur, lui, affiche.
  const totaux = ligneDeTotaux(f);
  if (totaux) corps.push(ligne(f.columns.map((c, i) => (i === 0 ? totaux.libelle : String(totaux.valeurs[c.key] ?? ""))), true));
  const debordement = f.rows.length > maxLignes
    ? para(`(${f.rows.length - maxLignes} lignes supplémentaires — voir le classeur.)`, { size: 16, color: "5B6470" })
    : "";
  return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${bordure}</w:tblPr>`
    + ligne(f.columns.map((c) => c.header), true) + corps.join("") + `</w:tbl><w:p/>${debordement}`;
}

/** Le DOCX minimal mais VALIDE : trois parties, un corps, des tableaux. */
export async function rendreDocx(spec: ArtefactSpec): Promise<Buffer> {
  const corps = [
    para(spec.title, { bold: true, size: 36, color: "0B2545" }),
    ...(spec.summary ?? []).flatMap((s) => [
      para(s.heading, { bold: true, size: 26, color: "1B7F79" }),
      ...s.paragraphs.map((p) => para(p)),
      ...s.bullets.map((b) => para(`• ${b}`)),
    ]),
    ...(spec.sheets ?? []).flatMap((f) => [para(f.name, { bold: true, size: 24, color: "1B7F79" }), tableauDocx(f)]),
    ...(spec.sources && spec.sources.length > 0
      ? [para("Sources", { bold: true, size: 24, color: "1B7F79" }), ...spec.sources.map((s) => para(`• ${s}`))]
      : []),
  ].join("");

  const zip = new JSZip();
  zip.file("[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">`
    + `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>`
    + `<Default Extension="xml" ContentType="application/xml"/>`
    + `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`
    + `</Types>`);
  zip.file("_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`
    + `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>`
    + `</Relationships>`);
  zip.file("word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`
    + `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + `<w:body>${corps}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>`
    + `<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134"/></w:sectPr></w:body></w:document>`);

  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

// ─────────────────────────────────────── PDF ───────────────────────────────────────

export function rendrePdf(spec: ArtefactSpec): Buffer {
  const lignes: string[] = [];
  for (const s of spec.summary ?? []) {
    lignes.push(`# ${s.heading}`);
    for (const p of s.paragraphs) lignes.push(p);
    for (const b of s.bullets) lignes.push(`- ${b}`);
    lignes.push("");
  }
  for (const f of spec.sheets ?? []) {
    lignes.push(`# ${f.name}`);
    lignes.push(f.columns.map((c) => c.header).join(" | "));
    for (const r of f.rows.slice(0, 120)) {
      lignes.push(f.columns.map((c) => (r[c.key] ?? "")).join(" | "));
    }
    if (f.rows.length > 120) lignes.push(`- (${f.rows.length - 120} lignes supplémentaires)`);
    const totaux = ligneDeTotaux(f);
    if (totaux) lignes.push(f.columns.map((c, i) => (i === 0 ? totaux.libelle : totaux.valeurs[c.key] ?? "")).join(" | "));
    lignes.push("");
  }
  if (spec.sources && spec.sources.length > 0) {
    lignes.push("# Sources");
    for (const s of spec.sources) lignes.push(`- ${s}`);
  }
  return buildSimplePdf(spec.title, parsePdfBody(lignes.join("\n")), {
    footer: `AMD Internal OS — ${new Date().toLocaleDateString("fr-FR")}`,
  });
}

// ─────────────────────────────────────── PPTX ──────────────────────────────────────

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DECK — celui des quatre rendus qui passe devant un comité, et le seul qui se taisait.
 *
 * ── TROIS OMISSIONS, MESURÉES, TOUTES DANS CE SEUL RENDU (§118.60) ──────────────────────
 *
 * Le schéma EXIGE du modèle des sources : « au moins une entrée dès qu'il y a des chiffres ».
 * Le classeur leur donne une feuille, le Word une section, le PDF un bloc. Le PowerPoint les
 * jetait — `spec.sources` n'apparaissait pas une seule fois ici. Un deck de conseil dont on ne
 * peut pas dire d'où viennent les chiffres n'est pas défendable en séance : la première question
 * posée est celle-là. Il coupait aussi deux fois en silence — dix lignes sur quarante, quatre
 * feuilles sur douze — là où le Word DIT ce qu'il laisse. Une coupe silencieuse se lit comme une
 * exhaustivité (§118.52).
 *
 * ── ET LA CAUSE ÉTAIT PLUS PROFONDE : IL Y AVAIT DEUX CONSTRUCTEURS DE DECKS ────────────
 *
 * `artifact/decks/build.ts` tient les règles éditoriales comme des BLOQUANTS, relit le fichier
 * produit avec l'adaptateur de production et le soumet au contrôle de livraison. Il sert la
 * capacité `artifact.deck_build` d'Adam et la fabrique de dossiers de comité. Celui-ci dessinait
 * à la main — et c'est celui-ci qui produit le deck qu'une MISSION envoie. Deux exigences de
 * qualité selon l'origine du fichier, et celle des missions prenait du retard : sept puces d'un
 * côté, six de l'autre, pour la même règle (§118.5).
 *
 * Il ne reste donc ici qu'une TRADUCTION (`deck.ts`) vers le constructeur unique. Ce qui est
 * gagné au passage n'est pas cosmétique : notes du présentateur, chiffre clé, thème, refus d'un
 * deck hors règles — et un compte de diapositives MESURÉ au lieu d'être estimé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface DeckRendu {
  buffer: Buffer;
  diapositives: number;
  bloquants: string[];
  avertissements: string[];
}

export async function rendrePptx(spec: ArtefactSpec): Promise<DeckRendu> {
  const construit = await construireDeckVerifie(versDeckExecutif(spec));
  return {
    buffer: construit.octets,
    diapositives: construit.verification.diapos,
    bloquants: construit.verification.bloquants,
    avertissements: construit.verification.avertissements,
  };
}

// ─────────────────────────────────────── ZIP ───────────────────────────────────────

/**
 * Un ZIP porte le classeur ET le document : c'est le format « dossier complet ».
 *
 * Il ne se contente pas d'empaqueter : il RÉGÉNÈRE chaque format depuis la MÊME spec, ce qui
 * garantit qu'un chiffre du rapport est celui du classeur — la cohérence est structurelle, pas
 * surveillée.
 */
export async function rendreZip(spec: ArtefactSpec): Promise<{ buffer: Buffer; entrees: string[] }> {
  const zip = new JSZip();
  const entrees: string[] = [];

  if (spec.sheets && spec.sheets.length > 0) {
    const cl = await construireClasseur({ ...spec, format: "XLSX" });
    zip.file("classeur.xlsx", cl.buffer);
    entrees.push("classeur.xlsx");
    zip.file("donnees.csv", rendreCsv(spec));
    entrees.push("donnees.csv");
  }
  zip.file("rapport.docx", await rendreDocx(spec));
  entrees.push("rapport.docx");
  zip.file("rapport.pdf", rendrePdf(spec));
  entrees.push("rapport.pdf");

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, entrees };
}
