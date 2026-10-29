/**
 * RÉSOLUTION D'ENTITÉS — le socle PUR, désormais hébergé côté neutre.
 *
 * Ces primitives (repli d'accents, initiales, recouvrement de jetons, fautes de frappe) ne sont
 * pas propres à Adam : ce sont des mathématiques de chaînes, et la couche de connaissance de
 * l'ERP en a besoin. Elles vivent donc dans `src/lib/name-match.ts`, que les deux côtés peuvent
 * importer sans se tirer l'un l'autre — l'ERP important « du Adam » aurait été le couplage
 * inverse, le plus difficile à repérer et le premier à casser le jour où Adam est extrait.
 *
 * Ce fichier subsiste et RÉEXPORTE : les appelants d'Adam (`regulatory-read`, `investigation`) et
 * les tests n'ont pas changé d'une ligne. Il n'y a qu'une implémentation, donc qu'un seul endroit
 * où corriger le prochain défaut.
 */

export {
  foldOrg,
  orgTokens,
  coreTokens,
  initialsOf,
  rankOrgCandidates,
  resolveOrg,
} from "@/lib/name-match";
