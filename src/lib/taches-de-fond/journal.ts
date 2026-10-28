/**
 * LE JOURNAL DES TÂCHES DE FOND — une ligne JSON par événement, sur la sortie du processus.
 *
 * Render (et tout collecteur) range une ligne JSON en champs : `evenement="tache.fin" dureeMs>30000`
 * se filtre sans expression régulière. Le préfixe `"source":"taches-de-fond"` sépare ces lignes du
 * reste du journal. Jamais de donnée métier ni de secret : une clé de tâche, un détenteur, une
 * durée, un message d'erreur tronqué.
 */

export type NiveauJournal = "info" | "avertissement" | "erreur";

export type EntreeJournal = {
  ts: string;
  source: "taches-de-fond";
  niveau: NiveauJournal;
  evenement: string;
} & Record<string, unknown>;

export type Journal = (niveau: NiveauJournal, evenement: string, champs?: Record<string, unknown>) => void;

/** Tronque un message d'erreur : assez pour diagnostiquer, jamais une pile entière en base. */
export function messageErreur(e: unknown, max = 500): string {
  const brut = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return brut.length > max ? `${brut.slice(0, max - 1)}…` : brut;
}

export function entreeJournal(niveau: NiveauJournal, evenement: string, champs: Record<string, unknown> = {}): EntreeJournal {
  return { ts: new Date().toISOString(), source: "taches-de-fond", niveau, evenement, ...champs };
}

/** Le journal de production : `console.error` pour les erreurs (flux stderr), `console.log` sinon. */
export const journalConsole: Journal = (niveau, evenement, champs) => {
  const ligne = JSON.stringify(entreeJournal(niveau, evenement, champs));
  if (niveau === "erreur") console.error(ligne);
  else if (niveau === "avertissement") console.warn(ligne);
  else console.log(ligne);
};
