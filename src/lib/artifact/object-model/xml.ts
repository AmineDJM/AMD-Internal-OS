/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ARBRE XML QUI SE SOUVIENT DE SA SOURCE — la brique qui rend « préserver la fidélité »
 * structurel plutôt que méritoire.
 *
 * ── LE PROBLÈME QUE RÉSOUT CE FICHIER ───────────────────────────────────────────────────
 *
 * Un `.docx` est un ZIP d'XML. Changer l'alignement d'un titre, c'est ajouter six caractères
 * dans `word/document.xml`. Mais si l'on passe le document entier dans un analyseur générique
 * puis qu'on le ré-imprime, on perd TOUT ce que cet analyseur n'a pas compris : espaces de noms
 * exotiques, extensions `mc:AlternateContent`, ordre des attributs, sections `w:sectPr` de
 * l'imprimeur, champs de fusion, ancres d'images. Le fichier s'ouvre encore — et le tableau a
 * changé de largeur, la photo a sauté, l'en-tête a disparu.
 *
 * C'est exactement le défaut que §44 interdit : « une petite modification ne doit pas détruire
 * styles, images, tableaux, en-têtes, formules, graphiques ».
 *
 * ── LA SOLUTION : CHAQUE NŒUD GARDE SA TRANCHE DE SOURCE ────────────────────────────────
 *
 * À l'analyse, chaque nœud mémorise `raw` — la portion EXACTE du fichier d'origine qu'il
 * occupe. À la ré-écriture :
 *
 *     nœud non touché      → on recopie `raw`, octet pour octet ;
 *     nœud touché          → on le reconstruit, et LUI SEUL.
 *
 * Modifier un paragraphe salit ce paragraphe et ses ANCÊTRES (sinon la recopie de l'ancêtre
 * écraserait la modification) — mais pas ses frères. Sur un contrat de 40 pages, changer le
 * titre reconstruit trois nœuds et recopie les quatre mille autres tels quels.
 *
 * Ce n'est pas une optimisation : c'est la seule façon d'avoir une garantie de non-régression
 * sur ce qu'on ne comprend pas. Ce que le code ignore, il le préserve.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type XmlNodeType = "element" | "text" | "other";

export interface XmlNode {
  type: XmlNodeType;
  /** Nom qualifié tel qu'écrit dans la source : `w:p`, `a:off`, `sst`. Vide pour du texte. */
  name: string;
  /** Attributs dans leur ORDRE d'origine (une reconstruction doit rester diffable). */
  attrs: Map<string, string>;
  children: XmlNode[];
  /** Contenu textuel ÉCHAPPÉ pour `text`, contenu brut (`<?…?>`, `<!--…-->`) pour `other`. */
  text: string;
  selfClosing: boolean;
  /** La tranche de source. `null` dès que le nœud (ou un descendant) a été modifié. */
  raw: string | null;
  parent: XmlNode | null;
}

const NAME_CHARS = /[A-Za-z0-9_.:-]/;

function makeElement(name: string): XmlNode {
  return { type: "element", name, attrs: new Map(), children: [], text: "", selfClosing: false, raw: null, parent: null };
}

/** Échappe pour un contenu textuel ou une valeur d'attribut XML. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rend un texte échappé lisible. Les entités numériques comptent : `&#233;` vaut « é ». */
export function unescapeXml(s: string): string {
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * ANALYSE un document XML en préservant les tranches de source.
 *
 * Volontairement TOLÉRANT : un fragment mal formé (balise fermante orpheline) ne fait pas échouer
 * l'ouverture du document — il devient du texte. Refuser d'ouvrir un fichier que Word ouvre très
 * bien serait le pire des deux mondes.
 */
export function parseXml(source: string): XmlNode {
  /** Où commence chaque nœud dans la source — table de travail, locale à l'analyse. */
  const nodeStart = new Map<XmlNode, number>();
  const root = makeElement("#document");
  root.raw = source;
  let node = root;
  let i = 0;
  let textStart = 0;

  const flushText = (end: number) => {
    if (end <= textStart) return;
    const slice = source.slice(textStart, end);
    node.children.push({
      type: "text", name: "", attrs: new Map(), children: [], text: slice,
      selfClosing: false, raw: slice, parent: node,
    });
  };

  while (i < source.length) {
    const lt = source.indexOf("<", i);
    if (lt < 0) break;

    // Prologue, commentaire, doctype, CDATA : conservés tels quels, jamais interprétés.
    if (source.startsWith("<?", lt) || source.startsWith("<!", lt)) {
      flushText(lt);
      let end: number;
      if (source.startsWith("<![CDATA[", lt)) end = source.indexOf("]]>", lt) + 3;
      else if (source.startsWith("<!--", lt)) end = source.indexOf("-->", lt) + 3;
      else end = source.indexOf(">", lt) + 1;
      if (end <= 0) end = source.length;
      const slice = source.slice(lt, end);
      node.children.push({
        type: "other", name: "", attrs: new Map(), children: [], text: slice,
        selfClosing: true, raw: slice, parent: node,
      });
      i = end;
      textStart = i;
      continue;
    }

    // Balise fermante.
    if (source.startsWith("</", lt)) {
      flushText(lt);
      const end = source.indexOf(">", lt);
      if (end < 0) break;
      const name = source.slice(lt + 2, end).trim();
      // On remonte jusqu'à l'ouvrante correspondante ; une fermante orpheline est ignorée.
      let target: XmlNode | null = node;
      while (target && target.name !== name) target = target.parent;
      if (target && target.parent) {
        target.raw = source.slice(nodeStart.get(target) ?? lt, end + 1);
        node = target.parent;
      }
      i = end + 1;
      textStart = i;
      continue;
    }

    // Balise ouvrante.
    flushText(lt);
    let j = lt + 1;
    while (j < source.length && NAME_CHARS.test(source[j])) j += 1;
    const name = source.slice(lt + 1, j);
    const el = makeElement(name);
    el.parent = node;

    // Attributs : `nom="valeur"` ou `nom='valeur'`, séparés par n'importe quel blanc.
    while (j < source.length) {
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] === ">" || source.startsWith("/>", j)) break;
      const aStart = j;
      while (j < source.length && NAME_CHARS.test(source[j])) j += 1;
      const aName = source.slice(aStart, j);
      if (!aName) { j += 1; continue; }
      while (j < source.length && /\s/.test(source[j])) j += 1;
      if (source[j] !== "=") { el.attrs.set(aName, ""); continue; }
      j += 1;
      while (j < source.length && /\s/.test(source[j])) j += 1;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") { el.attrs.set(aName, ""); continue; }
      const vEnd = source.indexOf(quote, j + 1);
      if (vEnd < 0) { j = source.length; break; }
      el.attrs.set(aName, source.slice(j + 1, vEnd));
      j = vEnd + 1;
    }

    node.children.push(el);
    nodeStart.set(el, lt);

    if (source.startsWith("/>", j)) {
      el.selfClosing = true;
      el.raw = source.slice(lt, j + 2);
      i = j + 2;
    } else {
      const end = source.indexOf(">", j);
      i = end < 0 ? source.length : end + 1;
      node = el;
    }
    textStart = i;
  }
  flushText(source.length);
  return root;
}

/** RÉ-ÉCRIT l'arbre : tranche d'origine pour l'intact, reconstruction pour le modifié. */
export function serializeXml(node: XmlNode): string {
  if (node.raw !== null) return node.raw;
  if (node.type === "text" || node.type === "other") return node.text;
  const parts: string[] = [];
  if (node.name !== "#document") {
    const attrs = [...node.attrs].map(([k, v]) => ` ${k}="${v}"`).join("");
    if (node.selfClosing && node.children.length === 0) return `<${node.name}${attrs}/>`;
    parts.push(`<${node.name}${attrs}>`);
  }
  for (const c of node.children) parts.push(serializeXml(c));
  if (node.name !== "#document") parts.push(`</${node.name}>`);
  return parts.join("");
}

/**
 * SALIT un nœud et toute sa lignée. Sans la remontée, l'ancêtre intact recopierait sa tranche
 * d'origine et la modification serait silencieusement perdue — le genre de défaut qui ne se voit
 * qu'à l'ouverture du fichier chez le client.
 */
export function markDirty(node: XmlNode): void {
  let n: XmlNode | null = node;
  while (n) { n.raw = null; n = n.parent; }
}

// ─────────────────────────── Navigation ───────────────────────────

export function children(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c) => c.type === "element" && c.name === name);
}

export function child(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((c) => c.type === "element" && c.name === name) ?? null;
}

/** Tous les descendants portant ce nom, en ordre de document. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (c.type !== "element") continue;
    if (c.name === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** Le premier descendant portant ce nom. */
export function firstDescendant(node: XmlNode, name: string): XmlNode | null {
  for (const c of node.children) {
    if (c.type !== "element") continue;
    if (c.name === name) return c;
    const deep = firstDescendant(c, name);
    if (deep) return deep;
  }
  return null;
}

/** Texte concaténé de tous les nœuds textuels sous ce nœud, déséchappé. */
export function textOf(node: XmlNode): string {
  if (node.type === "text") return unescapeXml(node.text);
  if (node.type === "other") return "";
  return node.children.map(textOf).join("");
}

// ─────────────────────────── Mutation ───────────────────────────

export function setAttr(node: XmlNode, name: string, value: string): void {
  node.attrs.set(name, escapeXml(value));
  markDirty(node);
}

export function attr(node: XmlNode, name: string): string | null {
  const v = node.attrs.get(name);
  return v === undefined ? null : unescapeXml(v);
}

export function removeChild(parent: XmlNode, node: XmlNode): boolean {
  const i = parent.children.indexOf(node);
  if (i < 0) return false;
  parent.children.splice(i, 1);
  markDirty(parent);
  return true;
}

export function insertAfter(parent: XmlNode, ref: XmlNode | null, node: XmlNode): void {
  node.parent = parent;
  const i = ref ? parent.children.indexOf(ref) : -1;
  parent.children.splice(i < 0 ? parent.children.length : i + 1, 0, node);
  markDirty(parent);
}

export function insertBefore(parent: XmlNode, ref: XmlNode, node: XmlNode): void {
  node.parent = parent;
  const i = parent.children.indexOf(ref);
  parent.children.splice(i < 0 ? parent.children.length : i, 0, node);
  markDirty(parent);
}

/** Fabrique un élément détaché — à insérer ensuite avec `insertAfter`/`insertBefore`. */
export function element(name: string, attrs: Record<string, string> = {}, kids: XmlNode[] = []): XmlNode {
  const el = makeElement(name);
  for (const [k, v] of Object.entries(attrs)) el.attrs.set(k, escapeXml(v));
  for (const k of kids) { k.parent = el; el.children.push(k); }
  el.selfClosing = kids.length === 0;
  return el;
}

/** Fabrique un nœud textuel (le contenu est échappé pour toi). */
export function textNode(value: string): XmlNode {
  return { type: "text", name: "", attrs: new Map(), children: [], text: escapeXml(value), selfClosing: false, raw: null, parent: null };
}

/** COPIE PROFONDE d'un nœud, source comprise — sert aux duplications (ligne, diapo). */
export function cloneNode(node: XmlNode, parent: XmlNode | null = null): XmlNode {
  const copy: XmlNode = {
    type: node.type, name: node.name, attrs: new Map(node.attrs), children: [],
    text: node.text, selfClosing: node.selfClosing, raw: node.raw, parent,
  };
  copy.children = node.children.map((c) => cloneNode(c, copy));
  return copy;
}

/**
 * ASSURE la présence d'un enfant à sa PLACE dans l'ordre du schéma OOXML.
 *
 * L'ordre n'est pas décoratif : `w:pPr` doit précéder les `w:r`, `w:rPr` doit ouvrir un `w:r`,
 * et `a:off` précède `a:ext` dans un `a:xfrm`. Word et PowerPoint refusent d'ouvrir un fichier
 * dont l'ordre est faux — c'est la première cause de « le document est corrompu » quand on
 * bricole de l'OOXML à la main.
 *
 * `avant` liste les noms qui doivent rester DEVANT le nœud inséré.
 */
export function ensureChild(parent: XmlNode, name: string, avant: string[] = []): XmlNode {
  const existing = child(parent, name);
  if (existing) return existing;
  const el = element(name);
  el.parent = parent;
  let idx = 0;
  for (let k = 0; k < parent.children.length; k += 1) {
    const c = parent.children[k];
    if (c.type === "element" && avant.includes(c.name)) idx = k + 1;
  }
  parent.children.splice(idx, 0, el);
  markDirty(parent);
  return el;
}
