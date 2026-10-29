/**
 * COMPOSER UN `.docx` — les LIGNES d'un paragraphe : coupure, tabulations, justification, interligne.
 */
import type { Paragraphe, Tabulation, ProprietesTexte } from "../docx-lecture";
import { type Trace, type Ctx, NOIR, borne } from "./contrats";
import { type Boite, boites, metriques } from "./boites";
import { tracesGraphiques } from "./dessins";

// ─────────────────────────── Les lignes d'un paragraphe ───────────────────────────

export interface LigneComposee {
  hauteur: number;
  /** x depuis le bord gauche de la zone de texte, y depuis le HAUT de la ligne. */
  traces: Trace[];
  sautPage: boolean;
  vide: boolean;
}

interface LigneEnCours {
  boites: Boite[];
  x: number;
  debut: number;
  attente: { tab: Boite; pos: number; type: string; x0: number } | null;
}

export function composerParagraphe(par: Paragraphe, largeur: number, ctx: Ctx): LigneComposee[] {
  let parLargeur = ctx.paragraphes.get(par);
  if (!parLargeur) { parLargeur = new Map(); ctx.paragraphes.set(par, parLargeur); }
  const cle = Math.round(largeur * 100);
  const deja = parLargeur.get(cle);
  if (deja) return deja;

  const { mes } = ctx;
  const pp = par.pp;
  const bs = boites(par, ctx);
  const limite = largeur - pp.retraitDroit;
  const lignes: LigneComposee[] = [];
  const nouvelle = (premiere: boolean): LigneEnCours => {
    const d = pp.retraitGauche + (premiere ? pp.retraitPremiere : 0);
    return { boites: [], x: d, debut: d, attente: null };
  };
  let L = nouvelle(true);
  const poser = (b: Boite) => { b.x = L.x; L.x += b.largeur; L.boites.push(b); };

  const trouverTab = (x: number): { pos: number; type: string; points: Tabulation["points"] } => {
    const perso = pp.tabulations.find((t) => t.type !== "bar" && t.type !== "clear" && t.pos > x + 0.05);
    const suspendu = pp.retraitPremiere < 0 && x < pp.retraitGauche - 0.05 ? pp.retraitGauche : null;
    if (perso && (suspendu == null || perso.pos <= suspendu)) return perso;
    if (suspendu != null) return { pos: suspendu, type: "left", points: null };
    // Les taquets par défaut ne valent qu'APRÈS le dernier taquet personnalisé.
    const d = ctx.tabDefaut > 1 ? ctx.tabDefaut : 36;
    return { pos: (Math.floor((x + 0.05) / d) + 1) * d, type: "left", points: null };
  };

  const resoudre = () => {
    const a = L.attente;
    if (!a) return;
    L.attente = null;
    const apres = L.boites.slice(L.boites.indexOf(a.tab) + 1);
    let fin = a.x0;
    for (const b of apres) if (b.type !== "espace") fin = b.x + b.largeur;
    const seg = fin - a.x0;
    let avantDecimal = seg;
    if (a.type === "decimal") {
      for (const b of apres) {
        if (b.type !== "mot") continue;
        const k = b.texte.search(/[.,]/);
        if (k >= 0) { avantDecimal = b.x - a.x0 + mes.largeur(b.police, b.texte.slice(0, k), b.taille); break; }
      }
    }
    let gap = a.type === "center" ? a.pos - a.x0 - seg / 2 : a.type === "decimal" ? a.pos - a.x0 - avantDecimal : a.pos - a.x0 - seg;
    gap = Math.max(0, Math.min(gap, Math.max(0, Math.max(limite, a.pos) - a.x0 - seg)));
    a.tab.largeur = gap;
    for (const b of apres) b.x += gap;
    L.x += gap;
  };

  const terminer = (raison: "auto" | "saut" | "fin") => {
    resoudre();
    lignes.push(finaliserLigne(L, raison, par, limite, ctx));
  };

  for (let i = 0; i < bs.length; ) {
    const b = bs[i]!;
    if (b.type === "espace") { poser(b); i += 1; continue; }
    if (b.type === "saut") {
      poser(b);
      terminer("saut");
      L = nouvelle(false);
      i += 1;
      continue;
    }
    if (b.type === "tab") {
      resoudre();
      const stop = b.ptab
        ? { pos: b.ptab === "center" ? largeur / 2 : b.ptab === "right" ? largeur : 0, type: b.ptab, points: null }
        : trouverTab(L.x);
      b.points = stop.points;
      if (stop.type === "left") {
        if (stop.pos > limite + 0.5 && L.boites.length > 0 && !b.ptab) {
          // Le taquet tombe au-delà de la marge : Word passe à la ligne.
          terminer("auto");
          L = nouvelle(false);
          b.largeur = 0;
          poser(b);
        } else {
          b.largeur = Math.max(0, stop.pos - L.x);
          poser(b);
        }
      } else {
        b.largeur = 0;
        poser(b);
        L.attente = { tab: b, pos: stop.pos, type: stop.type, x0: L.x };
      }
      i += 1;
      continue;
    }
    // Un AMAS insécable : des mots collés (changement de graisse au milieu d'un mot), une image…
    let j = i;
    let w = 0;
    while (j < bs.length) {
      const c = bs[j]!;
      if (c.type === "espace" || c.type === "tab" || c.type === "saut") break;
      if (j > i && c.coupureAvant) break;
      w += c.largeur;
      j += 1;
    }
    if (L.x + w > limite + 0.01 && L.boites.length > 0) {
      terminer("auto");
      L = nouvelle(false);
    }
    if (L.x + w > limite + 0.01) {
      // Plus large qu'une ligne entière : on coupe au caractère, comme Word.
      for (let k = i; k < j; k++) {
        let c = bs[k]!;
        while (c.type === "mot" && L.x + c.largeur > limite + 0.01 && [...c.texte].length > 1) {
          const chars = [...c.texte];
          let n = 0;
          while (n < chars.length && L.x + mes.largeur(c.police, chars.slice(0, n + 1).join(""), c.taille) <= limite + 0.01) n += 1;
          if (n === 0 && L.boites.length > 0) { terminer("auto"); L = nouvelle(false); continue; }
          n = Math.max(1, n);
          const tete = chars.slice(0, n).join("");
          const reste = chars.slice(n).join("");
          poser({ ...c, texte: tete, largeur: mes.largeur(c.police, tete, c.taille) });
          if (!reste) { c = { ...c, texte: "", largeur: 0 }; break; }
          terminer("auto");
          L = nouvelle(false);
          c = { ...c, texte: reste, largeur: mes.largeur(c.police, reste, c.taille) };
        }
        if (c.texte || c.type !== "mot") poser(c);
      }
    } else {
      for (let k = i; k < j; k++) poser(bs[k]!);
    }
    i = j;
  }
  terminer("fin");
  // Un saut de page en FIN de paragraphe garde la marque avec lui, sur la page qu'il termine :
  // Word ne repousse pas une ligne vide en tête de la page suivante.
  if (lignes.length >= 2 && lignes[lignes.length - 1]!.vide && lignes[lignes.length - 2]!.sautPage) lignes.pop();
  parLargeur.set(cle, lignes);
  return lignes;
}

function finaliserLigne(L: LigneEnCours, raison: "auto" | "saut" | "fin", par: Paragraphe, limite: number, ctx: Ctx): LigneComposee {
  const pp = par.pp;
  const { mes } = ctx;
  let A = 0, At = 0, Dt = 0;
  let texte = false;
  for (const b of L.boites) {
    if (b.type === "dessin") A = Math.max(A, b.asc);
    else { At = Math.max(At, b.asc); Dt = Math.max(Dt, b.desc); texte = true; }
  }
  // La MARQUE de paragraphe ne donne sa hauteur qu'à une ligne SANS texte (paragraphe vide, ligne
  // laissée vide par un saut final). Mesuré contre Word sur l'ordre de mission : une marque en
  // 13,5 pt derrière une ligne de texte en 12 pt ne la rehausse pas, mais elle fait la hauteur de
  // la ligne vide qui suit un `w:br` final.
  if (!texte) {
    const m = metriques(par.marque, mes);
    At = Math.max(At, m.asc);
    Dt = Math.max(Dt, m.desc);
  }
  // Une ligne faite d'une image seule n'a pas de jambage : l'image pose sur la ligne de base.
  const imageSeule = !texte && A > 0;
  A = Math.max(A, At);
  const D = imageSeule ? 0 : Dt;
  const naturel = A + D;
  const ligneTexte = At + Dt;
  const il = pp.interligne;
  const hauteur = il.regle === "exact" ? il.valeur : il.regle === "atLeast" ? Math.max(naturel, il.valeur) : Math.max(1, naturel + ligneTexte * (il.valeur - 1));
  // Interligne « multiple » : le supplément va SOUS le texte (mesuré contre Word : un en-tête en
  // interligne 1,08 garde sa ligne de base à distance d'en-tête + jambage haut). « Exactement » et
  // « au moins » posent le texte en bas de la ligne.
  const base = il.regle === "auto" ? A : hauteur - D;

  // Ce que la ligne contient vraiment : les espaces et sauts de fin ne comptent pas.
  let dernierUtile = -1;
  let fin = L.debut;
  L.boites.forEach((b, i) => { if (b.type !== "espace" && b.type !== "saut") { dernierUtile = i; fin = b.x + b.largeur; } });
  const libre = limite - fin;
  let dx = 0;
  if (pp.alignement === "center") dx = Math.max(0, libre / 2);
  else if (pp.alignement === "right") dx = Math.max(0, libre);
  else if (pp.alignement === "justify" && raison === "auto" && libre > 0) {
    let dernierTab = -1;
    L.boites.forEach((b, i) => { if (b.type === "tab" && i <= dernierUtile) dernierTab = i; });
    const espaces = L.boites.filter((b, i) => b.type === "espace" && i > dernierTab && i < dernierUtile);
    const nb = espaces.reduce((s, b) => s + b.texte.length, 0);
    if (nb > 0) {
      const parEspace = libre / nb;
      let cumul = 0;
      L.boites.forEach((b, i) => {
        b.x += cumul;
        if (b.type === "espace" && i > dernierTab && i < dernierUtile) {
          const extra = parEspace * b.texte.length;
          b.largeur += extra;
          b.etiree = true;
          cumul += extra;
        }
      });
    }
  }

  const fonds: Trace[] = [];
  const textes: Trace[] = [];
  const decors: Trace[] = [];
  const traits: Trace[] = [];
  const liens: Trace[] = [];
  let run: { cle: string; xFin: number; trace: Extract<Trace, { t: "texte" }> } | null = null;
  const vider = () => { if (run) { textes.push(run.trace); run = null; } };
  const couleur = (p: ProprietesTexte) => p.couleur ?? NOIR;

  L.boites.forEach((b, i) => {
    const x = b.x + dx;
    const y = base + b.decalage;
    const finale = i > dernierUtile;
    if (!finale && (b.p.surlignage || b.p.fond) && b.largeur > 0 && b.type !== "saut") {
      fonds.push({ t: "rect", x, y: base - b.asc, largeur: b.largeur, hauteur: b.asc + b.desc, fond: b.p.surlignage ?? b.p.fond, trait: null, forme: "rect" });
    }
    switch (b.type) {
      case "mot":
      case "espace": {
        if (b.type === "espace" && (finale || b.etiree)) { vider(); break; }
        const cle = `${b.police.cle}|${b.taille}|${couleur(b.p)}|${b.decalage}|${b.p.espacementPt}`;
        if (run && run.cle === cle && Math.abs(run.xFin - x) < 0.05) {
          run.trace.texte += b.texte;
          run.xFin = x + b.largeur;
        } else {
          vider();
          run = { cle, xFin: x + b.largeur, trace: { t: "texte", x, y, texte: b.texte, police: b.police, taille: b.taille, couleur: couleur(b.p), espacement: b.p.espacementPt } };
        }
        break;
      }
      case "champ":
        vider();
        textes.push({ t: "texte", x, y, texte: b.texte, police: b.police, taille: b.taille, couleur: couleur(b.p), espacement: b.p.espacementPt, champ: b.champ });
        break;
      case "puce":
        vider();
        decors.push({ t: "puce", forme: b.puce!, x: x + b.largeur / 2, y: base - b.taille * 0.3, taille: b.taille, couleur: couleur(b.p) });
        break;
      case "tab": {
        vider();
        if (b.points && b.largeur > b.taille) {
          const c = b.points === "dot" ? "." : b.points === "hyphen" ? "-" : b.points === "underscore" ? "_" : "·";
          const t = mes.nettoyer(b.police, c);
          const wc = mes.largeur(b.police, t, b.taille);
          const n = wc > 0 ? Math.floor((b.largeur - b.taille * 0.4) / wc) : 0;
          if (n > 0) textes.push({ t: "texte", x: x + b.largeur - n * wc - b.taille * 0.15, y: base, texte: t.repeat(n), police: b.police, taille: b.taille, couleur: couleur(b.p), espacement: 0 });
        }
        break;
      }
      case "dessin":
        vider();
        textes.push(...tracesGraphiques(b.dessin!.contenu, x, base - b.dessin!.hauteur, ctx, {}));
        break;
      case "saut":
        vider();
        break;
    }
    // Soulignement, barré, lien — continus d'une boîte à l'autre quand rien ne change.
    if (!finale && b.largeur > 0 && b.type !== "saut" && b.type !== "dessin" && b.type !== "puce") {
      const prolonger = (liste: Trace[], tr: Extract<Trace, { t: "ligne" }>) => {
        const d = liste[liste.length - 1];
        if (d && d.t === "ligne" && Math.abs(d.y1 - tr.y1) < 0.01 && d.couleur === tr.couleur && Math.abs(d.x2 - tr.x1) < 0.6 && d.epaisseur === tr.epaisseur) d.x2 = tr.x2;
        else liste.push(tr);
      };
      const tp = borne(b.p.taillePt, 1, 400);
      if (b.p.souligne) {
        const ep = Math.max(0.5, tp * 0.055);
        const yU = base + tp * 0.11;
        prolonger(traits, { t: "ligne", x1: x, x2: x + b.largeur, y1: yU, y2: yU, couleur: couleur(b.p), epaisseur: ep, style: "simple" });
        if (b.p.souligne === "double") prolonger(traits, { t: "ligne", x1: x, x2: x + b.largeur, y1: yU + ep * 2, y2: yU + ep * 2, couleur: couleur(b.p), epaisseur: ep, style: "simple" });
      }
      if (b.p.barre && b.type !== "tab") {
        const yB = y - b.taille * 0.28;
        prolonger(traits, { t: "ligne", x1: x, x2: x + b.largeur, y1: yB, y2: yB, couleur: couleur(b.p), epaisseur: Math.max(0.5, tp * 0.05), style: "simple" });
      }
      if (b.p.lien) {
        const d = liens[liens.length - 1];
        if (d && d.t === "lien" && d.url === b.p.lien && Math.abs(d.x + d.largeur - x) < 0.6) d.largeur = x + b.largeur - d.x;
        else liens.push({ t: "lien", x, y: base - b.asc, largeur: b.largeur, hauteur: b.asc + b.desc, url: b.p.lien });
      }
    }
  });
  vider();
  const sautPage = raison === "saut" && L.boites.some((b) => b.type === "saut" && (b.saut === "page" || b.saut === "colonne"));
  return { hauteur, traces: [...fonds, ...textes, ...decors, ...traits, ...liens], sautPage, vide: L.boites.length === 0 };
}
