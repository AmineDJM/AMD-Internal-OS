/**
 * LE JOURNAL DES TÂCHES DE FOND — une ligne JSON par événement, sur la sortie du processus.
 *
 * Render (et tout collecteur) range une ligne JSON en champs : `evenement="tache.fin" dureeMs>30000`
 * se filtre sans expression régulière. Le préfixe `"source":"taches-de-fond"` sépare ces lignes du
 * reste du journal. Jamais de donnée métier ni de secret : une clé de tâche, un détenteur, une
 * durée, un message d'erreur tronqué.
 */

import { journaliser, messageErreur, type NiveauJournal } from "@/lib/journal";

export type { NiveauJournal };

export type EntreeJournal = {
  ts: string;
  source: "taches-de-fond";
  niveau: NiveauJournal;
  evenement: string;
} & Record<string, unknown>;

export type Journal = (niveau: NiveauJournal, evenement: string, champs?: Record<string, unknown>) => void;

/** Tronque un message d'erreur — l'outil commun du journal unique (`@/lib/journal`). */
export { messageErreur };

export function entreeJournal(niveau: NiveauJournal, evenement: string, champs: Record<string, unknown> = {}): EntreeJournal {
  return { ts: new Date().toISOString(), source: "taches-de-fond", niveau, evenement, ...champs };
}

/**
 * Le journal de production — il passe par le journal UNIQUE (`@/lib/journal`) : même format de
 * ligne, même anti-avalanche, et surtout même COMPTAGE. Un échec de tâche est compté par tâche
 * (`tache.echec:<clé>`) : c'est lui qui, répété, remonte au Super Admin.
 */
export const journalConsole: Journal = (niveau, evenement, champs = {}) => {
  const { erreur, ...reste } = champs;
  const cle = typeof reste.tache === "string" ? `${evenement}:${reste.tache}` : evenement;
  journaliser(niveau, evenement, { source: "taches-de-fond", ...reste }, erreur, { cle });
};
