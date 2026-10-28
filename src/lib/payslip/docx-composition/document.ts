/**
 * COMPOSER UN `.docx` — les PAGES du document : en-tête et pied de chaque page, zone du corps.
 */
import type { DocumentDocx, Section, Bande } from "../docx-lecture";
import { type Mesureur, type PageComposee, type Geo, type Ctx, deplacer } from "./contrats";
import { type BoiteFixe, composerBlocsFixe, type Zone, type Cible, Flux } from "./flux";

// ─────────────────────────── Le document ───────────────────────────

/**
 * LES PAGES DU DOCUMENT. Chaque page reçoit son en-tête et son pied (première page, pages paires
 * selon la section), et la zone du corps se règle sur eux.
 */
export function composerDocument(d: DocumentDocx, mes: Mesureur): PageComposee[] {
  const premiere = d.sections[0]!.section;
  const geoDe = (s: Section, haut = s.marges.haut, bas = s.hauteur - s.marges.bas): Geo => ({ largeur: s.largeur, hauteur: s.hauteur, marges: s.marges, texte: { haut, bas } });
  const ctx: Ctx = {
    mes,
    tabDefaut: d.tabDefaut,
    geo: geoDe(premiere),
    paragraphes: new WeakMap(),
    tableaux: new WeakMap(),
  };
  const pages: PageComposee[] = [];
  let section = premiere;
  let indexDansSection = 0;
  let numero = 1;
  // Une bande se compose pour une géométrie donnée : ses objets ancrés « à la marge » dépendent de
  // la zone de texte effective, qui dépend elle-même de la hauteur des bandes de la page.
  const bandes = new WeakMap<Bande, Map<string, BoiteFixe>>();
  const composerBande = (b: Bande, s: Section, largeur: number): BoiteFixe => {
    let m = bandes.get(b);
    if (!m) { m = new Map(); bandes.set(b, m); }
    const cle = `${s.largeur}|${s.hauteur}|${largeur}|${ctx.geo.texte.haut}|${ctx.geo.texte.bas}`;
    const deja = m.get(cle);
    if (deja) return deja;
    const c = composerBlocsFixe(b.blocs, largeur, ctx, false);
    m.set(cle, c);
    return c;
  };

  const ouvrirPage = (): { zone: Zone; cible: Cible; debutSection: boolean } => {
    const s = section;
    const debutSection = indexDansSection === 0;
    if (indexDansSection === 0 && s.debutNumero != null) numero = s.debutNumero;
    const choisir = (v: Section["entetes"]): Bande | null =>
      s.titrePage && indexDansSection === 0 ? v.premiere ?? null : d.pairesImpaires && numero % 2 === 0 ? v.paire ?? null : v.defaut ?? null;
    const largeurTexte = s.largeur - s.marges.gauche - s.marges.droite;
    const page: PageComposee = { largeur: s.largeur, hauteur: s.hauteur, numero, formatNumero: s.formatNumero, derriere: [], bandes: [], corps: [], devant: [] };
    const entete = choisir(s.entetes);
    const pied = choisir(s.pieds);
    // 1. La hauteur des bandes (elle ne dépend pas de la géométrie) → la zone de texte effective.
    ctx.geo = geoDe(s);
    const hEntete = entete ? composerBande(entete, s, largeurTexte).hauteur : 0;
    const hPied = pied ? composerBande(pied, s, largeurTexte).hauteur : 0;
    let haut = s.marges.haut;
    let bas = s.hauteur - s.marges.bas;
    if (entete && !s.hautExact && hEntete > 0) haut = Math.max(haut, s.marges.entete + hEntete);
    if (pied && !s.basExact && hPied > 0) bas = Math.min(bas, s.hauteur - s.marges.pied - hPied);
    if (bas - haut < 72) { haut = s.marges.haut; bas = s.hauteur - s.marges.bas; }
    // 2. Les bandes composées dans CETTE géométrie, posées sur la page.
    ctx.geo = geoDe(s, haut, bas);
    const habillages: { x: number; y: number; largeur: number; hauteur: number }[] = [];
    const poserBande = (b: Bande | null, genre: "entete" | "pied") => {
      if (!b) return;
      const c = composerBande(b, s, largeurTexte);
      const oy = genre === "entete" ? s.marges.entete : s.hauteur - s.marges.pied - c.hauteur;
      page.bandes.push(...deplacer(c.derriere, s.marges.gauche, oy), ...deplacer(c.corps, s.marges.gauche, oy), ...deplacer(c.devant, s.marges.gauche, oy));
      for (const a of c.ancres ?? []) {
        if (a.ancre.derriere || a.ancre.habillage === "none") continue;
        habillages.push({ x: a.ax ? a.x : a.x + s.marges.gauche, y: a.ay ? a.y : a.y + oy, largeur: a.largeur, hauteur: a.hauteur });
      }
    };
    poserBande(entete, "entete");
    poserBande(pied, "pied");
    // Une image d'en-tête ou de pied HABILLÉE qui couvre la zone de texte la limite (Word renvoie
    // le texte autour) ; un objet « derrière le texte » ou sans habillage ne la touche pas.
    const [hautTexte, basTexte] = [haut, bas];
    for (const h of habillages) {
      const recouvre = Math.min(h.x + h.largeur, s.largeur - s.marges.droite) - Math.max(h.x, s.marges.gauche);
      if (recouvre < largeurTexte * 0.5) continue;
      if (h.y + h.hauteur / 2 < s.hauteur / 2) haut = Math.max(haut, h.y + h.hauteur);
      else bas = Math.min(bas, h.y);
    }
    if (bas - haut < 72) { haut = hautTexte; bas = basTexte; }
    pages.push(page);
    indexDansSection += 1;
    numero += 1;
    return { zone: { gauche: s.marges.gauche, largeur: largeurTexte, haut, bas }, cible: { corps: page.corps, derriere: page.derriere, devant: page.devant }, debutSection };
  };

  let flux: Flux | null = null;
  for (const { section: s, blocs } of d.sections) {
    const changement = section !== s;
    section = s;
    if (!flux) {
      indexDansSection = 0;
      const p = ouvrirPage();
      flux = new Flux(ctx, p.zone, p.cible, () => ouvrirPage());
    } else if (changement && s.type !== "continuous") {
      indexDansSection = 0;
      flux.nouvellePage();
    } else if (changement) {
      ctx.geo = geoDe(s, ctx.geo.texte.haut, ctx.geo.texte.bas);
      flux.zone = { ...flux.zone, gauche: s.marges.gauche, largeur: s.largeur - s.marges.gauche - s.marges.droite };
    }
    flux.placerBlocs(blocs, false);
  }
  return pages;
}
