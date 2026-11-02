/**
 * LE DIALOGUE DE CONFIRMATION — sa règle, PURE et sans import (V3-B, audit 27/10/2026 FRONTEND-UX-05).
 *
 * ── POURQUOI ────────────────────────────────────────────────────────────────────────────────
 *
 * Le parc demandait confirmation par `window.confirm()` (125 appels) et un motif par
 * `window.prompt()` : une boîte grise du navigateur, non stylée, qui bloque tout l'onglet, que
 * les navigateurs mobiles finissent par supprimer (« Empêcher cette page d'ouvrir d'autres
 * boîtes de dialogue »), et dont le bouton s'appelle « OK » quel que soit le geste.
 * `ui/dialogue.tsx` la remplace par une vraie fenêtre (`role="alertdialog"`, focus piégé, Échap).
 *
 * Ce module dit CE QUE la fenêtre affiche à partir de ce que l'appelant a écrit, pour que la
 * migration reste une substitution (`window.confirm(q)` → `await confirmer(q)`) sans réécrire
 * 125 phrases : le premier paragraphe devient le titre, la suite le détail, et le bouton porte
 * le VERBE du geste quand la question commence par un verbe connu (« Supprimer ce document ? »
 * → bouton « Supprimer ») — « OK » n'apprend rien à personne.
 */

/** `danger` : bouton rouge, et le focus initial sur « Retour » (le geste réversible). */
export type TonDialogue = "danger" | "neutre";

/** Ce que l'appelant demande — une chaîne suffit pour le cas courant. */
export interface DemandeConfirmation {
  /** La question, courte. À défaut : le premier paragraphe de `message`. */
  titre?: string;
  /** Le détail (conséquences). Les sauts de ligne sont respectés. */
  message?: string;
  /** Le libellé du bouton qui exécute. À défaut : le verbe de la question, sinon « Confirmer ». */
  confirmer?: string;
  /** Le libellé du bouton qui renonce (« Retour » par défaut). */
  annuler?: string;
  /** À défaut : `danger` si la phrase parle de supprimer, retirer, détruire, d'irréversible… */
  ton?: TonDialogue;
  /** Un champ à remplir (motif) — remplace `window.prompt`. */
  saisie?: { libelle: string; obligatoire?: boolean; valeur?: string; placeholder?: string; multiligne?: boolean };
}

/** Ce que la fenêtre affiche, tout résolu. */
export interface DialoguePret {
  titre: string;
  detail: string | null;
  confirmer: string;
  annuler: string;
  ton: TonDialogue;
  saisie: { libelle: string; obligatoire: boolean; valeur: string; placeholder: string; multiligne: boolean } | null;
}

/**
 * Les verbes qui se suffisent sur un bouton. Liste FERMÉE à dessein : « Mettre ces 3 éléments à la
 * corbeille ? » donnerait « Mettre », « Accuser réception… » donnerait « Accuser » — hors liste,
 * le bouton dit « Confirmer », ce qui est toujours juste.
 */
const VERBES_BOUTON = new Set([
  "Supprimer", "Retirer", "Annuler", "Clôturer", "Refuser", "Rejeter", "Valider", "Archiver", "Restaurer",
  "Détruire", "Fusionner", "Soumettre", "Envoyer", "Publier", "Réinitialiser", "Désactiver", "Activer",
  "Remplacer", "Effacer", "Vider", "Quitter", "Fermer", "Rouvrir", "Lever", "Purger", "Terminer", "Dépublier",
  "Approuver", "Révoquer", "Régénérer", "Relancer", "Écraser", "Abandonner", "Rattacher", "Détacher", "Déplacer",
  "Réactiver", "Basculer", "Autoriser", "Importer", "Renvoyer", "Retenir", "Transférer", "Convertir",
]);

/** Les mots qui font d'une question un geste à risque (bouton rouge, focus sur « Retour »). */
const RISQUE = /\b(supprim|détrui|irréversible|définitiv|effac|purg|vider|écras|retirer|révoqu|corbeille)/i;

/** Le titre (premier paragraphe) et le détail (le reste) d'un texte libre. */
export function decouperTexte(texte: string): { titre: string; detail: string | null } {
  const propre = texte.replace(/\r\n/g, "\n").trim();
  const coupure = propre.search(/\n\s*\n/);
  if (coupure === -1) {
    // Une seule ligne de rupture simple : la première ligne reste le titre.
    const ligne = propre.indexOf("\n");
    if (ligne === -1) return { titre: propre, detail: null };
    return { titre: propre.slice(0, ligne).trim(), detail: propre.slice(ligne + 1).trim() || null };
  }
  return { titre: propre.slice(0, coupure).trim(), detail: propre.slice(coupure).trim() || null };
}

/** Le verbe du geste quand la question commence par un verbe de la liste, sinon « Confirmer ». */
export function verbeDuBouton(titre: string): string {
  const premier = titre.trim().split(/[\s,«»"']/)[0] ?? "";
  return VERBES_BOUTON.has(premier) ? premier : "Confirmer";
}

/** Résout ce que la fenêtre affiche. */
export function preparerDialogue(entree: string | DemandeConfirmation): DialoguePret {
  const d: DemandeConfirmation = typeof entree === "string" ? { message: entree } : entree;
  const decoupe = d.titre ? { titre: d.titre.trim(), detail: d.message?.trim() || null } : decouperTexte(d.message ?? "");
  const titre = decoupe.titre || "Confirmer ce geste ?";
  const tout = `${titre}\n${decoupe.detail ?? ""}`;
  return {
    titre,
    detail: decoupe.detail,
    confirmer: d.confirmer?.trim() || verbeDuBouton(titre),
    annuler: d.annuler?.trim() || "Retour",
    ton: d.ton ?? (RISQUE.test(tout) ? "danger" : "neutre"),
    saisie: d.saisie
      ? {
          libelle: d.saisie.libelle,
          obligatoire: !!d.saisie.obligatoire,
          valeur: d.saisie.valeur ?? "",
          placeholder: d.saisie.placeholder ?? "",
          multiligne: d.saisie.multiligne ?? true,
        }
      : null,
  };
}

/** Le bouton qui exécute est-il utilisable ? (un motif obligatoire vide le bloque) */
export function peutConfirmer(d: DialoguePret, saisie: string): boolean {
  return !d.saisie?.obligatoire || saisie.trim().length > 0;
}

/**
 * Le geste qui reçoit le focus à l'ouverture : le champ s'il y en a un ; « Retour » pour un geste à
 * risque (Entrée par réflexe ne doit pas supprimer) ; le bouton du geste sinon.
 */
export function focusInitial(d: DialoguePret): "saisie" | "annuler" | "confirmer" {
  if (d.saisie) return "saisie";
  return d.ton === "danger" ? "annuler" : "confirmer";
}
