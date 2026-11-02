// TYPE DÉCLARÉ du JSON généré (`npm run actions:contrat`) — lot M2, marge mémoire du build.
// Sans ce fichier, `resolveJsonModule` fait INFÉRER à tsc le type de 870 ko de littéraux
// (≈ 17 600 types, 2 s de vérification, le fichier le plus lent du programme) pour le jeter
// aussitôt dans un `as readonly ContratAction[]`. TypeScript lit `<nom>.d.json.ts` à la place
// du JSON pour le typage ; l'empaqueteur, lui, charge toujours le JSON. La forme réelle reste
// gardée par le cliquet `contrat.test.ts`, qui redérive et compare.
import type { ContratAction } from "./contrat";

declare const donnees: readonly ContratAction[];
export default donnees;
