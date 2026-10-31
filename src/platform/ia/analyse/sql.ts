/**
 * LE SQL EN LECTURE SEULE, VU DU SOCLE (lot K1, décision 0031) — la PORTE par laquelle l'Assistant IA atteint le bac
 * à sable SQL de l'ERP (`lib/sandbox/sql.ts` : SELECT/WITH seul, tables autorisées relues au plan EXPLAIN, transaction
 * READ ONLY, rôle dédié, 500 lignes, colonnes masquées, VUE GLOBALE seulement). Un seul franchissement vers l'ERP,
 * compté sous `SOCLE_IA_CEILING` (compensé dans le même lot : `teach/store.ts` n'importe plus deux fois le même module) ;
 * Adam garde le sien par son pont. Rien n'est réécrit : c'est le même moteur, les mêmes gardes.
 */
export { COLONNES_MASQUEES, executerSqlLectureSeule, LIMITE_LIGNES, TABLES_AUTORISEES } from "@/lib/sandbox/sql";
