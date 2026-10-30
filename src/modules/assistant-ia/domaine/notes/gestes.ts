import {
  cocher, deplacerApres, indexDe, inserer, nettoyerTexte, nettoyerTitrePage, precedent, retirer, sousArbre,
  type BlocNote, type TypeBloc,
} from "./blocs";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES GESTES DE L'ASSISTANT (décision 0026) — règle PURE.
 *
 * L'assistant ne modifie JAMAIS une note : il PROPOSE un geste, résolu ici contre la page telle qu'elle est (et les
 * propositions qui attendent déjà, pour pouvoir écrire « ajoute X sous la page que tu viens de proposer »). La
 * personne voit le geste en surbrillance dans son panneau ; à l'acceptation seulement, le serveur l'applique — et
 * garde l'INVERSE, pour « Annuler ».
 *
 * Désigner une ligne : par son identifiant (`lire_notes` les rend), ou par un morceau de son texte — plusieurs lignes
 * le portent : AMBIGU, avec les candidates ; aucune : INTROUVABLE. Jamais deviné.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type GesteNote =
  | { geste: "ajouter_note"; pageId: string; bloc: BlocNote; apres: string | null }
  | { geste: "modifier_note"; pageId: string; id: string; texte: string; ancien: string }
  | { geste: "cocher_note"; pageId: string; id: string; fait: boolean }
  | { geste: "deplacer_note"; pageId: string; id: string; apres: string | null; avant: string | null }
  | { geste: "supprimer_note"; pageId: string; id: string; bloc: BlocNote; apres: string | null }
  | { geste: "creer_page"; pageId: string; titre: string }
  | { geste: "renommer_page"; pageId: string; titre: string; ancien: string }
  /** L'inverse de « créer une page » — jamais proposé par l'assistant, seulement par « Annuler ». */
  | { geste: "retirer_page"; pageId: string };

export type NomGesteNote = GesteNote["geste"];

export type Resolution = { ok: true; id: string } | { ok: false; statut: "AMBIGU" | "INTROUVABLE"; candidats: { id: string; texte: string }[] };

/** Minuscules, sans accents, espaces resserrés — « Réunion » et « reunion » se rejoignent. */
export function plierNote(t: string): string {
  return (t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[«»"“”'’]/g, "").replace(/\s+/g, " ").trim();
}

/** UNE LIGNE DÉSIGNÉE : son identifiant, ou un morceau de son texte (le texte entier l'emporte sur un morceau). */
export function resoudreLigne(blocs: readonly BlocNote[], ref: string): Resolution {
  const r = (ref ?? "").trim();
  if (!r) return { ok: false, statut: "INTROUVABLE", candidats: [] };
  const parId = blocs.find((b) => b.id === r);
  if (parId) return { ok: true, id: parId.id };
  const q = plierNote(r);
  const exacts = blocs.filter((b) => plierNote(b.texte) === q);
  if (exacts.length === 1) return { ok: true, id: exacts[0].id };
  const contient = exacts.length ? exacts : blocs.filter((b) => q && plierNote(b.texte).includes(q));
  if (contient.length === 1) return { ok: true, id: contient[0].id };
  return {
    ok: false, statut: contient.length ? "AMBIGU" : "INTROUVABLE",
    candidats: contient.slice(0, 8).map((b) => ({ id: b.id, texte: b.texte.slice(0, 120) })),
  };
}

/** La fin de la SECTION d'un titre : la dernière ligne avant le titre suivant (de même niveau ou plus haut). */
export function finDeSection(blocs: readonly BlocNote[], titreId: string): string {
  const i = indexDe(blocs, titreId);
  if (i < 0) return titreId;
  let j = i + 1;
  while (j < blocs.length && !(blocs[j].type === "titre" && blocs[j].niveau <= blocs[i].niveau)) j++;
  return blocs[j - 1].id;
}

export type Position = { ok: true; apres: string | null; niveau: number; sous: string | null } | { ok: false; resolution: Resolution; quoi: string };

/**
 * OÙ POSER une ligne : `sous` un titre (à la fin de sa section), `apres` une ligne (après son sous-arbre, au même
 * niveau), `en_tete`, ou par défaut à la fin de la page.
 */
export function resoudrePosition(blocs: readonly BlocNote[], o: { apres?: string; sous?: string; enTete?: boolean }): Position {
  if (o.enTete) return { ok: true, apres: null, niveau: 0, sous: null };
  if (o.sous?.trim()) {
    const titres = blocs.filter((b) => b.type === "titre");
    const r = resoudreLigne(titres, o.sous);
    if (!r.ok) return { ok: false, resolution: r, quoi: "titre" };
    const fin = finDeSection(blocs, r.id);
    const titre = blocs[indexDe(blocs, r.id)];
    return { ok: true, apres: fin, niveau: titre.niveau, sous: titre.texte };
  }
  if (o.apres?.trim()) {
    const r = resoudreLigne(blocs, o.apres);
    if (!r.ok) return { ok: false, resolution: r, quoi: "ligne" };
    const i = indexDe(blocs, r.id);
    const [, fin] = sousArbre(blocs, i);
    return { ok: true, apres: blocs[fin - 1].id, niveau: blocs[i].niveau, sous: null };
  }
  return { ok: true, apres: blocs.length ? blocs[blocs.length - 1].id : null, niveau: 0, sous: null };
}

export type Application = { ok: true; blocs: BlocNote[]; touche: string | null } | { ok: false; raison: string };

const absente = (quoi: string): Application => ({ ok: false, raison: `${quoi} n'existe plus dans la page (elle a changé depuis la proposition).` });

/** APPLIQUER un geste de ligne à une page (le serveur, à l'acceptation ; l'écran, pour l'aperçu). */
export function appliquerSurBlocs(blocs: readonly BlocNote[], g: GesteNote): Application {
  switch (g.geste) {
    case "ajouter_note": {
      if (indexDe(blocs, g.bloc.id) >= 0) return { ok: false, raison: "Cette ligne a déjà été ajoutée." };
      if (g.apres !== null && indexDe(blocs, g.apres) < 0) return absente("La ligne de repère");
      return { ok: true, blocs: inserer(blocs, g.bloc, g.apres), touche: g.bloc.id };
    }
    case "modifier_note": {
      if (indexDe(blocs, g.id) < 0) return absente("La ligne");
      return { ok: true, blocs: blocs.map((b) => (b.id === g.id ? { ...b, texte: nettoyerTexte(g.texte) } : b)), touche: g.id };
    }
    case "cocher_note": {
      if (indexDe(blocs, g.id) < 0) return absente("La ligne");
      return { ok: true, blocs: cocher(blocs, g.id, g.fait), touche: g.id };
    }
    case "deplacer_note": {
      if (indexDe(blocs, g.id) < 0) return absente("La ligne");
      if (g.apres !== null && indexDe(blocs, g.apres) < 0) return absente("La ligne de repère");
      return { ok: true, blocs: deplacerApres(blocs, g.id, g.apres), touche: g.id };
    }
    case "supprimer_note": {
      if (indexDe(blocs, g.id) < 0) return absente("La ligne");
      return { ok: true, blocs: retirer(blocs, g.id), touche: null };
    }
    default:
      return { ok: true, blocs: [...blocs], touche: null };
  }
}

/** L'INVERSE d'un geste, calculé contre l'état d'AVANT — ce que « Annuler » rejouera. */
export function inverseDe(blocsAvant: readonly BlocNote[], g: GesteNote): GesteNote {
  switch (g.geste) {
    case "ajouter_note":
      return { geste: "supprimer_note", pageId: g.pageId, id: g.bloc.id, bloc: g.bloc, apres: g.apres };
    case "supprimer_note": {
      const bloc = blocsAvant.find((b) => b.id === g.id) ?? g.bloc;
      return { geste: "ajouter_note", pageId: g.pageId, bloc, apres: precedent(blocsAvant, g.id) };
    }
    case "modifier_note": {
      const b = blocsAvant.find((x) => x.id === g.id);
      return { geste: "modifier_note", pageId: g.pageId, id: g.id, texte: b?.texte ?? g.ancien, ancien: g.texte };
    }
    case "cocher_note": {
      const b = blocsAvant.find((x) => x.id === g.id);
      return { geste: "cocher_note", pageId: g.pageId, id: g.id, fait: b?.fait === true };
    }
    case "deplacer_note":
      return { geste: "deplacer_note", pageId: g.pageId, id: g.id, apres: precedent(blocsAvant, g.id), avant: g.apres };
    case "creer_page":
      return { geste: "retirer_page", pageId: g.pageId };
    case "renommer_page":
      return { geste: "renommer_page", pageId: g.pageId, titre: g.ancien, ancien: g.titre };
    case "retirer_page":
      return g;
  }
}

const cite = (t: string, n = 80) => `« ${t.length > n ? `${t.slice(0, n - 1)}…` : t} »`;
const LIBELLE_TYPE: Record<TypeBloc, string> = { texte: "la ligne", titre: "le titre", puce: "la puce", tache: "la case" };

/** CE QUE LA PERSONNE LIT sur la proposition (panneau et carte) — une phrase, à l'infinitif. */
export function resumeGeste(g: GesteNote, page: string, contexte: { sous?: string | null; blocs?: readonly BlocNote[] } = {}): string {
  const ligne = (id: string) => contexte.blocs?.find((b) => b.id === id)?.texte ?? "";
  switch (g.geste) {
    case "ajouter_note":
      return `Ajouter ${LIBELLE_TYPE[g.bloc.type]} ${cite(g.bloc.texte)}${contexte.sous ? ` sous ${cite(contexte.sous, 40)}` : ""} — ${cite(page, 40)}`;
    case "modifier_note":
      return `Remplacer ${cite(g.ancien, 50)} par ${cite(g.texte, 60)} — ${cite(page, 40)}`;
    case "cocher_note":
      return `${g.fait ? "Cocher" : "Décocher"} ${cite(ligne(g.id) || "la ligne")} — ${cite(page, 40)}`;
    case "deplacer_note":
      return `Déplacer ${cite(ligne(g.id) || "la ligne")} ${g.apres ? `après ${cite(ligne(g.apres) || "la ligne", 40)}` : "en tête"} — ${cite(page, 40)}`;
    case "supprimer_note":
      return `Supprimer ${cite(g.bloc.texte || "une ligne vide")} — ${cite(page, 40)}`;
    case "creer_page":
      return `Créer la page ${cite(g.titre, 60)}`;
    case "renommer_page":
      return `Renommer la page ${cite(g.ancien, 40)} en ${cite(g.titre, 40)}`;
    case "retirer_page":
      return `Retirer la page ${cite(page, 40)}`;
  }
}

/** Un geste lu en base (JSON) — rejeté s'il ne ressemble pas à un geste connu. */
export function lireGeste(x: unknown): GesteNote | null {
  if (!x || typeof x !== "object") return null;
  const g = x as Record<string, unknown>;
  if (typeof g.pageId !== "string" || typeof g.geste !== "string") return null;
  switch (g.geste) {
    case "ajouter_note":
    case "supprimer_note":
      return g.bloc && typeof g.bloc === "object" ? (g as unknown as GesteNote) : null;
    case "modifier_note":
    case "cocher_note":
    case "deplacer_note":
      return typeof g.id === "string" ? (g as unknown as GesteNote) : null;
    case "creer_page":
    case "renommer_page":
      return typeof g.titre === "string" && nettoyerTitrePage(g.titre) ? (g as unknown as GesteNote) : null;
    case "retirer_page":
      return g as unknown as GesteNote;
    default:
      return null;
  }
}

/** Le geste touche-t-il les LIGNES d'une page (sinon : la page elle-même) ? */
export const gesteDeLigne = (g: GesteNote): boolean =>
  g.geste === "ajouter_note" || g.geste === "modifier_note" || g.geste === "cocher_note" || g.geste === "deplacer_note" || g.geste === "supprimer_note";

/** Les lignes qu'une proposition AJOUTE — une autre proposition qui s'y réfère en DÉPEND. */
export const lignesAjoutees = (g: GesteNote): string[] => (g.geste === "ajouter_note" ? [g.bloc.id] : []);

/** UNE PROPOSITION telle que l'écran la montre (panneau, carte) — `infra/notes/propositions.ts` la fabrique. */
export type EtatProposition = "PROPOSEE" | "ACCEPTEE" | "REFUSEE" | "ANNULEE" | "PERIMEE";

export interface PropositionNote {
  id: string;
  pageId: string | null;
  geste: NomGesteNote;
  resume: string;
  etat: EtatProposition;
  creeLe: string;
  decideLe: string | null;
  dependDe: string[];
  /** Ce que l'écran surligne : la ligne touchée, la ligne ajoutée (et où), le texte ou l'état proposés. */
  cible: { id: string | null; bloc?: BlocNote; apres?: string | null; texte?: string; fait?: boolean; titre?: string };
}
