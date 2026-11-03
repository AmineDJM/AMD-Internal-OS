/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CHAQUE PROCESSUS DE LA SUITE SIGNE SES CONNEXIONS — posé avant chaque fichier, avant le premier import de Prisma.
 *
 * Les fichiers de test tournent dans plusieurs processus, contre UNE base. Une barrière de concurrence
 * (`src/lib/actions/internes/bancs-concurrents.ts`) tient un verrou de table et attend que les gestes DE SON BANC y
 * soient arrêtés. Un verrou de table arrête aussi les écritures des AUTRES processus, et rien, côté Postgres, ne
 * distinguait les unes des autres : une insertion voisine bloquée là comptait pour le geste du banc, la barrière
 * s'ouvrait avant lui, et le geste concurrent passait trop tôt (signalé sous `npm test` : « R2 — UNE ANNULATION
 * APRÈS LA PRISE, AVANT L'ORDRE », approbation-achat-flow).
 *
 * `application_name=banc-<pid>` : toutes les connexions de ce processus portent son nom, la barrière comme les gestes
 * qu'elle lance — et seules celles-là se comptent. Une URL qui porte déjà un `application_name` n'est jamais touchée.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const url = process.env.DATABASE_URL;
if (url && !/[?&]application_name=/.test(url)) {
  process.env.DATABASE_URL = `${url}${url.includes("?") ? "&" : "?"}application_name=banc-${process.pid}`;
}
