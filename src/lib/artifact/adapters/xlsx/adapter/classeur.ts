/**
 * L'ADAPTATEUR EXCEL — le CLASSEUR OUVERT (`XlsxOuvert` : modèle, commandes, images, sérialisation,
 * validation) et l'adaptateur `adaptateurXlsx` qui l'ouvre depuis des octets.
 */
import PizZip from "pizzip";
import { type SheetCellNode, type SheetImageNode, type SheetNode, type XlsxModel, analyserPlage, cellulesDePlage, formerRef, analyserRef, nombreEnColonne } from "@/lib/artifact/object-model/model";
import { normaliserTexte } from "@/lib/artifact/object-model/text";
import type { CommandeArtefact } from "@/lib/artifact/commands/ir";
import { type AdaptateurArtefact, type DesignationImage, type DocumentOuvert, type EffetCommande, type ExtractionImage, type RessourceBinaire, type Validation, effetEchec, effetOk, extractionEchec } from "@/lib/artifact/adapters/contract";
import { resoudre } from "@/lib/artifact/commands/resolve";
import { lireImage, tailleInsertion } from "@/lib/artifact/object-model/image";
import { detacherDessinSiVide, enregistrerDessin, octetsDeLImageFeuille, ouvrirDessinFeuille, poserImageFeuille, poserMediaDessin, redimensionnerImageFeuille, repointerImageFeuille, retirerImageFeuille } from "@/lib/artifact/adapters/xlsx/media";
import { type XmlNode, attr, child, children, cloneNode, element, ensureChild, insertBefore, markDirty, parseXml, removeChild, serializeXml, setAttr, textNode, textOf } from "@/lib/artifact/object-model/xml";
import { type StylesClasseur, styleDeXf, valeurCellule, lireChainesPartagees, lireStyles } from "./lecture";
import { deriverStyle } from "./styles-derives";
import { decalerFormule } from "./formules";

export const MIME_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** Combien de cellules on modélise par feuille — au-delà, l'aperçu se charge à la demande (§71). */
const CELLULES_MODELE_MAX = 20_000;

interface Feuille {
  nom: string;
  chemin: string;
  racine: XmlNode;
  /** L'élément `worksheet` lui-même — c'est LUI qui porte `<drawing>`, pas la racine du document. */
  ws: XmlNode;
  sheetData: XmlNode;
}

// ─────────────────────────── Le document ouvert ───────────────────────────

class XlsxOuvert implements DocumentOuvert {
  format = "XLSX" as const;
  private modeleCache: XlsxModel | null = null;
  /** Les octets que le moteur a résolus pour le lot en cours (§104.9) — voir `contract.ts`. */
  private ressources: ReadonlyMap<string, RessourceBinaire> = new Map();

  constructor(
    private zip: PizZip,
    private workbook: XmlNode,
    private feuilles: Feuille[],
    private chaines: string[],
    private styles: StylesClasseur | null,
  ) {}

  fournirRessources(res: ReadonlyMap<string, RessourceBinaire>): void {
    this.ressources = res;
  }

  modele(): XlsxModel {
    if (this.modeleCache) return this.modeleCache;
    const sheets: SheetNode[] = this.feuilles.map((f, i) => this.lireFeuille(f, i + 1));
    this.modeleCache = { kind: "XLSX", sheets };
    return this.modeleCache;
  }

  private lireFeuille(f: Feuille, index: number): SheetNode {
    const cells: SheetCellNode[] = [];
    let maxRow = 0;
    let maxCol = 0;
    for (const row of children(f.sheetData, "row")) {
      for (const c of children(row, "c")) {
        const ref = attr(c, "r") ?? "";
        const pos = analyserRef(ref);
        if (!pos) continue;
        maxRow = Math.max(maxRow, pos.row);
        maxCol = Math.max(maxCol, pos.col);
        if (cells.length >= CELLULES_MODELE_MAX) continue;
        const fEl = child(c, "f");
        const s = Number(attr(c, "s") ?? "0");
        const deco = styleDeXf(this.styles, Number.isFinite(s) ? s : 0);
        const valeur = valeurCellule(c, this.chaines);
        if (!valeur && !fEl && !attr(c, "s")) continue; // cellule vide et sans style : rien à dire.
        cells.push({
          id: `s${index}.${ref}`, ref, row: pos.row, col: pos.col,
          value: valeur, formula: fEl ? `=${textOf(fEl)}` : null,
          numFmt: deco.numFmt, style: deco.style, fill: deco.fill, align: deco.align,
        });
      }
    }
    const cols = child(f.racine, "worksheet") ? child(child(f.racine, "worksheet")!, "cols") : null;
    const largeurs: (number | null)[] = [];
    if (cols) {
      for (const col of children(cols, "col")) {
        const min = Number(attr(col, "min") ?? "1");
        const max = Number(attr(col, "max") ?? String(min));
        const w = Number(attr(col, "width"));
        for (let k = min; k <= Math.min(max, 200); k += 1) largeurs[k - 1] = Number.isFinite(w) ? w : null;
      }
    }
    const ws = child(f.racine, "worksheet");
    const sheetViews = ws ? child(ws, "sheetViews") : null;
    const pane = sheetViews ? child(children(sheetViews, "sheetView")[0] ?? element("x"), "pane") : null;
    const merges = ws ? children(child(ws, "mergeCells") ?? element("x"), "mergeCell").map((m) => attr(m, "ref") ?? "").filter(Boolean) : [];

    const images: SheetImageNode[] = (ouvrirDessinFeuille(this.zip, f.chemin, f.ws)?.images ?? [])
      .map((i) => ({
        id: `s${index}.img${i.index}`, index: i.index, name: i.nom, anchorRef: i.ancre,
        widthCm: i.largeurCm, heightCm: i.hauteurCm, description: i.description,
      }));

    return {
      id: `s${index}`, index, name: f.nom, rows: maxRow, cols: maxCol, cells, images,
      columnWidths: largeurs,
      frozenRows: pane ? Number(attr(pane, "ySplit") ?? "0") || 0 : 0,
      frozenCols: pane ? Number(attr(pane, "xSplit") ?? "0") || 0 : 0,
      merges,
    };
  }

  appliquer(c: CommandeArtefact): EffetCommande {
    const effet = this.executer(c);
    if (effet.ok) this.modeleCache = null;
    return effet;
  }

  /** La feuille visée : celle qui est nommée, sinon la première. */
  private feuille(nom: string | null): Feuille | null {
    if (!nom) return this.feuilles[0] ?? null;
    const cible = normaliserTexte(nom);
    return this.feuilles.find((f) => normaliserTexte(f.nom) === cible)
      ?? this.feuilles.find((f) => normaliserTexte(f.nom).includes(cible))
      ?? null;
  }

  private executer(c: CommandeArtefact): EffetCommande {
    const f = this.feuille(c.feuille);
    if (!f && c.op !== "xlsx.ajouter_feuille") {
      return effetEchec(c.feuille ? `ce classeur n'a pas de feuille « ${c.feuille} »` : "ce classeur n'a aucune feuille");
    }
    switch (c.op) {
      case "xlsx.valeur": return this.valeur(f!, c, false);
      case "xlsx.formule": return this.valeur(f!, c, true);
      case "xlsx.format": return this.mettreEnForme(f!, c);
      case "xlsx.largeur_colonne": return this.largeurColonne(f!, c);
      case "xlsx.inserer_ligne": return this.insererLigne(f!, c);
      case "xlsx.supprimer_ligne": return this.supprimerLigne(f!, c);
      case "xlsx.inserer_colonne": return this.insererColonne(f!, c);
      case "xlsx.supprimer_colonne": return this.supprimerColonne(f!, c);
      case "xlsx.figer": return this.figer(f!, c);
      case "xlsx.fusionner": return this.fusionner(f!, c);
      case "xlsx.trier": return this.trier(f!, c);
      case "xlsx.ajouter_feuille": return this.ajouterFeuille(c);
      case "xlsx.renommer_feuille": return this.renommerFeuille(f!, c);
      case "xlsx.supprimer_feuille": return this.supprimerFeuille(f!);
      case "xlsx.inserer_image": return this.insererImage(f!, c);
      case "xlsx.remplacer_image": return this.remplacerImage(f!, c);
      case "xlsx.supprimer_image": return this.supprimerImage(f!, c);
      default: return effetEchec(`opération « ${c.op} » non gérée par l'adaptateur Excel`);
    }
  }

  // ── Accès aux lignes et cellules ────────────────────────────────────────────────────
  /** La `<row>` de ce rang, créée à sa place si elle manque (les lignes sont triées). */
  private ligne(f: Feuille, r: number): XmlNode {
    const lignes = children(f.sheetData, "row");
    const existante = lignes.find((x) => Number(attr(x, "r")) === r);
    if (existante) return existante;
    const nouvelle = element("row", { r: String(r) });
    const suivante = lignes.find((x) => Number(attr(x, "r")) > r);
    if (suivante) insertBefore(f.sheetData, suivante, nouvelle);
    else { nouvelle.parent = f.sheetData; f.sheetData.children.push(nouvelle); markDirty(f.sheetData); }
    nouvelle.selfClosing = false;
    return nouvelle;
  }

  /** La `<c>` de cette référence, créée à sa place (les cellules sont triées par colonne). */
  private cellule(f: Feuille, row: number, col: number): XmlNode {
    const ref = formerRef(row, col);
    const l = this.ligne(f, row);
    const cs = children(l, "c");
    const existante = cs.find((x) => attr(x, "r") === ref);
    if (existante) return existante;
    const nouvelle = element("c", { r: ref });
    const suivante = cs.find((x) => (analyserRef(attr(x, "r") ?? "")?.col ?? 0) > col);
    if (suivante) insertBefore(l, suivante, nouvelle);
    else { nouvelle.parent = l; l.children.push(nouvelle); markDirty(l); }
    nouvelle.selfClosing = false;
    return nouvelle;
  }

  private valeur(f: Feuille, c: CommandeArtefact, estFormule: boolean): EffetCommande {
    const plage = analyserPlage(c.plage ?? "");
    if (!plage) return effetEchec(`plage « ${c.plage } » illisible`);
    const cases = cellulesDePlage(plage);
    for (const pos of cases) {
      const cell = this.cellule(f, pos.row, pos.col);
      // On vide d'abord : une cellule qui garderait son `<f>` recalculerait par-dessus la valeur
      // qu'on vient d'écrire, et l'utilisateur verrait sa saisie « revenir » à l'ouverture.
      for (const nom of ["v", "f", "is"]) {
        const el = child(cell, nom);
        if (el) removeChild(cell, el);
      }
      cell.attrs.delete("t");
      markDirty(cell);
      if (estFormule) {
        const formule = (c.formule ?? "").replace(/^=/, "");
        const fEl = element("f", {}, [textNode(formule)]);
        fEl.parent = cell;
        cell.children.push(fEl);
        // Pas de `<v>` : sans valeur mise en cache, Excel recalcule à l'ouverture — c'est
        // exactement ce qu'on veut, et cela évite d'afficher un résultat périmé.
      } else {
        const brut = c.texte ?? "";
        const nombre = brut.trim() !== "" && Number.isFinite(Number(brut.replace(",", ".")));
        if (nombre) {
          const v = element("v", {}, [textNode(String(Number(brut.replace(",", "."))))]);
          v.parent = cell;
          cell.children.push(v);
        } else if (brut !== "") {
          setAttr(cell, "t", "inlineStr");
          const t = element("t", { "xml:space": "preserve" }, [textNode(brut)]);
          const is = element("is", {}, [t]);
          is.parent = cell;
          cell.children.push(is);
        }
      }
      cell.selfClosing = cell.children.length === 0;
    }
    // Le cache de calcul devient faux dès qu'une valeur bouge : le retirer force le recalcul.
    this.invaliderCache();
    const quoi = estFormule ? c.formule : c.texte;
    return effetOk(`${f.nom}!${c.plage} → ${cases.length > 1 ? `${cases.length} cellules` : `« ${quoi} »`}.`, cases.map((p) => `${f.nom}!${formerRef(p.row, p.col)}`));
  }

  /** Supprime `calcChain.xml`, dont l'ordre devient faux dès qu'une formule change. */
  private invaliderCache(): void {
    if (this.zip.file("xl/calcChain.xml")) this.zip.remove("xl/calcChain.xml");
  }

  private mettreEnForme(f: Feuille, c: CommandeArtefact): EffetCommande {
    if (!this.styles) return effetEchec("ce classeur n'a pas de table de styles : impossible de le mettre en forme");
    const plage = analyserPlage(c.plage ?? "");
    if (!plage) return effetEchec(`plage « ${c.plage} » illisible`);
    const cases = cellulesDePlage(plage);
    for (const pos of cases) {
      const cell = this.cellule(f, pos.row, pos.col);
      const actuel = Number(attr(cell, "s") ?? "0");
      const nouveau = deriverStyle(this.styles!, Number.isFinite(actuel) ? actuel : 0, c);
      setAttr(cell, "s", String(nouveau));
    }
    return effetOk(`${f.nom}!${c.plage} mis en forme (${cases.length} cellule${cases.length > 1 ? "s" : ""}).`, cases.map((p) => `${f.nom}!${formerRef(p.row, p.col)}`));
  }

  private largeurColonne(f: Feuille, c: CommandeArtefact): EffetCommande {
    const ws = child(f.racine, "worksheet");
    if (!ws) return effetEchec("feuille illisible");
    // `cols` doit venir AVANT `sheetData` : Excel refuse le fichier autrement.
    let cols = child(ws, "cols");
    if (!cols) {
      cols = element("cols");
      cols.parent = ws;
      const sd = child(ws, "sheetData");
      if (sd) insertBefore(ws, sd, cols);
      else { ws.children.push(cols); markDirty(ws); }
    }
    // Excel exprime la largeur en CARACTÈRES ; un centimètre vaut environ 4,7 caractères.
    const largeur = c.taillePt ?? (c.largeurCm !== null ? Math.round(c.largeurCm * 4.7 * 100) / 100 : 12);
    const n = String(c.colonne);
    const existant = children(cols, "col").find((x) => attr(x, "min") === n && attr(x, "max") === n);
    const col = existant ?? element("col", { min: n, max: n });
    setAttr(col, "width", String(largeur));
    setAttr(col, "customWidth", "1");
    if (!existant) { col.parent = cols; cols.children.push(col); cols.selfClosing = false; markDirty(cols); }
    return effetOk(`Colonne ${nombreEnColonne(c.colonne ?? 1)} de ${f.nom} → largeur ${largeur}.`, []);
  }

  /**
   * DÉCALE toutes les références d'une feuille après une insertion / suppression.
   *
   * Les attributs `r` des lignes et des cellules d'abord, PUIS les formules. Sans le second
   * temps, `=SOMME(B2:B10)` continuerait de pointer une plage qui a changé de sens — l'erreur
   * la plus coûteuse d'un tableur, parce qu'elle donne un nombre plausible et faux.
   *
   * Ce décaleur traite les références A1 de la MÊME feuille. Les références inter-feuilles
   * (`Feuil2!B4`) et `INDIRECT` ne sont pas réécrites — Excel non plus ne réécrit pas `INDIRECT`.
   */
  private decaler(f: Feuille, axe: "ligne" | "colonne", depuis: number, delta: number): void {
    for (const row of children(f.sheetData, "row")) {
      const r = Number(attr(row, "r"));
      if (axe === "ligne" && Number.isFinite(r) && r >= depuis) setAttr(row, "r", String(r + delta));
      for (const cell of children(row, "c")) {
        const pos = analyserRef(attr(cell, "r") ?? "");
        if (!pos) continue;
        const nr = axe === "ligne" && pos.row >= depuis ? pos.row + delta : pos.row;
        const nc = axe === "colonne" && pos.col >= depuis ? pos.col + delta : pos.col;
        if (nr !== pos.row || nc !== pos.col) setAttr(cell, "r", formerRef(nr, nc));
        const fEl = child(cell, "f");
        if (fEl) {
          const reecrite = decalerFormule(textOf(fEl), axe, depuis, delta);
          fEl.children = [textNode(reecrite)];
          fEl.children[0].parent = fEl;
          markDirty(fEl);
        }
      }
    }
    this.invaliderCache();
  }

  private insererLigne(f: Feuille, c: CommandeArtefact): EffetCommande {
    const r = c.ligne ?? 1;
    this.decaler(f, "ligne", r, 1);
    return effetOk(`Ligne insérée en position ${r} dans ${f.nom}.`, []);
  }

  private supprimerLigne(f: Feuille, c: CommandeArtefact): EffetCommande {
    const r = c.ligne ?? 1;
    const cible = children(f.sheetData, "row").find((x) => Number(attr(x, "r")) === r);
    if (!cible) return effetEchec(`la ligne ${r} de ${f.nom} est déjà vide`);
    removeChild(f.sheetData, cible);
    this.decaler(f, "ligne", r + 1, -1);
    return effetOk(`Ligne ${r} de ${f.nom} supprimée.`, []);
  }

  private insererColonne(f: Feuille, c: CommandeArtefact): EffetCommande {
    const col = c.colonne ?? 1;
    this.decaler(f, "colonne", col, 1);
    return effetOk(`Colonne ${nombreEnColonne(col)} insérée dans ${f.nom}.`, []);
  }

  private supprimerColonne(f: Feuille, c: CommandeArtefact): EffetCommande {
    const col = c.colonne ?? 1;
    for (const row of children(f.sheetData, "row")) {
      const cible = children(row, "c").find((x) => analyserRef(attr(x, "r") ?? "")?.col === col);
      if (cible) removeChild(row, cible);
    }
    this.decaler(f, "colonne", col + 1, -1);
    return effetOk(`Colonne ${nombreEnColonne(col)} de ${f.nom} supprimée.`, []);
  }

  private figer(f: Feuille, c: CommandeArtefact): EffetCommande {
    const ws = child(f.racine, "worksheet");
    if (!ws) return effetEchec("feuille illisible");
    // `sheetViews` doit précéder `sheetData` — même contrainte d'ordre que `cols`.
    let views = child(ws, "sheetViews");
    if (!views) {
      views = element("sheetViews", {}, [element("sheetView", { workbookViewId: "0" })]);
      views.parent = ws;
      const sd = child(ws, "sheetData");
      if (sd) insertBefore(ws, sd, views);
      else { ws.children.push(views); markDirty(ws); }
    }
    const view = children(views, "sheetView")[0] ?? ensureChild(views, "sheetView", []);
    const x = c.colonne ?? 0;
    const y = c.ligne ?? 0;
    const pane = ensureChild(view, "pane", []);
    if (x) setAttr(pane, "xSplit", String(x)); else pane.attrs.delete("xSplit");
    if (y) setAttr(pane, "ySplit", String(y)); else pane.attrs.delete("ySplit");
    setAttr(pane, "topLeftCell", formerRef(y + 1, x + 1));
    setAttr(pane, "activePane", "bottomRight");
    setAttr(pane, "state", "frozen");
    return effetOk(`${f.nom} : ${y} ligne(s) et ${x} colonne(s) figées.`, []);
  }

  private fusionner(f: Feuille, c: CommandeArtefact): EffetCommande {
    const ws = child(f.racine, "worksheet");
    if (!ws) return effetEchec("feuille illisible");
    // `mergeCells` se place APRÈS `sheetData` : l'ordre du schéma, là encore.
    let merges = child(ws, "mergeCells");
    if (!merges) {
      merges = element("mergeCells", { count: "0" });
      merges.parent = ws;
      const sd = child(ws, "sheetData");
      const i = sd ? ws.children.indexOf(sd) + 1 : ws.children.length;
      ws.children.splice(i, 0, merges);
      markDirty(ws);
    }
    const ref = (c.plage ?? "").toUpperCase();
    if (children(merges, "mergeCell").some((m) => attr(m, "ref") === ref)) {
      return effetEchec(`${ref} est déjà fusionnée`);
    }
    const m = element("mergeCell", { ref });
    m.parent = merges;
    merges.children.push(m);
    merges.selfClosing = false;
    setAttr(merges, "count", String(children(merges, "mergeCell").length));
    markDirty(merges);
    return effetOk(`${f.nom}!${ref} fusionnée.`, []);
  }

  private trier(f: Feuille, c: CommandeArtefact): EffetCommande {
    const plage = analyserPlage(c.plage ?? "");
    if (!plage) return effetEchec(`plage « ${c.plage} » illisible`);
    const colTri = plage.from.col + (c.colonne ?? 1) - 1;
    if (colTri > plage.to.col) return effetEchec(`la colonne de tri ${c.colonne} sort de la plage`);
    const descendant = (c.direction ?? "").toLowerCase().startsWith("desc") || c.ordre?.[0] === -1;

    // On déplace les CELLULES entières (valeur, formule, style) et pas seulement les valeurs :
    // trier un tableau en laissant les couleurs sur place produit un tableau faux à l'œil.
    const lignes: { cle: string; cellules: Map<number, XmlNode> }[] = [];
    for (let r = plage.from.row; r <= plage.to.row; r += 1) {
      const row = children(f.sheetData, "row").find((x) => Number(attr(x, "r")) === r);
      const cellules = new Map<number, XmlNode>();
      let cle = "";
      if (row) {
        for (const cell of children(row, "c")) {
          const pos = analyserRef(attr(cell, "r") ?? "");
          if (!pos || pos.col < plage.from.col || pos.col > plage.to.col) continue;
          cellules.set(pos.col, cloneNode(cell));
          if (pos.col === colTri) cle = valeurCellule(cell, this.chaines);
        }
      }
      lignes.push({ cle, cellules });
    }
    const nombre = (s: string): number => Number(s.replace(/\s/g, "").replace(",", "."));
    lignes.sort((a, b) => {
      const na = nombre(a.cle);
      const nb = nombre(b.cle);
      const cmp = Number.isFinite(na) && Number.isFinite(nb) && a.cle.trim() && b.cle.trim()
        ? na - nb
        : a.cle.localeCompare(b.cle, "fr", { numeric: true, sensitivity: "base" });
      return descendant ? -cmp : cmp;
    });

    lignes.forEach((l, i) => {
      const r = plage.from.row + i;
      for (let col = plage.from.col; col <= plage.to.col; col += 1) {
        const cible = this.cellule(f, r, col);
        const source = l.cellules.get(col);
        cible.children = source ? source.children.map((x) => cloneNode(x, cible)) : [];
        cible.attrs = new Map(source ? source.attrs : new Map());
        setAttr(cible, "r", formerRef(r, col));
        cible.selfClosing = cible.children.length === 0;
        markDirty(cible);
      }
    });
    this.invaliderCache();
    return effetOk(`${f.nom}!${c.plage} trié sur la colonne ${c.colonne} (${descendant ? "décroissant" : "croissant"}).`, []);
  }

  private ajouterFeuille(c: CommandeArtefact): EffetCommande {
    const nom = (c.nom ?? "").slice(0, 31);
    if (this.feuilles.some((f) => normaliserTexte(f.nom) === normaliserTexte(nom))) {
      return effetEchec(`ce classeur a déjà une feuille « ${nom} »`);
    }
    const sheets = child(this.workbook, "workbook") ? child(child(this.workbook, "workbook")!, "sheets") : null;
    if (!sheets) return effetEchec("classeur illisible : liste des feuilles introuvable");

    // Un identifiant de relation et un numéro de fichier qui ne collisionnent avec RIEN.
    const numeros = Object.keys(this.zip.files)
      .map((f) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(f))
      .filter(Boolean)
      .map((m) => Number(m![1]));
    const num = (numeros.length ? Math.max(...numeros) : 0) + 1;
    const rels = this.zip.file("xl/_rels/workbook.xml.rels");
    if (!rels) return effetEchec("classeur illisible : relations introuvables");
    const relsRacine = parseXml(rels.asText());
    const relsEl = child(relsRacine, "Relationships");
    if (!relsEl) return effetEchec("classeur illisible : relations vides");
    const ids = children(relsEl, "Relationship").map((r) => Number((attr(r, "Id") ?? "").replace(/\D/g, "")) || 0);
    const rId = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
    const rel = element("Relationship", {
      Id: rId,
      Type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet",
      Target: `worksheets/sheet${num}.xml`,
    });
    rel.parent = relsEl;
    relsEl.children.push(rel);
    markDirty(relsEl);
    this.zip.file("xl/_rels/workbook.xml.rels", serializeXml(relsRacine));

    const sheetIds = children(sheets, "sheet").map((s) => Number(attr(s, "sheetId")) || 0);
    const feuilleEl = element("sheet", { name: nom, sheetId: String((sheetIds.length ? Math.max(...sheetIds) : 0) + 1), "r:id": rId });
    feuilleEl.parent = sheets;
    sheets.children.push(feuilleEl);
    sheets.selfClosing = false;
    markDirty(sheets);

    const chemin = `xl/worksheets/sheet${num}.xml`;
    const contenu = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData/></worksheet>`;
    this.zip.file(chemin, contenu);
    // `[Content_Types].xml` doit DÉCLARER la nouvelle feuille, sinon Excel dit « fichier illisible ».
    const ct = this.zip.file("[Content_Types].xml");
    if (ct) {
      const ctRacine = parseXml(ct.asText());
      const types = child(ctRacine, "Types");
      if (types) {
        const o = element("Override", {
          PartName: `/${chemin}`,
          ContentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml",
        });
        o.parent = types;
        types.children.push(o);
        markDirty(types);
        this.zip.file("[Content_Types].xml", serializeXml(ctRacine));
      }
    }
    const racine = parseXml(contenu);
    const ws = child(racine, "worksheet")!;
    this.feuilles.push({ nom, chemin, racine, ws, sheetData: child(ws, "sheetData")! });
    return effetOk(`Feuille « ${nom} » ajoutée.`, []);
  }

  private renommerFeuille(f: Feuille, c: CommandeArtefact): EffetCommande {
    const sheets = child(this.workbook, "workbook") ? child(child(this.workbook, "workbook")!, "sheets") : null;
    if (!sheets) return effetEchec("classeur illisible");
    const el = children(sheets, "sheet").find((s) => attr(s, "name") === f.nom);
    if (!el) return effetEchec(`feuille « ${f.nom} » introuvable dans le classeur`);
    const nom = (c.nom ?? "").slice(0, 31);
    setAttr(el, "name", nom);
    const ancien = f.nom;
    f.nom = nom;
    return effetOk(`Feuille « ${ancien} » renommée « ${nom} ».`, []);
  }

  private supprimerFeuille(f: Feuille): EffetCommande {
    if (this.feuilles.length <= 1) return effetEchec("un classeur doit garder au moins une feuille");
    const sheets = child(this.workbook, "workbook") ? child(child(this.workbook, "workbook")!, "sheets") : null;
    if (!sheets) return effetEchec("classeur illisible");
    const el = children(sheets, "sheet").find((s) => attr(s, "name") === f.nom);
    if (el) removeChild(sheets, el);
    this.feuilles = this.feuilles.filter((x) => x !== f);
    // On laisse le fichier de feuille dans le ZIP : le retirer casserait les identifiants de
    // relation des feuilles suivantes. Excel ignore une pièce qui n'est plus référencée.
    return effetOk(`Feuille « ${f.nom} » supprimée.`, []);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * LES IMAGES D'UN CLASSEUR — « mets le logo Adventum en B2 de la feuille Synthèse ».
   *
   * ── LA LARGEUR SUR LAQUELLE ON BORNE, ET POURQUOI CELLE-LÀ ────────────────────────────
   *
   * Une feuille n'a pas de bord : elle s'étend indéfiniment vers la droite, donc une image
   * large n'y est jamais « coupée » à l'écran. Mais un classeur S'IMPRIME, et là il y a un
   * bord — la zone d'impression, que le fichier DÉCLARE (`pageSetup`, `pageMargins`). C'est
   * sur elle qu'on borne une image dont personne n'a donné la taille : au-delà, l'image sort
   * de la page à l'impression, et cela ne se découvre qu'une fois le classeur imprimé.
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  private largeurImprimableCm(f: Feuille): number {
    // Formats de papier OOXML, en centimètres, portrait. Ce qu'on ne connaît pas retombe sur A4 :
    // c'est le papier du pays, et se tromper de format ne fait que borner un peu plus ou un peu moins.
    const PAPIERS: Record<number, [number, number]> = {
      1: [21.59, 27.94], // Letter
      5: [21.59, 35.56], // Legal
      8: [29.7, 42.0], // A3
      9: [21.0, 29.7], // A4
      11: [14.8, 21.0], // A5
    };
    const setup = child(f.ws, "pageSetup");
    const marges = child(f.ws, "pageMargins");
    const papier = PAPIERS[Number(setup ? attr(setup, "paperSize") : NaN)] ?? PAPIERS[9];
    const paysage = (setup ? attr(setup, "orientation") : null) === "landscape";
    const largeurPapier = paysage ? papier[1] : papier[0];
    // Les marges sont en POUCES dans OOXML ; la valeur par défaut d'Excel est 0,7 pouce.
    const pouce = 2.54;
    const gauche = Number(marges ? attr(marges, "left") : NaN);
    const droite = Number(marges ? attr(marges, "right") : NaN);
    const perdu = ((Number.isFinite(gauche) ? gauche : 0.7) + (Number.isFinite(droite) ? droite : 0.7)) * pouce;
    return Math.max(2, largeurPapier - perdu);
  }

  /** La cellule d'ancrage demandée — « B2 », ou ligne + colonne, ou A1 par défaut. */
  private ancrage(c: CommandeArtefact): { ligne: number; colonne: number } {
    const p = c.plage ? analyserPlage(c.plage) : null;
    if (p) return { ligne: p.from.row, colonne: p.from.col };
    return { ligne: c.ligne ?? 1, colonne: c.colonne ?? 1 };
  }

  /**
   * DÉSIGNER une image d'une feuille. Le texte cherché réunit le NOM, la DESCRIPTION et la
   * CELLULE : la personne dit « le logo », « la photo du produit » ou « l'image en B2 », et les
   * trois doivent atteindre le même objet.
   */
  private ciblerImage(f: Feuille, c: { cible: CommandeArtefact["cible"] }) {
    const dessin = ouvrirDessinFeuille(this.zip, f.chemin, f.ws);
    if (!dessin || dessin.images.length === 0) {
      return { ok: false as const, echec: effetEchec(`la feuille « ${f.nom} » ne contient aucune image`) };
    }
    // L'IDENTIFIANT EST CELUI DU MODÈLE, pas un autre : c'est celui que le workspace renvoie
    // quand la personne clique sur l'image. Deux identifiants pour le même objet feraient
    // échouer le clic — le geste le plus sûr de tous (§104.7) — au profit du texte.
    const rang = this.feuilles.indexOf(f) + 1;
    const designables = dessin.images.map((i) => ({
      id: `s${rang}.img${i.index}`, index: i.index,
      texte: [i.nom, i.description ?? "", i.ancre ?? ""].join(" ").trim(),
      image: i,
    }));
    const r = resoudre(c.cible, designables, { libelle: "image" });
    if (r.etat === "TROUVE") return { ok: true as const, dessin, i: r.objet.image, id: r.objet.id };
    const candidats = r.etat === "AMBIGU"
      ? r.candidats.map((x) => ({
        id: x.id,
        libelle: x.image.ancre ? `${x.image.nom} (${x.image.ancre})` : x.image.nom,
      }))
      : [];
    return { ok: false as const, echec: effetEchec(r.motif, candidats) };
  }

  private insererImage(f: Feuille, c: CommandeArtefact): EffetCommande {
    const ref = c.imageSource ?? "";
    const res = this.ressources.get(ref);
    if (!res) {
      return effetEchec(`le fichier source « ${ref} » n'a pas pu être lu (introuvable, ou vous n'y avez pas accès)`);
    }
    const img = lireImage(res.octets);
    if (!img) {
      return effetEchec(
        `« ${res.nom} » n'est pas une image qu'Excel sache afficher `
        + "(formats acceptés : PNG, JPEG, GIF, BMP, TIFF, WEBP)",
      );
    }
    const a = this.ancrage(c);
    const taille = tailleInsertion(img, { largeurCm: c.largeurCm, hauteurCm: c.hauteurCm }, this.largeurImprimableCm(f));

    let pose;
    try {
      pose = poserImageFeuille(this.zip, f.chemin, f.ws, res.octets, img, {
        ligne: a.ligne, colonne: a.colonne,
        largeurCm: taille.largeurCm, hauteurCm: taille.hauteurCm,
        nom: res.nom, alt: c.imageAlt ?? null,
      });
    } catch (e) {
      return effetEchec(`l'image n'a pas pu être rangée dans le classeur : ${(e as Error).message}`);
    }
    return effetOk(
      `Image « ${res.nom} » posée en ${formerRef(a.ligne, a.colonne)} de ${f.nom}, `
      + `${taille.largeurCm.toFixed(1)} × ${taille.hauteurCm.toFixed(1)} cm.`,
      [`${f.nom}.img${pose.ancrages}`],
    );
  }

  private remplacerImage(f: Feuille, c: CommandeArtefact): EffetCommande {
    const ref = c.imageSource ?? "";
    const res = this.ressources.get(ref);
    if (!res) return effetEchec(`le fichier source « ${ref} » n'a pas pu être lu (introuvable, ou vous n'y avez pas accès)`);
    const img = lireImage(res.octets);
    if (!img) return effetEchec(`« ${res.nom} » n'est pas une image qu'Excel sache afficher`);

    const t = this.ciblerImage(f, c);
    if (!t.ok) return t.echec;

    let pose;
    try {
      pose = poserMediaDessin(this.zip, t.dessin.chemin, res.octets, img);
    } catch (e) {
      return effetEchec(`l'image n'a pas pu être rangée dans le classeur : ${(e as Error).message}`);
    }
    if (!repointerImageFeuille(t.i.pic, pose.rId)) {
      return effetEchec("cet objet n'est pas une image incorporée (c'est peut-être une forme ou un graphique)");
    }

    // MÊME RÈGLE QUE WORD : la taille ne bouge pas sans demande, et une déformation s'ANNONCE
    // plutôt que de se corriger dans le dos de la personne.
    const rapportAvant = t.i.hauteurCm > 0 ? t.i.largeurCm / t.i.hauteurCm : null;
    const rapportApres = img.largeurPx / img.hauteurPx;
    const deforme = rapportAvant !== null && Math.abs(rapportAvant - rapportApres) / rapportApres > 0.02;

    if (c.largeurCm !== null || c.hauteurCm !== null) {
      const taille = tailleInsertion(img, { largeurCm: c.largeurCm, hauteurCm: c.hauteurCm }, this.largeurImprimableCm(f));
      redimensionnerImageFeuille(t.i, taille.largeurCm, taille.hauteurCm);
      enregistrerDessin(this.zip, t.dessin);
      return effetOk(
        `Image ${t.i.index} de ${f.nom} remplacée par « ${res.nom} », `
        + `${taille.largeurCm.toFixed(1)} × ${taille.hauteurCm.toFixed(1)} cm.`,
        [t.id],
      );
    }
    enregistrerDessin(this.zip, t.dessin);
    return effetOk(
      `Image ${t.i.index} de ${f.nom} remplacée par « ${res.nom} », même cellule et même taille.`
      + (deforme ? " Attention : la nouvelle image n'a pas les mêmes proportions — elle sera étirée tant qu'on ne redonne pas de taille." : ""),
      [t.id],
    );
  }

  private supprimerImage(f: Feuille, c: CommandeArtefact): EffetCommande {
    const t = this.ciblerImage(f, c);
    if (!t.ok) return t.echec;
    if (!retirerImageFeuille(t.dessin, t.i)) return effetEchec("cette image est détachée du dessin de la feuille");
    t.dessin.images = t.dessin.images.filter((x) => x !== t.i);
    enregistrerDessin(this.zip, t.dessin);
    detacherDessinSiVide(this.zip, f.chemin, f.ws, t.dessin);
    const ou = t.i.ancre ? ` (${t.i.ancre})` : "";
    return effetOk(`Image ${t.i.index}${ou} supprimée de ${f.nom}.`, []);
  }

  /**
   * SORT LES OCTETS d'une image d'une feuille — pour la lire. Le tampon d'un bon de commande
   * scanné collé dans un onglet, le graphique exporté d'un autre outil : le classeur PORTE
   * l'information, et aucune cellule n'en dit rien.
   */
  async extraireImage(d: DesignationImage): Promise<ExtractionImage> {
    const f = this.feuille(d.feuille);
    if (!f) {
      return extractionEchec(d.feuille ? `ce classeur n'a pas de feuille « ${d.feuille} »` : "ce classeur n'a aucune feuille");
    }
    const t = this.ciblerImage(f, d);
    if (!t.ok) return extractionEchec(t.echec.motif ?? "image introuvable", t.echec.candidats);
    const oct = octetsDeLImageFeuille(this.zip, t.dessin.chemin, t.i.pic);
    if (!oct) {
      return extractionEchec(
        "cette image n'est pas incorporée dans le classeur (elle est liée à un fichier extérieur) : il n'y a pas d'octets à lire ici",
      );
    }
    return {
      ok: true,
      image: {
        octets: oct.octets,
        nom: oct.nom,
        description: t.i.description,
        ou: t.i.ancre ? `feuille ${f.nom}, image en ${t.i.ancre}` : `feuille ${f.nom}, image ${t.i.index}`,
      },
    };
  }

  async serialiser(): Promise<Buffer> {
    this.zip.file("xl/workbook.xml", serializeXml(this.workbook));
    for (const f of this.feuilles) this.zip.file(f.chemin, serializeXml(f.racine));
    if (this.styles) this.zip.file("xl/styles.xml", serializeXml(this.styles.racine));
    return this.zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  }

  async valider(): Promise<Validation> {
    const problemes: string[] = [];
    try {
      const octets = await this.serialiser();
      const relu = new PizZip(octets);
      for (const requis of ["[Content_Types].xml", "xl/workbook.xml"]) {
        if (!relu.file(requis)) problemes.push(`pièce obligatoire perdue : ${requis}`);
      }
      for (const f of this.feuilles) {
        const el = relu.file(f.chemin);
        if (!el) { problemes.push(`feuille perdue : ${f.chemin}`); continue; }
        const xml = el.asText();
        if (!xml.includes("<sheetData")) problemes.push(`${f.nom} : données de feuille absentes`);
      }
    } catch (e) {
      problemes.push(`le classeur produit ne se relit pas : ${(e as Error).message}`);
    }
    return { ok: problemes.length === 0, problemes };
  }
}

export const adaptateurXlsx: AdaptateurArtefact = {
  format: "XLSX",
  mimes: [MIME_XLSX],
  extensions: [".xlsx", ".xlsm"],
  async ouvrir(octets: Buffer): Promise<DocumentOuvert> {
    const zip = new PizZip(octets);
    const wbFichier = zip.file("xl/workbook.xml");
    if (!wbFichier) throw new Error("Ce fichier .xlsx ne contient pas xl/workbook.xml — il est probablement endommagé.");
    const workbook = parseXml(wbFichier.asText());
    const wb = child(workbook, "workbook");
    const sheets = wb ? child(wb, "sheets") : null;
    if (!sheets) throw new Error("Ce classeur ne déclare aucune feuille.");

    // rId → chemin de la feuille, lu dans les relations du classeur.
    const relsFichier = zip.file("xl/_rels/workbook.xml.rels");
    const cheminParId = new Map<string, string>();
    if (relsFichier) {
      const relsRacine = parseXml(relsFichier.asText());
      const relsEl = child(relsRacine, "Relationships");
      for (const r of relsEl ? children(relsEl, "Relationship") : []) {
        const id = attr(r, "Id");
        const cible = attr(r, "Target");
        if (id && cible) cheminParId.set(id, cible.startsWith("/") ? cible.slice(1) : `xl/${cible.replace(/^\.\//, "")}`);
      }
    }

    const feuilles: Feuille[] = [];
    for (const s of children(sheets, "sheet")) {
      const nom = attr(s, "name") ?? `Feuille${feuilles.length + 1}`;
      const rid = attr(s, "r:id") ?? attr(s, "id") ?? "";
      const chemin = cheminParId.get(rid) ?? `xl/worksheets/sheet${feuilles.length + 1}.xml`;
      const fichier = zip.file(chemin);
      if (!fichier) continue;
      const racine = parseXml(fichier.asText());
      const ws = child(racine, "worksheet");
      if (!ws) continue;
      // Une feuille vide peut n'avoir aucun `sheetData` : on le crée pour pouvoir y écrire.
      const sheetData = child(ws, "sheetData") ?? ensureChild(ws, "sheetData", ["sheetPr", "dimension", "sheetViews", "sheetFormatPr", "cols"]);
      feuilles.push({ nom, chemin, racine, ws, sheetData });
    }
    if (feuilles.length === 0) throw new Error("Aucune feuille lisible dans ce classeur.");
    return new XlsxOuvert(zip, workbook, feuilles, lireChainesPartagees(zip), lireStyles(zip));
  },
};
