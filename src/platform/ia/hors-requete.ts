/**
 * UN GESTE MÉTIER HORS REQUÊTE, POUR LES ASSISTANTS (J8) — la porte du socle IA vers `lib/contexte-geste.ts` : un
 * travail (Assistant IA aujourd'hui, Adam demain) exécute l'action de l'écran sur le worker avec la personne du geste
 * et un store pour `revalidatePath`. Le mécanisme est au socle de l'ERP ; ce fichier ne fait que le nommer ici.
 */
export { executerHorsRequete } from "@/lib/contexte-geste";
