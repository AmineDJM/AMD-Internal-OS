/**
 * LES RÈGLES D'AFFICHAGE DE « MES MÉDECINS » — pures, testées (`regles-panel.test.ts`). Aucune importation de valeur :
 * l'écran (navigateur) et les tests les lisent ; les fonctions de normalisation de l'annuaire sont PASSÉES par l'écran
 * (`cleDeNom`, `plier` de `@/modules/referentiels/partage`), pour ne jamais écrire une seconde fois la règle des doublons.
 */

export type FiltreLettre = "Toutes" | "H" | "A" | "B" | "C" | "D" | "NA";

interface Filtrable {
  nom: string;
  specialite: string | null;
  etablissement: string | null;
  wilaya: string | null;
  lettre: string | null;
  retard: string | null;
}

const sansAccent = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** La liste affichée : recherche (nom, spécialité, établissement, wilaya ; casse et accents ignorés), lettre, retard. */
export function filtrerPanel<T extends Filtrable>(medecins: readonly T[], f: { q: string; lettre: FiltreLettre; retardSeul: boolean }): T[] {
  const q = sansAccent(f.q.trim());
  return medecins
    .filter((d) => f.lettre === "Toutes" || d.lettre === f.lettre)
    .filter((d) => !f.retardSeul || Boolean(d.retard))
    .filter((d) => !q || sansAccent([d.nom, d.specialite, d.etablissement, d.wilaya].filter(Boolean).join(" ")).includes(q));
}

const JOUR_MS = 86_400_000;

/** « vu aujourd'hui », « il y a 12 j », « jamais vu » — à l'heure du serveur (`maintenant`, ISO). */
export function phraseDernierPassage(derniere: string | null, maintenant: string): string {
  if (!derniere) return "jamais vu";
  const jours = Math.floor((new Date(maintenant).getTime() - new Date(derniere).getTime()) / JOUR_MS);
  if (jours <= 0) return "vu aujourd'hui";
  return `il y a ${jours} j`;
}

/**
 * LES HOMONYMES DU PANEL — les médecins dont le nom porte les mêmes mots que celui qu'on s'apprête à créer (ordre, casse,
 * accents et titres ignorés), ou dont un mot du nom de famille coïncide quand on n'a tapé qu'un nom. Rien tant que moins
 * de deux lettres sont tapées.
 */
export function homonymesDansLePanel<T extends { nom: string }>(
  medecins: readonly T[],
  saisie: string,
  cleDeNom: (nom: string) => string,
  plier: (s: string) => string,
): T[] {
  const cle = cleDeNom(saisie);
  if (cle.replace(/\s/g, "").length < 2) return [];
  const mots = cle.split(" ").filter((m) => m.length >= 2);
  return medecins.filter((d) => {
    const autre = cleDeNom(d.nom);
    if (autre === cle) return true;
    // Un seul mot tapé (« Benali ») : tous ceux qui portent ce mot sont des homonymes possibles.
    return mots.length === 1 && autre.split(" ").some((m) => plier(m) === plier(mots[0]!));
  });
}
