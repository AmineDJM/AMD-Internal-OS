/**
 * UN GESTE MÉTIER HORS REQUÊTE, POUR LES ASSISTANTS (J8) — la porte du socle IA vers `lib/contexte-geste.ts` : un
 * travail (Assistant IA aujourd'hui, Adam demain) exécute l'action de l'écran sur le worker avec la personne du geste
 * et un store pour `revalidatePath`. Le mécanisme est au socle de l'ERP ; ce fichier ne fait que le nommer ici.
 *
 * J7 (décision 0029) : la même porte nomme le reste du contexte de geste — la SIMULATION transactionnelle (le diff
 * d'une carte), le JOURNAL DES EFFETS (tout geste d'agent garde la valeur avant) et l'ANNULATION honnête.
 */
export {
  executerHorsRequete, simulerEnDiff, journaliserGeste, annulerGeste, planDAnnulation, gestesDeLAssistant,
  type CompteRenduAnnulation, type GesteListe,
} from "@/lib/contexte-geste";
