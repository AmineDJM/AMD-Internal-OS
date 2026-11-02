/**
 * LE CLASSEMENT DE PARITÉ — la table `CLASSIFICATION` (clé `fichier:fonction` → statut) et les
 * écrivains qui la remplissent : `classify`, et ses raccourcis `G` (GAP) et `X` (EXCLUDED). Les blocs
 * s'exécutent dans l'ordre où le registre les appelle : un bloc postérieur écrase un antérieur.
 */

export type ParityStatus = "NATIVE" | "COVERED" | "GAP" | "EXCLUDED";

export interface ActionClassification {
  status: ParityStatus;
  /** NATIVE/COVERED : l'outil du Chief (ou l'id ERP_ACTIONS) qui rend ce service. */
  via?: string;
  /** GAP : ce qui manque ; EXCLUDED : pourquoi ce n'est pas un travail d'assistant. */
  note?: string;
}

export const CLASSIFICATION: Record<string, ActionClassification> = {};
export function classify(status: ParityStatus, viaOrNote: string, keys: string[]): void {
  for (const k of keys) {
    CLASSIFICATION[k] = status === "NATIVE" || status === "COVERED"
      ? { status, via: viaOrNote }
      : { status, note: viaOrNote };
  }
}

/** GAP : action d'écran RECONNUE, pas encore proposable par le Chief. */
export const G = (note: string, keys: string[]) => classify("GAP", note, keys);

/** EXCLUDED : pas un travail d'assistant — raison donnée, pas un oubli. */
export const X = (note: string, keys: string[]) => classify("EXCLUDED", note, keys);
