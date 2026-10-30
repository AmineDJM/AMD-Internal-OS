/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES GESTES DE L'ATELIER (J3, décision 0017) — ce qu'un assistant demande, traduit en commandes IR.
 *
 * Le modèle ne voit jamais d'XML (§104.6) ; il ne voit pas davantage les quarante opérations du Live
 * Office et leurs trente champs nullables. Il dit un GESTE, dans le vocabulaire d'une personne qui
 * relit un document : « remplace ce texte », « réécris le 3ᵉ paragraphe », « ajoute une diapositive »,
 * « mets 6 mois dans C4 », « insère un tableau ». Ce module le traduit, SELON LE FORMAT ouvert, en une
 * ou plusieurs commandes IR — que le compilateur juge ensuite comme toutes les autres.
 *
 * La traduction lit la VUE du document (ce que l'écran dessine) quand le geste en dépend : remplacer un
 * texte dans un PowerPoint, c'est trouver les zones qui le portent et réécrire chacune, puisque le
 * format n'a pas de « chercher-remplacer ». Elle ne devine jamais (§104.5) : un geste qui ne se traduit
 * pas dans ce format est REFUSÉ avec sa raison, et le modèle la lit.
 *
 * Module PUR (sa seule valeur importée, `commande`, vient de l'IR, sans dépendance) : l'écran s'en sert aussi (`zonesModifiees`, ce qu'il surligne).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

import { commande, type CommandeArtefact, type Cible } from "@/lib/artifact/commands/ir";
import type { VueContenu } from "@/lib/artifact/render/view";

export const ACTIONS_GESTE = [
  "remplacer_texte", "reecrire_paragraphe", "inserer_paragraphe", "supprimer_paragraphe", "modifier_titre",
  "mettre_en_forme", "inserer_tableau", "modifier_cellule",
  "ajouter_diapo", "supprimer_diapo", "dupliquer_diapo", "deplacer_diapo", "texte_forme",
  "supprimer_pages", "pivoter_pages", "filigrane",
] as const;
export type ActionGeste = (typeof ACTIONS_GESTE)[number];

export interface GesteAtelier {
  action: ActionGeste | string;
  /** Le texte cherché (remplacer_texte) et son remplaçant. */
  chercher?: string | null;
  remplacer?: string | null;
  /** Le nouveau texte (paragraphe, forme, contenu d'une diapositive — une ligne par puce). */
  texte?: string | null;
  /** Le titre (d'une diapositive ajoutée, ou le nouveau titre du document). */
  titre?: string | null;
  /** La CIBLE : rang humain (1 = le premier), fragment de texte, identifiant de la vue. */
  index?: number | null;
  contient?: string | null;
  id?: string | null;
  position?: "avant" | "apres" | string | null;
  /** PowerPoint : la diapositive (1 = la première) et sa position d'arrivée. */
  diapo?: number | null;
  versPosition?: number | null;
  /** Excel : la feuille et la cellule ou plage (B4, B4:D10) ; Word : le tableau, sa ligne, sa colonne. */
  feuille?: string | null;
  plage?: string | null;
  valeur?: string | null;
  tableau?: number | null;
  ligne?: number | null;
  colonne?: number | null;
  /** Un tableau : une ligne par entrée, cellules séparées par « | » ; la première est l'en-tête. */
  lignes?: string[] | null;
  /** Mise en forme. */
  gras?: boolean | null;
  italique?: boolean | null;
  souligne?: boolean | null;
  taillePt?: number | null;
  couleur?: string | null;
  alignement?: string | null;
  /** PDF. */
  pages?: number[] | null;
  degres?: number | null;
  /** remplacer_texte : toutes les occurrences (défaut) ou la première seulement. */
  tout?: boolean | null;
}

export interface Traduction {
  commandes: CommandeArtefact[];
  refus: string | null;
}

type Format = VueContenu["kind"];

/** Le schéma qu'un modèle remplit — tout facultatif sauf `action` ; la traduction exige ce qu'il faut. */
export const SCHEMA_GESTE = {
  type: "object",
  properties: {
    action: { type: "string", enum: [...ACTIONS_GESTE], description: "Le geste." },
    chercher: { type: "string", description: "remplacer_texte : le texte exact à trouver." },
    remplacer: { type: "string", description: "remplacer_texte : le texte qui le remplace." },
    texte: { type: "string", description: "Le nouveau texte (paragraphe, zone, contenu d'une diapositive : une ligne par puce)." },
    titre: { type: "string", description: "Le titre d'une diapositive ajoutée, ou le nouveau titre." },
    index: { type: "integer", description: "Le rang HUMAIN de la cible (1 = le premier paragraphe / la première zone)." },
    contient: { type: "string", description: "Un fragment de texte qui désigne la cible (paragraphe, zone)." },
    position: { type: "string", enum: ["avant", "apres"] },
    diapo: { type: "integer", description: "PowerPoint : la diapositive (1 = la première). ajouter_diapo : après laquelle (vide = à la fin)." },
    versPosition: { type: "integer", description: "deplacer_diapo : la position d'arrivée." },
    feuille: { type: "string", description: "Excel : la feuille (vide = la première)." },
    plage: { type: "string", description: "Excel : la cellule ou la plage (B4, B4:D10) ; inserer_tableau dans Excel : la cellule de départ." },
    valeur: { type: "string", description: "modifier_cellule : la valeur, ou une formule commençant par « = »." },
    tableau: { type: "integer", description: "Word : le tableau visé (1 = le premier) pour modifier_cellule." },
    ligne: { type: "integer" },
    colonne: { type: "integer" },
    lignes: { type: "array", items: { type: "string" }, description: "inserer_tableau : une entrée par ligne, cellules séparées par « | », la première est l'en-tête." },
    gras: { type: "boolean" }, italique: { type: "boolean" }, souligne: { type: "boolean" },
    taillePt: { type: "number" },
    couleur: { type: "string", description: "Six chiffres hexadécimaux sans dièse." },
    alignement: { type: "string", enum: ["left", "center", "right", "justify"] },
    pages: { type: "array", items: { type: "integer" }, description: "PDF : les pages (1 = la première)." },
    degres: { type: "integer", enum: [90, 180, 270] },
    tout: { type: "boolean", description: "remplacer_texte : false = seulement la première occurrence." },
  },
  required: ["action"],
} as const;

const cmd = commande;

const s = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const b = (v: unknown): boolean | null => (typeof v === "boolean" ? v : null);

function cibleDe(g: GesteAtelier, role: string | null = null): Cible {
  return { id: s(g.id), index: n(g.index), contient: s(g.contient), role, page: null, mot: null };
}
const cibleDonnee = (g: GesteAtelier) => Boolean(s(g.id) || n(g.index) !== null || s(g.contient));
const position = (g: GesteAtelier) => (g.position === "avant" || g.position === "apres" ? g.position : null);
const formes = (g: GesteAtelier): Partial<CommandeArtefact> => ({
  gras: b(g.gras), italique: b(g.italique), souligne: b(g.souligne), taillePt: n(g.taillePt),
  couleur: s(g.couleur)?.replace(/^#/, "") ?? null, alignement: s(g.alignement),
});
const aUneForme = (g: GesteAtelier) => Object.values(formes(g)).some((v) => v !== null);

const echapper = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const contientSans = (texte: string, motif: string) => texte.toLocaleLowerCase("fr").includes(motif.toLocaleLowerCase("fr"));
function remplacerDans(texte: string, chercher: string, remplacer: string, tout: boolean): string {
  return texte.replace(new RegExp(echapper(chercher), tout ? "gi" : "i"), () => remplacer);
}

const NOM_FORMAT: Record<Format, string> = { DOCX: "un document Word", PPTX: "une présentation", XLSX: "un classeur Excel", PDF: "un PDF" };
const refus = (motif: string): Traduction => ({ commandes: [], refus: motif });
const ok = (...commandes: CommandeArtefact[]): Traduction => ({ commandes, refus: null });
const horsFormat = (g: GesteAtelier, f: Format, conseil = ""): Traduction =>
  refus(`« ${g.action} » ne s'applique pas à ${NOM_FORMAT[f]}${conseil ? ` — ${conseil}` : ""}.`);

/** Les lignes d'un tableau, quelle que soit la façon dont le modèle les a données. */
function lignesDe(g: GesteAtelier): string[][] {
  const brutes = Array.isArray(g.lignes) && g.lignes.length ? g.lignes : (s(g.texte) ?? "").split("\n");
  return brutes.map((l) => String(l)).filter((l) => l.trim()).map((l) => l.split(/\s*\|\s*/).map((c) => c.trim()))
    .map((cells) => (cells[0] === "" && cells.length > 1 ? cells.slice(1) : cells))
    .map((cells) => (cells[cells.length - 1] === "" && cells.length > 1 ? cells.slice(0, -1) : cells))
    // Une ligne de séparation Markdown (« |---|---| ») n'est pas une ligne du tableau.
    .filter((cells) => !cells.every((c) => /^:?-{2,}:?$/.test(c)));
}

const LETTRES = (col: number): string => {
  let r = "";
  let v = col;
  while (v > 0) { const m = (v - 1) % 26; r = String.fromCharCode(65 + m) + r; v = Math.floor((v - m) / 26); }
  return r;
};
function decalage(ref: string, dl: number, dc: number): string | null {
  const m = /^([A-Z]{1,3})(\d{1,7})$/i.exec(ref.trim());
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return `${LETTRES(col + dc)}${Number(m[2]) + dl}`;
}

/**
 * TRADUIT un geste en commandes IR pour le format ouvert. `vue` est le contenu tel que l'écran le dessine —
 * il sert aux gestes qui doivent trouver où agir (remplacer un texte dans des zones, des cellules).
 */
export function traduireGeste(g: GesteAtelier, vue: VueContenu): Traduction {
  const f = vue.kind;
  switch (g.action) {
    case "remplacer_texte": {
      const chercher = s(g.chercher);
      if (!chercher) return refus("il faut dire quel texte chercher (`chercher`)");
      if (typeof g.remplacer !== "string") return refus("il faut dire par quoi le remplacer (`remplacer`)");
      const tout = g.tout !== false;
      if (f === "DOCX") return ok(cmd("docx.remplacer_texte", { chercher, remplacer: g.remplacer, tout }));
      if (f === "PPTX") {
        const cmds: CommandeArtefact[] = [];
        for (const d of vue.diapos) {
          if (n(g.diapo) !== null && d.index !== g.diapo) continue;
          for (const fo of d.formes) {
            if (!fo.texte || !contientSans(fo.texte, chercher)) continue;
            cmds.push(cmd("pptx.texte", { diapo: d.index, cible: { ...cibleDe({ action: "" }), id: fo.id }, texte: remplacerDans(fo.texte, chercher, g.remplacer, tout) }));
            if (!tout) return ok(...cmds);
          }
        }
        return cmds.length ? ok(...cmds) : refus(`« ${chercher} » ne figure dans aucune zone de texte de la présentation`);
      }
      if (f === "XLSX") {
        const cmds: CommandeArtefact[] = [];
        for (const fe of vue.feuilles) {
          if (s(g.feuille) && fe.nom !== g.feuille) continue;
          for (const c of fe.cellules) {
            if (c.formule || !c.valeur || !contientSans(c.valeur, chercher)) continue;
            cmds.push(cmd("xlsx.valeur", { feuille: fe.nom, plage: c.ref, texte: remplacerDans(c.valeur, chercher, g.remplacer, tout) }));
            if (!tout) return ok(...cmds);
          }
        }
        return cmds.length ? ok(...cmds) : refus(`« ${chercher} » ne figure dans aucune cellule (hors formules)`);
      }
      return horsFormat(g, f, "un PDF ne se réécrit pas : convertissez-le d'abord en Word");
    }

    case "reecrire_paragraphe":
      if (s(g.texte) === null) return refus("il faut donner le nouveau texte (`texte`)");
      if (f === "DOCX") {
        if (!cibleDonnee(g)) return refus("il faut dire QUEL paragraphe : `index` (1 = le premier) ou `contient`");
        return ok(cmd("docx.texte", { cible: cibleDe(g), texte: g.texte! }));
      }
      if (f === "PPTX") return traduireGeste({ ...g, action: "texte_forme" }, vue);
      return horsFormat(g, f);

    case "inserer_paragraphe":
      if (f !== "DOCX") return horsFormat(g, f, f === "PPTX" ? "ajoutez une diapositive ou réécrivez une zone" : "");
      if (s(g.texte) === null) return refus("il faut donner le texte à insérer (`texte`)");
      return ok(cmd("docx.inserer_paragraphe", { cible: cibleDonnee(g) ? cibleDe(g) : null, texte: g.texte!, position: position(g) }));

    case "supprimer_paragraphe":
      if (f !== "DOCX") return horsFormat(g, f);
      if (!cibleDonnee(g)) return refus("il faut dire QUEL paragraphe supprimer (`index` ou `contient`)");
      return ok(cmd("docx.supprimer_paragraphe", { cible: cibleDe(g) }));

    case "modifier_titre": {
      const texte = s(g.titre) ?? s(g.texte);
      if (!texte && !aUneForme(g)) return refus("il faut donner le nouveau titre (`titre`) ou une mise en forme");
      if (f === "DOCX") {
        const cible = cibleDonnee(g) ? cibleDe(g) : cibleDe(g, "titre");
        const cmds = texte ? [cmd("docx.texte", { cible, texte })] : [];
        if (aUneForme(g)) {
          const { alignement, ...reste } = formes(g);
          if (Object.values(reste).some((v) => v !== null)) cmds.push(cmd("docx.format_texte", { cible, ...reste }));
          if (alignement) cmds.push(cmd("docx.align", { cible, alignement }));
        }
        return ok(...cmds);
      }
      if (f === "PPTX") {
        const diapo = n(g.diapo) ?? 1;
        const cible = cibleDonnee(g) ? cibleDe(g) : cibleDe(g, "titre");
        const cmds = texte ? [cmd("pptx.texte", { diapo, cible, texte })] : [];
        if (aUneForme(g)) cmds.push(cmd("pptx.format_texte", { diapo, cible, ...formes(g) }));
        return ok(...cmds);
      }
      return horsFormat(g, f);
    }

    case "mettre_en_forme":
      if (!aUneForme(g)) return refus("aucune mise en forme demandée (gras, italique, taillePt, couleur, alignement…)");
      if (f === "DOCX") {
        if (!cibleDonnee(g)) return refus("il faut dire QUEL paragraphe mettre en forme (`index` ou `contient`)");
        const { alignement, ...reste } = formes(g);
        const cmds: CommandeArtefact[] = [];
        if (Object.values(reste).some((v) => v !== null)) cmds.push(cmd("docx.format_texte", { cible: cibleDe(g), ...reste }));
        if (alignement) cmds.push(cmd("docx.align", { cible: cibleDe(g), alignement }));
        return ok(...cmds);
      }
      if (f === "PPTX") {
        if (n(g.diapo) === null || !cibleDonnee(g)) return refus("il faut la diapositive (`diapo`) et la zone (`index` ou `contient`)");
        return ok(cmd("pptx.format_texte", { diapo: g.diapo!, cible: cibleDe(g), ...formes(g) }));
      }
      if (f === "XLSX") {
        if (!s(g.plage)) return refus("il faut la cellule ou la plage (`plage`)");
        return ok(cmd("xlsx.format", { feuille: s(g.feuille), plage: g.plage!, ...formes(g) }));
      }
      return horsFormat(g, f);

    case "inserer_tableau": {
      const lignes = lignesDe(g);
      if (!lignes.length) return refus("il faut les lignes du tableau (`lignes` : « A | B | C », la première est l'en-tête)");
      if (f === "DOCX") {
        return ok(cmd("docx.inserer_tableau", { cible: cibleDonnee(g) ? cibleDe(g) : null, position: position(g), texte: lignes.map((l) => l.join(" | ")).join("\n") }));
      }
      if (f === "XLSX") {
        const depart = s(g.plage)?.split(":")[0] ?? "A1";
        const cmds: CommandeArtefact[] = [];
        lignes.forEach((l, i) => l.forEach((v, j) => {
          const ref = decalage(depart, i, j);
          if (ref && v !== "") cmds.push(cmd(v.startsWith("=") ? "xlsx.formule" : "xlsx.valeur", { feuille: s(g.feuille), plage: ref, ...(v.startsWith("=") ? { formule: v } : { texte: v }) }));
        }));
        if (!cmds.length) return refus(`la cellule de départ « ${depart} » est illisible`);
        return ok(...cmds);
      }
      return horsFormat(g, f, f === "PPTX" ? "ajoutez une diapositive avec une puce par ligne" : "");
    }

    case "modifier_cellule": {
      const valeur = typeof g.valeur === "string" ? g.valeur : typeof g.texte === "string" ? g.texte : null;
      if (valeur === null) return refus("il faut la valeur (`valeur`)");
      if (f === "XLSX") {
        if (!s(g.plage)) return refus("il faut la cellule (`plage`, par exemple B4)");
        return ok(valeur.startsWith("=")
          ? cmd("xlsx.formule", { feuille: s(g.feuille), plage: g.plage!, formule: valeur })
          : cmd("xlsx.valeur", { feuille: s(g.feuille), plage: g.plage!, texte: valeur }));
      }
      if (f === "DOCX") {
        if (n(g.ligne) === null || n(g.colonne) === null) return refus("il faut la ligne et la colonne de la cellule (1 = la première)");
        return ok(cmd("docx.cellule", { cible: { ...cibleDe({ action: "" }), index: n(g.tableau) ?? 1 }, ligne: g.ligne!, colonne: g.colonne!, texte: valeur }));
      }
      return horsFormat(g, f);
    }

    case "ajouter_diapo":
      if (f !== "PPTX") return horsFormat(g, f);
      if (!s(g.titre) && !s(g.texte)) return refus("il faut un titre (`titre`) ou un contenu (`texte`, une ligne par puce)");
      return ok(cmd("pptx.ajouter_diapo", { nom: s(g.titre), texte: s(g.texte), diapo: n(g.diapo), position: position(g) }));

    case "supprimer_diapo":
    case "dupliquer_diapo":
      if (f !== "PPTX") return horsFormat(g, f);
      if (n(g.diapo) === null) return refus("il faut dire quelle diapositive (`diapo`, 1 = la première)");
      return ok(cmd(g.action === "supprimer_diapo" ? "pptx.supprimer_diapo" : "pptx.dupliquer_diapo", { diapo: g.diapo! }));

    case "deplacer_diapo":
      if (f !== "PPTX") return horsFormat(g, f);
      if (n(g.diapo) === null || n(g.versPosition) === null) return refus("il faut la diapositive (`diapo`) et sa position d'arrivée (`versPosition`)");
      return ok(cmd("pptx.deplacer_diapo", { diapo: g.diapo!, versIndex: g.versPosition! }));

    case "texte_forme":
      if (f !== "PPTX") return horsFormat(g, f);
      if (s(g.texte) === null) return refus("il faut le nouveau texte (`texte`)");
      if (n(g.diapo) === null) return refus("il faut la diapositive (`diapo`)");
      if (!cibleDonnee(g)) return refus("il faut dire quelle zone : `index` ou `contient` (ou modifier_titre pour le titre)");
      return ok(cmd("pptx.texte", { diapo: g.diapo!, cible: cibleDe(g), texte: g.texte! }));

    case "supprimer_pages":
    case "pivoter_pages":
      if (f !== "PDF") return horsFormat(g, f);
      if (!Array.isArray(g.pages) || !g.pages.length) return refus("il faut les pages (`pages`, 1 = la première)");
      return ok(g.action === "supprimer_pages"
        ? cmd("pdf.supprimer_pages", { pages: g.pages })
        : cmd("pdf.pivoter", { pages: g.pages, degres: n(g.degres) ?? 90 }));

    case "filigrane":
      if (f !== "PDF") return horsFormat(g, f);
      if (!s(g.texte)) return refus("il faut le texte du filigrane (`texte`)");
      return ok(cmd("pdf.filigrane", { texte: g.texte! }));

    default:
      return refus(`geste inconnu « ${g.action} » — gestes possibles : ${ACTIONS_GESTE.join(", ")}`);
  }
}

// ─────────────────────────── Ce que l'écran surligne ───────────────────────────

export interface ZonesModifiees {
  /** Les identifiants (blocs, formes, diapositives, cellules) dont le contenu est NEUF dans `apres`. */
  ids: string[];
  /** Où regarder : la diapositive, la feuille ou la page où la modification a eu lieu. */
  diapo: number | null;
  feuille: string | null;
  page: number | null;
}

function multiset(cles: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const k of cles) m.set(k, (m.get(k) ?? 0) + 1);
  return m;
}
/** Les éléments dont la clé n'était pas là avant — par CONTENU, pas par rang : une insertion ne décale pas tout. */
function neufs<T>(avant: string[], apres: T[], cle: (x: T) => string): T[] {
  const restes = multiset(avant);
  return apres.filter((x) => {
    const k = cle(x);
    const r = restes.get(k) ?? 0;
    if (r > 0) { restes.set(k, r - 1); return false; }
    return true;
  });
}

/**
 * CE QUI A CHANGÉ entre deux vues — par contenu. C'est ce que l'Atelier surligne (et fait s'écrire) quand une
 * opération arrive : le paragraphe réécrit, le tableau inséré, la diapositive ajoutée, la cellule changée.
 */
export function zonesModifiees(avant: VueContenu | null, apres: VueContenu): ZonesModifiees {
  const z: ZonesModifiees = { ids: [], diapo: null, feuille: null, page: null };
  if (!avant || avant.kind !== apres.kind) return z;
  if (avant.kind === "DOCX" && apres.kind === "DOCX") {
    const cle = (x: (typeof apres.blocs)[number]) => `${x.type}|${x.texte}|${x.lignes.map((l) => l.join("¦")).join("¶")}`;
    z.ids = neufs(avant.blocs.map(cle), apres.blocs, cle).map((x) => x.id);
  } else if (avant.kind === "PPTX" && apres.kind === "PPTX") {
    const sig = (d: (typeof apres.diapos)[number]) => `${d.titre}|${d.formes.map((f) => f.texte).join("¶")}`;
    const diaposNeuves = neufs(avant.diapos.map(sig), apres.diapos, sig);
    const textesAvant = avant.diapos.flatMap((d) => d.formes.map((f) => `${f.role}|${f.texte}`));
    const formesApres = apres.diapos.flatMap((d) => d.formes.map((f) => ({ ...f, diapo: d.index })));
    const formesNeuves = neufs(textesAvant, formesApres, (f) => `${f.role}|${f.texte}`);
    // Une diapositive dont SEULES les zones ont changé n'est pas « neuve » : on surligne les zones.
    const ajoutees = diaposNeuves.filter((d) => apres.diapos.length > avant.diapos.length || !d.formes.some((f) => formesNeuves.some((x) => x.id === f.id)));
    z.ids = [...ajoutees.map((d) => d.id), ...formesNeuves.map((f) => f.id)];
    z.diapo = formesNeuves[0]?.diapo ?? diaposNeuves[0]?.index ?? null;
  } else if (avant.kind === "XLSX" && apres.kind === "XLSX") {
    for (const fe of apres.feuilles) {
      const ancienne = avant.feuilles.find((x) => x.nom === fe.nom);
      const avantCles = new Set((ancienne?.cellules ?? []).map((c) => `${c.ref}=${c.valeur}|${c.formule ?? ""}`));
      const changees = fe.cellules.filter((c) => !avantCles.has(`${c.ref}=${c.valeur}|${c.formule ?? ""}`));
      if (changees.length && !z.feuille) z.feuille = fe.nom;
      z.ids.push(...changees.map((c) => c.id));
    }
  } else if (avant.kind === "PDF" && apres.kind === "PDF") {
    const cle = (p: (typeof apres.pages)[number]) => `${p.apercu}|${p.rotation}|${p.widthPt}x${p.heightPt}`;
    const changees = neufs(avant.pages.map(cle), apres.pages, cle);
    z.ids = changees.map((p) => p.id);
    z.page = changees[0]?.index ?? null;
  }
  return z;
}
