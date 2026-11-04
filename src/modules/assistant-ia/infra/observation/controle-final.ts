import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { aReprendre, controlerMessage, ditIntrouvable, noteDeReprise, rectifier, type Constat, type PreuvesDuTour } from "../../domaine/observation/controle-final";
import { observer } from "../../domaine/observation/contrat";
import type { JournalDuTour } from "./journal";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRÔLE FINAL, BRANCHÉ SUR LE TOUR (lot I5, décision 0069) — là où `jouerTour` finit son tour : toute entrée qui joue
 * un tour (écran, fil, voix déléguée, et les entrées que I6 rebranche sur `jouerTour`) passe par lui, sans rien réécrire.
 *
 *   1. le message du modèle est jugé (`controlerMessage`) contre les observations et les gestes du journal ;
 *   2. un écart (contredite, non observée) ⇒ le tour est REJOUÉ UNE FOIS, l'écart énoncé comme un fait (« tu as écrit X ;
 *      l'observation dit Y ») — les mêmes outils, le même journal : il peut lire ce qui lui manquait ;
 *   3. le second message est rejugé ; ce qui récidive est REMPLACÉ par le fait observé, marqué visiblement. Jamais deux
 *      reprises : un rejeu qui échoue (délai, plafond) rectifie le premier message.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface VerdictDuControle {
  message: string;
  /** Les écarts du premier message, puis ceux du message rejoué (null : pas de reprise). */
  premier: Constat[];
  second: Constat[] | null;
  rejoue: boolean;
  /** Phrases remplacées par le fait observé. */
  rectifiees: number;
}

/** Les preuves du tour, lues dans le journal — à l'instant de l'appel (le rejeu en ajoute). */
export function preuvesDuJournal(journal: JournalDuTour, contexte: { sources: readonly string[]; historique: string; travauxLances: number }): PreuvesDuTour {
  const observations = journal.observations();
  return {
    observations,
    gestes: [...journal.gestes, ...(contexte.travauxLances ? [{ outil: "lancer_un_travail", libelle: "Mission lancée", statut: "FAIT", echec: false }] : [])],
    sources: [...journal.toutesLesSorties, ...contexte.sources, JSON.stringify(observations)],
    historique: contexte.historique,
  };
}

/**
 * « RELU SI BESOIN » — le message dit « je n'ai pas trouvé » après une lecture VIDE : le serveur relit cette lecture à blanc
 * (`compter`, I4) pour savoir ce que chaque filtre retire. Si la base porte des lignes sans l'un d'eux, c'est une
 * observation (« sans « classe » → 3 ») : le « pas trouvé » est contredit, le filtre trop étroit est nommé. Les droits sont
 * ceux de la lecture même (même outil, même personne) ; deux relectures au plus.
 */
export async function relireLesLecturesVides(journal: JournalDuTour, lire: PowerTool | undefined, user: CurrentUser): Promise<void> {
  if (!lire) return;
  const vides = journal.gestes.filter((g) => g.outil === lire.def.name && !g.echec && g.lignes === 0 && g.entree).slice(-2);
  for (const [i, g] of vides.entries()) {
    try {
      const s = JSON.parse(await lire.run({ ...g.entree, compter: true }, user)) as { sansFiltre?: Record<string, number>; vue?: string; table?: string };
      const elargir = Object.entries(s.sansFiltre ?? {}).filter(([, n]) => n > 0).map(([f, n]) => `sans « ${f} » → ${n} ligne(s)`);
      if (elargir.length) journal.noter(observer("lecture", { type: "lecture", id: `relue-${i + 1}`, lien: null }, "LU", { titre: String(s.vue ?? s.table ?? "lecture"), lignes: 0, elargir }));
    } catch (e) { console.warn("[assistant] contrôle final : relecture impossible", e); }
  }
}

export async function controleFinal(
  brouillon: string, preuves: () => PreuvesDuTour, rejouer: (note: string) => Promise<string | null>, relire: () => Promise<void> = async () => {},
): Promise<VerdictDuControle> {
  if (ditIntrouvable(brouillon)) await relire();
  const premier = aReprendre(controlerMessage(brouillon, preuves()));
  if (!premier.length) return { message: brouillon, premier, second: null, rejoue: false, rectifiees: 0 };
  console.warn("[assistant] contrôle final : reprise", premier.map((c) => `${c.affirmation.type}/${c.verdict}`));
  let repris: string | null = null;
  try { repris = await rejouer(noteDeReprise(premier)); } catch (e) { console.warn("[assistant] contrôle final : la reprise a échoué", e); }
  if (!repris?.trim()) return { message: rectifier(brouillon, premier), premier, second: null, rejoue: false, rectifiees: new Set(premier.map((c) => c.affirmation.phrase)).size };
  if (ditIntrouvable(repris)) await relire();
  const second = aReprendre(controlerMessage(repris, preuves()));
  if (second.length) console.warn("[assistant] contrôle final : récidive rectifiée", second.map((c) => `${c.affirmation.type}/${c.verdict}`));
  return { message: rectifier(repris, second), premier, second, rejoue: true, rectifiees: new Set(second.map((c) => c.affirmation.phrase)).size };
}
