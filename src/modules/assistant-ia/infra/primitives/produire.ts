import ExcelJS from "exceljs";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { journaliserGeste } from "@/platform/ia/hors-requete";
import { deposerDansLEspace, type FichierEcrit } from "@/lib/actions/internes/primitives/espace";
import { docxDepuisBlocs, MIME_DOCX, pdfDepuisDocx } from "@/lib/actions/internes/primitives/office";
import type { JeuxDuTour } from "../../domaine/analyse/jeux";
import { assainirHtml, blocsDuHtml, CHARTE_ADVENTUM, type Presentation } from "../../domaine/primitives/html";
import { observerHtml } from "../../domaine/primitives/observation";
import { observer, type Observation, type ValeurObservee } from "../../domaine/observation/contrat";
import { fichierObserve, observerOctets } from "./observer";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT I3 — `produire(xlsx | csv | docx | pdf)` : LE LIVRABLE EN MISE EN PAGE LIBRE (décision 0065, AU2 §6.1 (c), étape M1).
 *
 * Un classeur depuis un JEU lu (`lire`, une lecture, une analyse) ou des lignes données ; un Word / PDF depuis du HTML
 * que le modèle compose comme il veut. DÉFAUT PROFESSIONNEL (en-têtes et titres à la charte, colonnes ajustées, filtres),
 * LIBERTÉ TOTALE SUR DEMANDE (`presentation: "libre"` : rien n'est ajouté). AUCUN TOTAL INVENTÉ : une ligne « Total » ne
 * s'écrit que sur les colonnes demandées (`totaux`) — c'est le défaut C8 de l'audit (les téléphones additionnés).
 * Les listes deviennent du texte lisible (« Ouest — Oran, Est »), jamais du JSON.
 *
 * Le fichier va dans l'ESPACE D'ADAM de la personne (« Brouillons » par défaut, ou le dossier dit), sous le journal des
 * effets (K10 : il s'annule ; un même nom → nouvelle version, la précédente se rétablit). Puis le code le RELIT et rend
 * l'OBSERVATION : le modèle la confronte à la demande avant de dire que c'est fait.
 * Le mail n'est pas ici (`produire(mail)` = lot I1).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTIL_PRODUIRE = "produire";
const MIME: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", csv: "text/csv", docx: MIME_DOCX, pdf: "application/pdf",
};
type Format = "xlsx" | "csv" | "docx" | "pdf";
const LIGNES_MAX = 20_000;
const json = (o: unknown) => JSON.stringify(o);
const texte = (e: Record<string, unknown>, k: string) => (typeof e[k] === "string" ? (e[k] as string).trim() : "");
const liste = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x ?? "").trim()).filter(Boolean) : typeof v === "string" && v.trim() ? v.split(/\s*,\s*/) : []);

/** Une valeur de cellule LISIBLE : une liste jointe, un booléen en oui / non, un objet en « clé : valeur ». */
export function celluleLisible(v: unknown): string | number | Date | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" || v instanceof Date) return v;
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (Array.isArray(v)) return v.map((x) => celluleLisible(x)).filter((x) => x !== null && x !== "").join(", ");
  if (typeof v === "object") return Object.entries(v as Record<string, unknown>).map(([k, x]) => `${k} : ${celluleLisible(x) ?? ""}`).join(" ; ");
  return String(v);
}

export interface SpecClasseur {
  feuille: string;
  colonnes: string[];
  lignes: Record<string, unknown>[];
  ajoutees: string[];
  renommer: Record<string, string>;
  totaux: string[];
  presentation: Presentation;
}

/** Le CLASSEUR : en-tête (à la charte par défaut), lignes lisibles, colonnes ajoutées vides, totaux SEULEMENT demandés. */
export async function construireClasseur(s: SpecClasseur): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Adam — Adventum Pharma";
  const ws = wb.addWorksheet(s.feuille.replace(/[\\/?*[\]:]/g, "-").slice(0, 31) || "Feuille 1");
  const cols = [...s.colonnes, ...s.ajoutees.filter((c) => !s.colonnes.includes(c))];
  ws.addRow(cols.map((c) => s.renommer[c] ?? c));
  for (const l of s.lignes.slice(0, LIGNES_MAX)) ws.addRow(cols.map((c) => celluleLisible(l[c])));
  if (s.totaux.length && s.lignes.length) {
    const r = ws.addRow(cols.map((c, i) => (i === 0 ? "Total" : s.totaux.includes(c) ? { formula: `SUM(${ws.getColumn(i + 1).letter}2:${ws.getColumn(i + 1).letter}${s.lignes.length + 1})` } : null)));
    r.font = { bold: true };
  }
  if (s.presentation === "professionnelle") {
    const entete = ws.getRow(1);
    entete.font = { bold: true, color: { argb: `FF${CHARTE_ADVENTUM.surAccent.slice(1)}` } };
    entete.fill = { type: "pattern", pattern: "solid", fgColor: { argb: `FF${CHARTE_ADVENTUM.accent.slice(1)}` } };
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if (cols.length) ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: cols.length } };
    cols.forEach((c, i) => {
      const larg = Math.max(String(s.renommer[c] ?? c).length, ...s.lignes.slice(0, 200).map((l) => String(celluleLisible(l[c]) ?? "").length));
      ws.getColumn(i + 1).width = Math.min(60, Math.max(10, larg + 2));
    });
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const csvDe = (cols: string[], lignes: Record<string, unknown>[]): Buffer => {
  const cel = (v: unknown) => { const t = String(celluleLisible(v) ?? ""); return /[;"\n]/.test(t) ? `"${t.replace(/"/g, "\"\"")}"` : t; };
  return Buffer.from(`﻿${[cols.join(";"), ...lignes.map((l) => cols.map((c) => cel(l[c])).join(";"))].join("\r\n")}`, "utf8");
};

interface ContexteProduire { jeux: Pick<JeuxDuTour, "trouver" | "lister"> }

/** PRODUIRE : construire, déposer (journalisé), relire, observer. */
export async function produireLivrable(u: CurrentUser, e: Record<string, unknown>, ctx: ContexteProduire): Promise<Record<string, unknown>> {
  const format = texte(e, "format").toLowerCase().replace(/^\./, "") as Format;
  if (!(format in MIME)) return { statut: "INCOMPLET", raison: "`format` : xlsx, csv, docx ou pdf (le mail se prépare par l'outil de mail)." };
  const presentation: Presentation = texte(e, "presentation").toLowerCase().startsWith("l") ? "libre" : "professionnelle";
  const base = (texte(e, "nom") || "Document").replace(/\.(xlsx|csv|docx|pdf)$/i, "");
  const nom = `${base}.${format}`;
  let octets: Buffer;
  let extra: Record<string, ValeurObservee | undefined> = {};
  if (format === "xlsx" || format === "csv") {
    const jeu = texte(e, "jeu") ? ctx.jeux.trouver(texte(e, "jeu")) : null;
    if (texte(e, "jeu") && !jeu) return { statut: "INCOMPLET", raison: `jeu « ${texte(e, "jeu")} » inconnu`, jeux: ctx.jeux.lister() };
    const lignes = (jeu?.lignes ?? (Array.isArray(e.lignes) ? e.lignes.filter((l) => l && typeof l === "object") : [])) as Record<string, unknown>[];
    if (!lignes.length && !liste(e.colonnes).length) return { statut: "INCOMPLET", raison: "rien à écrire : un `jeu` lu (lire, une lecture) ou des `lignes`", jeux: ctx.jeux.lister() };
    const toutes = [...new Set(lignes.flatMap((l) => Object.keys(l)))];
    const voulues = liste(e.colonnes);
    const inconnues = voulues.filter((c) => !toutes.includes(c));
    if (lignes.length && inconnues.length) return { statut: "INCOMPLET", raison: `colonne(s) absente(s) du jeu : ${inconnues.join(", ")} ; colonnes : ${toutes.join(", ")} (une colonne neuve va dans colonnesAjoutees)` };
    const colonnes = voulues.length ? voulues : toutes;
    const renommer = (e.renommer && typeof e.renommer === "object" ? e.renommer : {}) as Record<string, string>;
    const totaux = liste(e.totaux).filter((c) => colonnes.includes(c));
    const ajoutees = liste(e.colonnesAjoutees);
    octets = format === "xlsx"
      ? await construireClasseur({ feuille: texte(e, "feuille") || base, colonnes, lignes, ajoutees, renommer, totaux, presentation })
      : csvDe([...colonnes, ...ajoutees], lignes);
    extra = { source: jeu ? `jeu ${jeu.id} (${jeu.origine})` : "lignes données" };
  } else {
    const html = texte(e, "html");
    if (!html) return { statut: "INCOMPLET", raison: "`html` : le corps du document (titres, paragraphes, listes, tableaux, styles en ligne)." };
    const propre = assainirHtml(html, presentation);
    const docx = docxDepuisBlocs(blocsDuHtml(propre.html), { titre: base, couleurTitres: presentation === "professionnelle" ? CHARTE_ADVENTUM.accent : null });
    if (format === "pdf") {
      const p = await pdfDepuisDocx(docx);
      octets = p.octets;
      if (p.limites.length) extra.limitesDuRendu = p.limites;
    } else {
      octets = docx;
    }
    const rendu = observerHtml(propre.html);
    extra = {
      ...extra, rendu: `${rendu.tableaux} tableau(x), ${rendu.titres} titre(s), ${rendu.paragraphes} paragraphe(s) ; stylés : ${Object.entries(rendu.elementsStyles as Record<string, number>).map(([b, n]) => `${b}×${n}`).join(", ") || "aucun"}`,
      couleursDemandees: rendu.couleurs as string[],
      ...(propre.balisesRetirees.length ? { retireParAssainissement: propre.balisesRetirees } : {}),
    };
  }
  const dossier = texte(e, "dossier") || "Brouillons";
  let ecrit: FichierEcrit;
  let gesteId: string | null = null;
  try {
    const r = await journaliserGeste(u, { origine: "carte", capaciteId: "outil:produire", libelle: `Adam a produit « ${nom} »` },
      () => deposerDansLEspace(u, { dossier, nom, mime: MIME[format]!, octets }));
    ecrit = r.resultat;
    gesteId = r.gesteId;
  } catch (err) {
    return { statut: "ECHEC", raison: `Le fichier a été construit mais pas déposé dans votre espace : ${(err as Error).message}` };
  }
  const observation: Observation = await observerOctets(ecrit.nodeId, "ECRIT", octets, ecrit.nom, MIME[format]!, { ...extra, version: ecrit.version, rangeDans: ecrit.chemin })
    .catch((err) => observer("fichier", fichierObserve(ecrit.nodeId), "ECRIT", { nom: ecrit.nom, erreur: `écrit, mais pas relu : ${(err as Error).message}` }));
  return {
    statut: "FAIT", fichier: ecrit.nom, nodeId: ecrit.nodeId, rangeDans: ecrit.chemin, version: ecrit.version,
    lien: `/drive/${ecrit.nodeId}`, telecharger: `/api/drive/${ecrit.nodeId}/raw?dl=1`, ...(gesteId ? { annulable: true } : {}),
    // L'observation, lue par le modèle ; et DÉCLARÉE au journal du tour (I1 : historique, garde de vérité).
    observation, _observations: [observation],
  };
}

export function outilProduire(user: CurrentUser, ctx: ContexteProduire): PowerTool {
  return {
    def: {
      name: OUTIL_PRODUIRE,
      description: "PRODUIT un fichier dans l'ESPACE D'ADAM de la personne (dossier « Brouillons » par défaut ; `dossier` pour ranger ailleurs, ex. « Copies/Annuaires ») : "
        + "xlsx ou csv depuis un JEU lu (lire, une lecture, une analyse) ou des `lignes`, avec colonnes choisies, renommées, AJOUTÉES (vides : « statut »…), "
        + "et des totaux SEULEMENT sur les colonnes demandées ; docx ou pdf depuis du HTML que tu composes librement (titres, paragraphes, listes, tableaux, "
        + "styles en ligne ; `class=\"charte\"` = aux couleurs d'Adventum). Défaut professionnel (charte sur les en-têtes et titres) ; `presentation: \"libre\"` "
        + "pour n'ajouter aucun style. Le fichier est annulable. Rend l'OBSERVATION du fichier réellement écrit (colonnes, lignes, totaux, anomalies, texte) : "
        + "confronte-la à la demande ; si elle ne correspond pas, rappelle produire (même nom = nouvelle version).",
      input_schema: {
        type: "object",
        properties: {
          format: { type: "string", enum: ["xlsx", "csv", "docx", "pdf"] },
          nom: { type: "string", description: "Nom du fichier (sans extension)." },
          jeu: { type: "string", description: "xlsx/csv : le nom du jeu lu." },
          lignes: { type: "array", items: { type: "object" }, description: "xlsx/csv : les lignes, si aucun jeu." },
          colonnes: { type: "array", items: { type: "string" }, description: "xlsx/csv : colonnes gardées, dans l'ordre (défaut : toutes)." },
          colonnesAjoutees: { type: "array", items: { type: "string" }, description: "xlsx/csv : colonnes neuves, vides." },
          renommer: { type: "object", description: "xlsx : { colonne: nouvel en-tête }." },
          totaux: { type: "array", items: { type: "string" }, description: "xlsx : les colonnes à totaliser (aucune par défaut)." },
          feuille: { type: "string", description: "xlsx : nom de la feuille." },
          html: { type: "string", description: "docx/pdf : le corps HTML." },
          presentation: { type: "string", enum: ["professionnelle", "libre"] },
          dossier: { type: "string", description: "Dossier dans l'espace d'Adam (défaut « Brouillons »)." },
        },
        required: ["format", "nom"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Fichier produit",
    run: async (e, u) => json(await produireLivrable(u, e ?? {}, ctx)),
  };
}
