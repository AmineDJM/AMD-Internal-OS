/**
 * LES INTERRUPTEURS DE REPLI DU LOT I1 (décision 0063) — chaque étape est réversible sans déploiement de code : une
 * variable d'environnement à « 0 » rend l'ancien comportement. Défaut : actif (mesuré par `scripts/bench/au1-verite`).
 *
 *   ADAM_OBSERVATION=0            étapes 1 et 2 : ni observations, ni sortie-projection, ni bloc « Observé »
 *   ADAM_OBSERVATION_HISTORIQUE=0 étape 1 seule : l'historique redevient le texte des réponses
 *   ADAM_MAIL_BLOCS=0             étape 5 : tout mail est rendu à la charte, comme avant (le modèle ne choisit plus le style)
 *   ADAM_CONTROLE_FINAL=0         lot I5 (décision 0069) : plus de contrôle final du message ; les anciennes gardes (note
 *                                 « Non vérifié » par familles de mots, note des chiffres non sourcés, consignes « ne dis pas
 *                                 que c'est fait ») reviennent À L'IDENTIQUE. Coupé aussi quand ADAM_OBSERVATION=0 : sans
 *                                 observation, un contrôle ne jugerait que des mots.
 */
const coupe = (nom: string): boolean => (process.env[nom] ?? "").trim() === "0";

export const observationActive = (): boolean => !coupe("ADAM_OBSERVATION");
export const historiqueObserveActif = (): boolean => observationActive() && !coupe("ADAM_OBSERVATION_HISTORIQUE");
export const mailEnBlocsActif = (): boolean => !coupe("ADAM_MAIL_BLOCS");
export const controleFinalActif = (): boolean => observationActive() && !coupe("ADAM_CONTROLE_FINAL");
