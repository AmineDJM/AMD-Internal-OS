/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * MODULE COFFRE — LA PORTE D'ÉCRITURE (serveur). ELLE NE DÉCHIFFRE JAMAIS.
 *
 * Ce que les actions serveur importent pour tenir la double écriture : charger les clés, chiffrer
 * une copie, calculer une empreinte, contrôler un accès. Les actions sont atteignables par
 * l'assistant : rien de ce qui est exporté ici n'importe `dechiffrement`, `lecture` ni `service`,
 * et `frontiere.test.ts` le vérifie en remontant les imports depuis l'assistant et les agents.
 *
 * Lire une valeur en clair passe par `./api-lecture` — écrans d'administration et pièces
 * officielles seulement, jamais l'assistant.
 *
 * Tables : `DonneeSensible`, `AccesDonneeSensible`. Interrupteurs : `AppSetting.coffreEcriture`,
 * `coffreLecture` (`./actions`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export * from "./partage";

// ── Les clés ─────────────────────────────────────────────────────────────────────────────────
export { chargerCles, clesDepuisMaitresse, ErreurCleCoffre, type ClesCoffre } from "./infra/cle";

// ── Chiffrer, empreinte (sans déchiffrer) ────────────────────────────────────────────────────
export { empreinte } from "./infra/chiffrement";

// ── Commandes : la double écriture ───────────────────────────────────────────────────────────
export { doubleEcrireCoffre } from "./infra/ecriture";
export { copierAuCoffre, type ResultatCopie } from "./infra/copies";

// ── Contrôle d'accès (politique + journal, sur la valeur que l'appelant a déjà) ──────────────
export { controlerRibDePiece } from "./infra/acces";
