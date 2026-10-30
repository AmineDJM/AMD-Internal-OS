/**
 * L'ADAPTATEUR WORD — le DOCUMENT OUVERT (`DocxOuvert` : modèle, commandes, images, sérialisation,
 * validation) et l'adaptateur `adaptateurDocx` qui l'ouvre depuis des octets.
 */
import PizZip from "pizzip";
import { type Alignment, type DocxModel, cmEnEmu, cmEnTwip } from "@/lib/artifact/object-model/model";
import { abreger, normaliserTexte } from "@/lib/artifact/object-model/text";
import { COMMANDE_VIDE, cibleVide, type CommandeArtefact } from "@/lib/artifact/commands/ir";
import { resoudre } from "@/lib/artifact/commands/resolve";
import { type AdaptateurArtefact, type DesignationImage, type DocumentOuvert, type EffetCommande, type ExtractionImage, type RessourceBinaire, type Validation, effetEchec, effetOk, extractionEchec } from "@/lib/artifact/adapters/contract";
import { lireImage, tailleInsertion } from "@/lib/artifact/object-model/image";
import { assurerNamespacesDessin, octetsDeLImage, paragrapheImage, poserMedia, repointerImage } from "@/lib/artifact/adapters/docx/media";
import { type XmlNode, child, children, cloneNode, element, ensureChild, firstDescendant, insertAfter, insertBefore, markDirty, parseXml, removeChild, serializeXml, setAttr } from "@/lib/artifact/object-model/xml";
import { type EtatDocx, construireEtat } from "@/lib/artifact/adapters/docx/adapter/lecture";
import { libelleParagraphe, ALIGN_OOXML, pPr, ORDRE_PPR, appliquerStyleProps, rPr, remplacerTexteParagraphe, nouveauRun } from "@/lib/artifact/adapters/docx/adapter/ecriture";

export const MIME_DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

// ─────────────────────────── Le document ouvert ───────────────────────────

class DocxOuvert implements DocumentOuvert {
  format = "DOCX" as const;
  private etat: EtatDocx;
  /**
   * LES OCTETS QUE LE MOTEUR A RÉSOLUS pour le lot en cours (§104.9 : l'adaptateur ne connaît
   * pas le Drive). Vidée à chaque nouveau lot par `fournirRessources` : garder les octets d'un
   * lot précédent ferait réussir une insertion dont la source n'est plus lisible.
   */
  private ressources: ReadonlyMap<string, RessourceBinaire> = new Map();

  constructor(zip: PizZip, racine: XmlNode) {
    this.etat = construireEtat(zip, racine);
  }

  fournirRessources(res: ReadonlyMap<string, RessourceBinaire>): void {
    this.ressources = res;
  }

  modele(): DocxModel { return this.etat.modele; }

  /** Reconstruit le modèle : les rangs bougent dès qu'un paragraphe est inséré ou supprimé. */
  private rafraichir(): void {
    this.etat = construireEtat(this.etat.zip, this.etat.racine);
  }

  private designables() {
    return this.etat.paragraphes.map((x) => ({ id: x.modele.id, index: x.modele.index, texte: x.modele.text, page: x.modele.page, noeud: x.noeud, modele: x.modele }));
  }

  private designablesTables() {
    return this.etat.tables.map((x) => ({ id: x.modele.id, index: x.modele.index, texte: x.modele.header.join(" "), noeud: x.noeud, modele: x.modele }));
  }

  private designablesImages() {
    return this.etat.images.map((x) => ({ id: x.modele.id, index: x.modele.index, texte: x.modele.description ?? "", noeud: x.noeud, modele: x.modele }));
  }

  appliquer(c: CommandeArtefact): EffetCommande {
    const effet = this.executer(c);
    if (effet.ok) this.rafraichir();
    return effet;
  }

  private executer(c: CommandeArtefact): EffetCommande {
    switch (c.op) {
      case "docx.align": return this.align(c);
      case "docx.format_texte": return this.formatTexte(c);
      case "docx.espacement": return this.espacement(c);
      case "docx.retrait": return this.retrait(c);
      case "docx.texte": return this.texte(c);
      case "docx.inserer_paragraphe": return this.insererParagraphe(c);
      case "docx.inserer_tableau": return this.insererTableau(c);
      case "docx.supprimer_paragraphe": return this.supprimerParagraphe(c);
      case "docx.deplacer": return this.deplacer(c);
      case "docx.remplacer_texte": return this.remplacerTexte(c);
      case "docx.cellule": return this.cellule(c);
      case "docx.inserer_ligne": return this.insererLigne(c);
      case "docx.supprimer_ligne": return this.supprimerLigne(c);
      case "docx.image_taille": return this.imageTaille(c);
      case "docx.supprimer_image": return this.supprimerImage(c);
      case "docx.inserer_image": return this.insererImage(c);
      case "docx.remplacer_image": return this.remplacerImage(c);
      default: return effetEchec(`opération « ${c.op} » non gérée par l'adaptateur Word`);
    }
  }

  /** Résout un paragraphe, ou rend l'échec tout fait (avec les candidats à départager). */
  private ciblerParagraphe(c: CommandeArtefact) {
    const r = resoudre(c.cible, this.designables(), {
      libelle: "paragraphe",
      estTitre: (p) => /^(Heading|Titre|Title)/i.test(p.modele.styleName ?? ""),
    });
    if (r.etat === "TROUVE") return { ok: true as const, p: r.objet };
    const candidats = r.etat === "AMBIGU" ? r.candidats.map((x) => ({ id: x.id, libelle: libelleParagraphe(x.modele) })) : [];
    return { ok: false as const, echec: effetEchec(r.motif, candidats) };
  }

  private align(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const val = ALIGN_OOXML[c.alignement as Alignment];
    setAttr(ensureChild(pPr(t.p.noeud), "w:jc", ORDRE_PPR.slice(0, ORDRE_PPR.indexOf("w:jc"))), "w:val", val);
    const mot = { left: "à gauche", center: "centré", right: "à droite", justify: "justifié" }[c.alignement as Alignment];
    return effetOk(`${libelleParagraphe(t.p.modele)} → ${mot}.`, [t.p.id]);
  }

  private formatTexte(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const runs = children(t.p.noeud, "w:r");
    if (runs.length === 0) {
      // Paragraphe vide : le style se pose sur `w:pPr/w:rPr`, qui gouverne ce qu'on y tapera.
      appliquerStyleProps(ensureChild(pPr(t.p.noeud), "w:rPr", ORDRE_PPR), c);
    }
    for (const r of runs) appliquerStyleProps(rPr(r), c);
    if (c.alignement !== null) {
      setAttr(ensureChild(pPr(t.p.noeud), "w:jc", ORDRE_PPR.slice(0, ORDRE_PPR.indexOf("w:jc"))), "w:val", ALIGN_OOXML[c.alignement as Alignment]);
    }
    const dits = [
      c.taillePt !== null ? `${c.taillePt} pt` : "",
      c.police !== null ? c.police : "",
      c.gras === true ? "gras" : c.gras === false ? "sans gras" : "",
      c.italique === true ? "italique" : "",
      c.souligne === true ? "souligné" : "",
      c.couleur !== null ? `#${c.couleur}` : "",
    ].filter(Boolean).join(", ");
    return effetOk(`${libelleParagraphe(t.p.modele)} → ${dits}.`, [t.p.id]);
  }

  private espacement(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const sp = ensureChild(pPr(t.p.noeud), "w:spacing", ORDRE_PPR.slice(0, ORDRE_PPR.indexOf("w:spacing")));
    // `w:spacing` compte en vingtièmes de point ; « remonte un peu » vaut un espacement AVANT réduit.
    if (c.avantPt !== null) setAttr(sp, "w:before", String(Math.max(0, Math.round(c.avantPt * 20))));
    if (c.apresPt !== null) setAttr(sp, "w:after", String(Math.max(0, Math.round(c.apresPt * 20))));
    return effetOk(`${libelleParagraphe(t.p.modele)} → espacement ajusté.`, [t.p.id]);
  }

  private retrait(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const ind = ensureChild(pPr(t.p.noeud), "w:ind", ORDRE_PPR.slice(0, ORDRE_PPR.indexOf("w:ind")));
    // Word REFUSE un retrait négatif au-delà de la marge : on borne à 0 plutôt que d'écrire un
    // document que Word « répare » silencieusement en perdant tout le paragraphe.
    if (c.gaucheCm !== null) setAttr(ind, "w:left", String(Math.max(0, cmEnTwip(c.gaucheCm))));
    if (c.droiteCm !== null) setAttr(ind, "w:right", String(Math.max(0, cmEnTwip(c.droiteCm))));
    return effetOk(`${libelleParagraphe(t.p.modele)} → retrait ajusté.`, [t.p.id]);
  }

  private texte(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    remplacerTexteParagraphe(t.p.noeud, c.texte ?? "");
    return effetOk(`${libelleParagraphe(t.p.modele)} → texte remplacé.`, [t.p.id]);
  }

  private insererParagraphe(c: CommandeArtefact): EffetCommande {
    /**
     * ── LE CORPS VIDE EST UN POINT DE DÉPART, PAS UNE IMPASSE ────────────────────────────
     *
     * Mesuré en conversation réelle : un modèle « papier en-tête » porte toute sa mise en
     * page dans l'en-tête et le pied de page, et son CORPS ne contient aucun paragraphe.
     * L'insertion exigeait un paragraphe de référence à cloner — donc « le document est vide
     * et ne contient aucun bloc de texte éditable », et la lettre ne pouvait jamais
     * commencer. On crée ici le PREMIER paragraphe, au bout du corps et avant `w:sectPr`
     * (qui doit rester le dernier enfant du corps, sinon Word répare en perdant la section) ;
     * les paragraphes suivants se clonent sur lui, comme partout ailleurs.
     */
    if (this.etat.paragraphes.length === 0) {
      const body = this.etat.body;
      const p = element("w:p");
      p.selfClosing = false;
      p.parent = body;
      if (c.texte) {
        const run = nouveauRun(c.texte, null);
        run.parent = p;
        p.children.push(run);
      }
      const sectPr = child(body, "w:sectPr");
      if (sectPr) insertBefore(body, sectPr, p);
      else insertAfter(body, body.children[body.children.length - 1] ?? null, p);
      markDirty(body);
      return effetOk("Premier paragraphe créé dans un corps vide (papier en-tête) — les suivants s'y accrochent.", []);
    }

    // SANS CIBLE = À LA FIN. « Ajoute un paragraphe » tout court se comprend comme « au bout du
    // document » — on clone le DERNIER paragraphe de corps pour hériter de sa mise en forme.
    if (cibleVide(c.cible)) {
      const dernier = this.etat.paragraphes[this.etat.paragraphes.length - 1];
      const parentFin = dernier.noeud.parent;
      if (!parentFin) return effetEchec("paragraphe détaché du document");
      const copieFin = cloneNode(dernier.noeud, parentFin);
      copieFin.raw = null;
      remplacerTexteParagraphe(copieFin, c.texte ?? "");
      insertAfter(parentFin, dernier.noeud, copieFin);
      return effetOk(`Paragraphe ajouté à la fin du document, après ${libelleParagraphe(dernier.modele)}.`, [dernier.modele.id]);
    }

    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const parent = t.p.noeud.parent;
    if (!parent) return effetEchec("paragraphe détaché du document");
    // On CLONE le paragraphe de référence puis on remplace son texte : le nouveau paragraphe
    // hérite ainsi de la police, de l'alignement et des retraits de son voisin — c'est ce qu'un
    // humain attend quand il dit « ajoute un paragraphe après celui-ci ».
    const copie = cloneNode(t.p.noeud, parent);
    copie.raw = null;
    remplacerTexteParagraphe(copie, c.texte ?? "");
    if (c.position === "avant") insertBefore(parent, t.p.noeud, copie);
    else insertAfter(parent, t.p.noeud, copie);
    return effetOk(`Paragraphe inséré ${c.position === "avant" ? "avant" : "après"} ${libelleParagraphe(t.p.modele)}.`, [t.p.id]);
  }

  /**
   * INSÉRER UN TABLEAU — bordé, l'en-tête en gras, les cellules héritant de la police du paragraphe voisin.
   * Le tableau se pose dans le CORPS (jamais dans une cellule) et toujours AVANT `w:sectPr`, qui doit rester
   * le dernier enfant du corps. Word exige un paragraphe dans chaque cellule : il y est, même vide.
   */
  private insererTableau(c: CommandeArtefact): EffetCommande {
    const lignes = (c.texte ?? "").split("\n").filter((l) => l.trim()).map((l) => l.split("|").map((x) => x.trim()));
    const nCol = Math.max(...lignes.map((l) => l.length));
    const largeur = Math.floor(9000 / nCol);
    const voisin = cibleVide(c.cible) ? this.etat.paragraphes[this.etat.paragraphes.length - 1] ?? null : null;
    const t = cibleVide(c.cible) ? null : this.ciblerParagraphe(c);
    if (t && !t.ok) return t.echec;
    const ref = t?.p ?? voisin;
    const modeleRun = ref ? child(ref.noeud, "w:r") : null;
    const bord = (nom: string) => element(nom, { "w:val": "single", "w:sz": "4", "w:space": "0", "w:color": "808080" });
    const tblPr = element("w:tblPr", {}, [
      element("w:tblW", { "w:w": "0", "w:type": "auto" }),
      element("w:tblBorders", {}, ["w:top", "w:left", "w:bottom", "w:right", "w:insideH", "w:insideV"].map(bord)),
      element("w:tblLook", { "w:val": "04A0", "w:firstRow": "1", "w:lastRow": "0", "w:firstColumn": "0", "w:lastColumn": "0", "w:noHBand": "0", "w:noVBand": "1" }),
    ]);
    const grille = element("w:tblGrid", {}, Array.from({ length: nCol }, () => element("w:gridCol", { "w:w": String(largeur) })));
    const rangs = lignes.map((cellules, i) => element("w:tr", {}, Array.from({ length: nCol }, (_, j) => {
      const texte = cellules[j] ?? "";
      const p = element("w:p");
      if (texte) {
        const run = nouveauRun(texte, modeleRun);
        if (i === 0) appliquerStyleProps(rPr(run), { ...COMMANDE_VIDE, op: c.op, gras: true });
        run.parent = p;
        p.children.push(run);
        p.selfClosing = false;
      }
      return element("w:tc", {}, [element("w:tcPr", {}, [element("w:tcW", { "w:w": String(largeur), "w:type": "dxa" })]), p]);
    })));
    const tbl = element("w:tbl", {}, [tblPr, grille, ...rangs]);
    const body = this.etat.body;
    if (ref && ref.noeud.parent === body) {
      if (c.position === "avant") insertBefore(body, ref.noeud, tbl);
      else insertAfter(body, ref.noeud, tbl);
    } else {
      const sectPr = child(body, "w:sectPr");
      if (sectPr) insertBefore(body, sectPr, tbl);
      else insertAfter(body, body.children[body.children.length - 1] ?? null, tbl);
    }
    markDirty(body);
    const ou = t ? `${c.position === "avant" ? "avant" : "après"} ${libelleParagraphe(t.p.modele)}` : "à la fin du document";
    return effetOk(`Tableau de ${lignes.length} ligne${lignes.length > 1 ? "s" : ""} × ${nCol} colonne${nCol > 1 ? "s" : ""} inséré ${ou}.`, [`t${this.etat.tables.length + 1}`]);
  }

  private supprimerParagraphe(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const parent = t.p.noeud.parent;
    if (!parent) return effetEchec("paragraphe détaché du document");
    const libelle = libelleParagraphe(t.p.modele);
    removeChild(parent, t.p.noeud);
    return effetOk(`${libelle} supprimé.`, []);
  }

  private deplacer(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const parent = t.p.noeud.parent;
    if (!parent) return effetEchec("paragraphe détaché du document");
    const pas = c.pas ?? 1;
    const freres = parent.children.filter((x) => x.type === "element" && (x.name === "w:p" || x.name === "w:tbl"));
    const i = freres.indexOf(t.p.noeud);
    const j = Math.max(0, Math.min(freres.length - 1, i + (c.direction === "haut" ? -pas : pas)));
    if (i === j) return effetEchec(`impossible de descendre plus ${c.direction === "haut" ? "haut" : "bas"}`);
    removeChild(parent, t.p.noeud);
    if (c.direction === "haut") insertBefore(parent, freres[j], t.p.noeud);
    else insertAfter(parent, freres[j], t.p.noeud);
    return effetOk(`${libelleParagraphe(t.p.modele)} déplacé vers le ${c.direction}.`, [t.p.id]);
  }

  private remplacerTexte(c: CommandeArtefact): EffetCommande {
    const cible = normaliserTexte(c.chercher ?? "");
    let n = 0;
    const touches: string[] = [];
    for (const { noeud, modele } of this.etat.paragraphes) {
      if (!normaliserTexte(modele.text).includes(cible)) continue;
      // On réécrit au niveau du PARAGRAPHE parce qu'un mot cherché est presque toujours coupé
      // en plusieurs `w:r` par Word (correcteur orthographique, révisions) — chercher fragment
      // par fragment raterait « rémunération » écrit en trois morceaux.
      remplacerTexteParagraphe(noeud, modele.text.replace(new RegExp(echapperRegex(c.chercher ?? ""), "gi"), c.remplacer ?? ""));
      n += 1;
      touches.push(modele.id);
      if (c.tout !== true) break;
    }
    if (n === 0) return effetEchec(`« ${c.chercher} » ne figure pas dans ce document`);
    // Le résumé dit CE QUI a changé : c'est la ligne que la personne accepte ou refuse dans l'Atelier.
    return effetOk(`« ${abreger(c.chercher ?? "", 40)} » → « ${abreger(c.remplacer ?? "", 40)} » (${n} paragraphe${n > 1 ? "s" : ""}).`, touches);
  }

  private ciblerTable(c: CommandeArtefact) {
    const r = resoudre(c.cible, this.designablesTables(), { libelle: "tableau" });
    if (r.etat === "TROUVE") return { ok: true as const, t: r.objet };
    const candidats = r.etat === "AMBIGU" ? r.candidats.map((x) => ({ id: x.id, libelle: `tableau ${x.index} — ${abreger(x.texte, 40)}` })) : [];
    return { ok: false as const, echec: effetEchec(r.motif, candidats) };
  }

  private cellule(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerTable(c);
    if (!t.ok) return t.echec;
    const lignes = children(t.t.noeud, "w:tr");
    const tr = lignes[(c.ligne ?? 1) - 1];
    if (!tr) return effetEchec(`ce tableau n'a pas de ligne ${c.ligne} (il en a ${lignes.length})`);
    const tcs = children(tr, "w:tc");
    const tc = tcs[(c.colonne ?? 1) - 1];
    if (!tc) return effetEchec(`cette ligne n'a pas de colonne ${c.colonne} (elle en a ${tcs.length})`);
    const p = child(tc, "w:p");
    if (!p) return effetEchec("cellule sans paragraphe — document inattendu");
    remplacerTexteParagraphe(p, c.texte ?? "");
    return effetOk(`Tableau ${t.t.index}, ligne ${c.ligne}, colonne ${c.colonne} → « ${abreger(c.texte ?? "", 30)} ».`, [`${t.t.id}.r${c.ligne}.c${c.colonne}`]);
  }

  private insererLigne(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerTable(c);
    if (!t.ok) return t.echec;
    const lignes = children(t.t.noeud, "w:tr");
    if (lignes.length === 0) return effetEchec("ce tableau n'a aucune ligne à copier");
    // La DERNIÈRE ligne sert de gabarit plutôt que la première : la première porte souvent la mise
    // en forme d'en-tête (fond gris, gras), qu'on ne veut pas répliquer sur une ligne de données.
    const ref = lignes[Math.min((c.ligne ?? lignes.length) - 1, lignes.length - 1)] ?? lignes[lignes.length - 1];
    const copie = cloneNode(ref, t.t.noeud);
    copie.raw = null;
    for (const tc of children(copie, "w:tc")) {
      const p = child(tc, "w:p");
      if (p) remplacerTexteParagraphe(p, "");
    }
    insertAfter(t.t.noeud, ref, copie);
    return effetOk(`Ligne ajoutée au tableau ${t.t.index}.`, [t.t.id]);
  }

  private supprimerLigne(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerTable(c);
    if (!t.ok) return t.echec;
    const lignes = children(t.t.noeud, "w:tr");
    const tr = lignes[(c.ligne ?? 0) - 1];
    if (!tr) return effetEchec(`ce tableau n'a pas de ligne ${c.ligne} (il en a ${lignes.length})`);
    removeChild(t.t.noeud, tr);
    return effetOk(`Ligne ${c.ligne} du tableau ${t.t.index} supprimée.`, [t.t.id]);
  }

  /** Ne lit QUE la cible : une lecture d'image n'est pas une commande (voir `DesignationImage`). */
  private ciblerImage(c: { cible: CommandeArtefact["cible"] }) {
    const r = resoudre(c.cible, this.designablesImages(), { libelle: "image" });
    if (r.etat === "TROUVE") return { ok: true as const, i: r.objet };
    const candidats = r.etat === "AMBIGU" ? r.candidats.map((x) => ({ id: x.id, libelle: `image ${x.index}` })) : [];
    return { ok: false as const, echec: effetEchec(r.motif, candidats) };
  }

  /**
   * SORT LES OCTETS d'une image du document — pour la lire, pas pour la changer.
   *
   * On passe par le MÊME ciblage que les commandes : « la deuxième image », « celle de la
   * page 4 », « celle qui parle du tampon ». Un ciblage séparé finirait par diverger, et
   * « remplace la 2ᵉ image » ne toucherait plus la même que « lis la 2ᵉ image ».
   */
  async extraireImage(d: DesignationImage): Promise<ExtractionImage> {
    const t = this.ciblerImage(d);
    if (!t.ok) return extractionEchec(t.echec.motif ?? "image introuvable", t.echec.candidats);
    const oct = octetsDeLImage(this.etat.zip, t.i.noeud);
    if (!oct) {
      // LIÉE, PAS INCORPORÉE : Word sait afficher une image qui vit sur un disque réseau. Le
      // fichier ne la contient PAS — le dire, plutôt que de rendre une lecture vide.
      return extractionEchec(
        `l'image ${t.i.index} n'est pas incorporée dans le document (elle est liée à un fichier extérieur) : il n'y a pas d'octets à lire ici`,
      );
    }
    return {
      ok: true,
      image: {
        octets: oct.octets,
        nom: oct.nom,
        description: t.i.modele.description,
        ou: `image ${t.i.index} du document`,
      },
    };
  }

  private imageTaille(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerImage(c);
    if (!t.ok) return t.echec;
    const extent = child(t.i.noeud, "wp:extent");
    if (!extent) return effetEchec("cette image n'a pas de dimensions déclarées");
    // On conserve le RAPPORT quand une seule dimension est donnée : une photo étirée est un défaut
    // que le contrôle qualité visuel (§26) signalerait de toute façon, autant ne pas le produire.
    const l = c.largeurCm ?? (c.hauteurCm !== null && t.i.modele.heightCm ? (t.i.modele.widthCm * c.hauteurCm) / t.i.modele.heightCm : t.i.modele.widthCm);
    const h = c.hauteurCm ?? (c.largeurCm !== null && t.i.modele.widthCm ? (t.i.modele.heightCm * c.largeurCm) / t.i.modele.widthCm : t.i.modele.heightCm);
    setAttr(extent, "cx", String(cmEnEmu(l)));
    setAttr(extent, "cy", String(cmEnEmu(h)));
    // `a:ext` porte la MÊME taille dans la géométrie du dessin : ne changer que `wp:extent`
    // laisse Word afficher l'ancienne taille — le genre de défaut invisible au test unitaire.
    const ext = firstDescendant(t.i.noeud, "a:ext");
    if (ext) { setAttr(ext, "cx", String(cmEnEmu(l))); setAttr(ext, "cy", String(cmEnEmu(h))); }
    return effetOk(`Image ${t.i.index} → ${l.toFixed(1)} × ${h.toFixed(1)} cm.`, [t.i.id]);
  }

  /**
   * ═══════════════════════════════════════════════════════════════════════════════════════
   * INSÉRER UNE IMAGE — « mets le logo Adventum en haut », « ajoute ce graphique ici ».
   *
   * ── CE QUI SE PASSE, ET DANS QUEL ORDRE ──────────────────────────────────────────────
   *
   * Les octets arrivent RÉSOLUS (le moteur les a lus à travers le port, donc sous les droits
   * de la personne). On lit leur en-tête pour connaître le type et le RAPPORT — sans lui,
   * une largeur donnée seule produirait une image écrasée. On pose la partie, la relation et
   * le type de contenu, puis le paragraphe.
   *
   * ── POURQUOI UN PARAGRAPHE À ELLE SEULE ──────────────────────────────────────────────
   *
   * Parce que c'est ce qu'on veut voir : une image insérée DANS un paragraphe de texte se
   * glisse entre deux mots, à la hauteur de la ligne. Un paragraphe dédié, centré, est le
   * geste que « mets le logo ici » désigne. Le reste — la faire flotter, l'habiller de texte
   * — n'a pas de formulation naturelle et n'est donc pas offert (§104.5).
   * ═══════════════════════════════════════════════════════════════════════════════════════
   */
  private insererImage(c: CommandeArtefact): EffetCommande {
    const ref = c.imageSource ?? "";
    const res = this.ressources.get(ref);
    if (!res) {
      // NOMMER la référence manquante : « image introuvable » enverrait chercher dans le
      // document, alors que ce qui manque est le FICHIER SOURCE, ailleurs.
      return effetEchec(`le fichier source « ${ref} » n'a pas pu être lu (introuvable, ou vous n'y avez pas accès)`);
    }
    const img = lireImage(res.octets);
    if (!img) {
      return effetEchec(
        `« ${res.nom} » n'est pas une image que Word sache afficher `
        + "(formats acceptés : PNG, JPEG, GIF, BMP, TIFF, WEBP)",
      );
    }

    const m = this.etat.modele;
    const largeurUtile = Math.max(1, m.pageWidthCm - m.marginLeftCm - m.marginRightCm);
    const taille = tailleInsertion(img, { largeurCm: c.largeurCm, hauteurCm: c.hauteurCm }, largeurUtile);

    let pose;
    try {
      pose = poserMedia(this.etat.zip, res.octets, img);
    } catch (e) {
      return effetEchec(`l'image n'a pas pu être rangée dans le document : ${(e as Error).message}`);
    }
    assurerNamespacesDessin(this.etat.racine);

    const p = paragrapheImage({
      rId: pose.rId,
      largeurCm: taille.largeurCm,
      hauteurCm: taille.hauteurCm,
      alt: c.imageAlt ?? res.nom,
      // Les identifiants de dessin doivent être uniques : on repart du nombre d'images DÉJÀ
      // présentes, plus un. Deux `docPr` identiques passent l'ouverture et font râler Word à
      // la première retouche — le genre de défaut qu'on découvre chez le destinataire.
      docPrId: this.etat.images.length + 1,
      nom: res.nom,
      alignement: "center",
    });

    const body = this.etat.body;
    if (cibleVide(c.cible)) {
      // SANS CIBLE = À LA FIN, comme pour un paragraphe — mais AVANT `w:sectPr`, qui doit
      // rester le dernier enfant du corps sous peine de voir Word « réparer » la section.
      const sectPr = child(body, "w:sectPr");
      if (sectPr) insertBefore(body, sectPr, p);
      else insertAfter(body, body.children[body.children.length - 1] ?? null, p);
      markDirty(body);
      return effetOk(
        `Image « ${res.nom} » ajoutée à la fin du document, ${taille.largeurCm.toFixed(1)} × ${taille.hauteurCm.toFixed(1)} cm.`,
        [],
      );
    }

    const t = this.ciblerParagraphe(c);
    if (!t.ok) return t.echec;
    const parent = t.p.noeud.parent;
    if (!parent) return effetEchec("paragraphe détaché du document");
    if (c.position === "avant") insertBefore(parent, t.p.noeud, p);
    else insertAfter(parent, t.p.noeud, p);
    return effetOk(
      `Image « ${res.nom} » insérée ${c.position === "avant" ? "avant" : "après"} ${libelleParagraphe(t.p.modele)}, `
      + `${taille.largeurCm.toFixed(1)} × ${taille.hauteurCm.toFixed(1)} cm.`,
      [t.p.id],
    );
  }

  /**
   * REMPLACER UNE IMAGE — et pourquoi ce n'est PAS « supprimer puis insérer ».
   *
   * L'image en place porte une taille, un alignement, parfois un habillage, réglés par
   * quelqu'un. Les refaire à l'identique après suppression est impossible : on ne sait pas ce
   * qui a été réglé à la main. On garde donc le dessin et l'on ne déplace que le lien vers les
   * octets — l'empreinte de la modification est exactement « le contenu de cette image ».
   */
  private remplacerImage(c: CommandeArtefact): EffetCommande {
    const ref = c.imageSource ?? "";
    const res = this.ressources.get(ref);
    if (!res) return effetEchec(`le fichier source « ${ref} » n'a pas pu être lu (introuvable, ou vous n'y avez pas accès)`);
    const img = lireImage(res.octets);
    if (!img) return effetEchec(`« ${res.nom} » n'est pas une image que Word sache afficher`);

    const t = this.ciblerImage(c);
    if (!t.ok) return t.echec;

    let pose;
    try {
      pose = poserMedia(this.etat.zip, res.octets, img);
    } catch (e) {
      return effetEchec(`l'image n'a pas pu être rangée dans le document : ${(e as Error).message}`);
    }
    if (!repointerImage(t.i.noeud, pose.rId)) {
      return effetEchec("cet objet n'est pas une image incorporée (c'est peut-être une forme ou un graphique)");
    }

    // LA TAILLE NE BOUGE PAS, sauf demande explicite : « remplace le logo » ne dit pas
    // « redimensionne-le ». Si le nouveau fichier a un autre rapport, l'image sera déformée —
    // et c'est un fait qu'on ANNONCE plutôt que de corriger dans le dos de la personne.
    const rapportAvant = t.i.modele.heightCm > 0 ? t.i.modele.widthCm / t.i.modele.heightCm : null;
    const rapportApres = img.largeurPx / img.hauteurPx;
    const deforme = rapportAvant !== null && Math.abs(rapportAvant - rapportApres) / rapportApres > 0.02;

    if (c.largeurCm !== null || c.hauteurCm !== null) {
      const taille = tailleInsertion(img, { largeurCm: c.largeurCm, hauteurCm: c.hauteurCm }, 100);
      const extent = child(t.i.noeud, "wp:extent");
      if (extent) {
        setAttr(extent, "cx", String(cmEnEmu(taille.largeurCm)));
        setAttr(extent, "cy", String(cmEnEmu(taille.hauteurCm)));
      }
      const ext = firstDescendant(t.i.noeud, "a:ext");
      if (ext) { setAttr(ext, "cx", String(cmEnEmu(taille.largeurCm))); setAttr(ext, "cy", String(cmEnEmu(taille.hauteurCm))); }
      return effetOk(
        `Image ${t.i.index} remplacée par « ${res.nom} », ${taille.largeurCm.toFixed(1)} × ${taille.hauteurCm.toFixed(1)} cm.`,
        [t.i.id],
      );
    }

    return effetOk(
      `Image ${t.i.index} remplacée par « ${res.nom} », même emplacement et même taille.`
      + (deforme ? " Attention : la nouvelle image n'a pas les mêmes proportions — elle sera étirée tant qu'on ne redonne pas de taille." : ""),
      [t.i.id],
    );
  }

  private supprimerImage(c: CommandeArtefact): EffetCommande {
    const t = this.ciblerImage(c);
    if (!t.ok) return t.echec;
    // On remonte au `w:drawing` : supprimer le seul `wp:inline` laisserait un `w:drawing` vide
    // que Word signale comme document endommagé.
    let n: XmlNode | null = t.i.noeud;
    while (n && n.name !== "w:drawing") n = n.parent;
    const cible = n ?? t.i.noeud;
    if (!cible.parent) return effetEchec("image détachée du document");
    removeChild(cible.parent, cible);
    return effetOk(`Image ${t.i.index} supprimée.`, []);
  }

  async serialiser(): Promise<Buffer> {
    this.etat.zip.file("word/document.xml", serializeXml(this.etat.racine));
    return this.etat.zip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
  }

  async valider(): Promise<Validation> {
    const problemes: string[] = [];
    try {
      const octets = await this.serialiser();
      const relu = new PizZip(octets);
      const doc = relu.file("word/document.xml");
      if (!doc) problemes.push("word/document.xml absent du fichier produit");
      else {
        const xml = doc.asText();
        if (!xml.includes("<w:body")) problemes.push("corps de document introuvable");
        const ouvrantes = (xml.match(/<w:p[ >]/g) ?? []).length;
        const fermantes = (xml.match(/<\/w:p>/g) ?? []).length;
        if (ouvrantes !== fermantes) problemes.push(`balises de paragraphe déséquilibrées (${ouvrantes}/${fermantes})`);
      }
      // Les pièces qu'on ne touche jamais doivent survivre — c'est la garantie §44, vérifiée.
      for (const requis of ["[Content_Types].xml", "_rels/.rels"]) {
        if (!relu.file(requis)) problemes.push(`pièce obligatoire perdue : ${requis}`);
      }
    } catch (e) {
      problemes.push(`le fichier produit ne se relit pas : ${(e as Error).message}`);
    }
    return { ok: problemes.length === 0, problemes };
  }
}

const echapperRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export const adaptateurDocx: AdaptateurArtefact = {
  format: "DOCX",
  mimes: [MIME_DOCX],
  extensions: [".docx"],
  async ouvrir(octets: Buffer): Promise<DocumentOuvert> {
    const zip = new PizZip(octets);
    const doc = zip.file("word/document.xml");
    if (!doc) throw new Error("Ce fichier .docx ne contient pas word/document.xml — il est probablement endommagé.");
    return new DocxOuvert(zip, parseXml(doc.asText()));
  },
};
