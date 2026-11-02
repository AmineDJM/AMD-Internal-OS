/**
 * LA CARTE D'ACTION COMPACTE (point 3, 31/10/2026) — règles pures de ce que la carte dit dans la conversation.
 *
 * Constat de la Direction sur iPhone : une carte « demande de sponsoring » occupait tout l'écran (formulaire complet,
 * avertissement répété deux fois, « Simulation sans résultat » alors que des champs obligatoires manquaient). La carte
 * se résume dans le fil ; le formulaire s'ouvre dans un panneau. Ces règles décident du résumé — sans React.
 */

const cle = (t: string): string =>
  t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[«»"'’.,;:!?()\-–—]/g, " ").replace(/\s+/g, " ").trim();

/**
 * Les avertissements, chacun UNE fois : un doublon (casse, accents, ponctuation près) ou une phrase déjà contenue dans
 * une autre — ou dans le résumé de la simulation affiché juste au-dessus — ne se répète pas.
 */
export function avertissementsUniques(avertissements: readonly string[], dejaDit: readonly (string | undefined)[] = []): string[] {
  const dits = dejaDit.filter((d): d is string => !!d && !!d.trim()).map(cle);
  const garde: { brut: string; k: string }[] = [];
  for (const a of avertissements) {
    const brut = a.trim();
    const k = cle(brut);
    if (!k || dits.some((d) => d.includes(k))) continue;
    if (garde.some((g) => g.k.includes(k))) continue;
    // Une phrase plus complète remplace la plus courte qu'elle contient.
    for (let i = garde.length - 1; i >= 0; i--) if (k.includes(garde[i]!.k)) garde.splice(i, 1);
    garde.push({ brut, k });
  }
  return garde.map((g) => g.brut);
}

/** Ce que la ligne « simulation » de la carte dit, selon qu'il manque des champs obligatoires ou non. */
export function etatSimulationAffiche(statut: "SIMULE" | "ECHEC" | "NON_SIMULABLE" | undefined, champsManquants: number):
  "SIMULE" | "ECHEC" | "NON_SIMULABLE" | "EN_ATTENTE_DES_CHAMPS" | null {
  if (!statut) return null;
  // Une simulation faite sur une proposition incomplète échoue forcément : le dire comme un échec trompe.
  if (statut === "ECHEC" && champsManquants > 0) return "EN_ATTENTE_DES_CHAMPS";
  return statut;
}

/** Le libellé du bouton principal de la carte compacte. */
export function libelleOuverture(manquants: number, aVerifier: boolean): string {
  if (manquants > 0) return manquants === 1 ? "Compléter 1 champ" : `Compléter ${manquants} champs`;
  return aVerifier ? "Vérifier et signer" : "Ouvrir et signer";
}

/** Les champs à montrer dans le résumé (au plus `max`), le reste se compte. */
export function apercuChamps<T>(champs: readonly T[], max = 4): { visibles: T[]; reste: number } {
  return { visibles: champs.slice(0, max), reste: Math.max(0, champs.length - max) };
}

/**
 * LES CHAMPS LONGS VONT AU PANNEAU (lot B1, décision 0049) : un champ de plus de quatre lignes (le détail des 27 lignes
 * d'un BC) ne s'étale pas dans la conversation — la carte garde le résumé, le détail s'ouvre dans le panneau latéral.
 */
export function separerChampsLongs<T extends { label: string; value: string }>(champs: readonly T[], maxLignes = 4): { courts: T[]; longs: T[] } {
  const longs = champs.filter((c) => c.value.split("\n").length > maxLignes);
  return { courts: champs.filter((c) => !longs.includes(c)), longs };
}

/** Le libellé du lien d'une action exécutée : un PDF déposé au Drive s'ouvre comme tel. */
export function libelleLienResultat(lien: string): string {
  return /\/api\/drive\/[^/]+\/raw/.test(lien) ? "Ouvrir le PDF" : "Consulter";
}
