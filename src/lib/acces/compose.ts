/**
 * COMPOSER DES CLAUSES PRISMA — toujours en `AND`, jamais par étalement (audit 27/10/2026, SA-03).
 *
 * Une portée RBAC rend souvent `{ OR: [...] }` (« mes lignes, ou celles de mon équipe »), une recherche
 * aussi (« le nom contient, ou la référence contient »). Les ÉTALER dans le même objet :
 *
 *   where: { ...portee, ...recherche }   // ← le second `OR` remplace le premier : la portée a disparu
 *
 * ouvre silencieusement les lignes de tout le monde. C'est ce qu'a mesuré l'audit sur l'API agent
 * (`?q=e` rendait les comptes rendus de visite de tous les délégués). La règle ESLint
 * `no-restricted-syntax` (`.eslintrc.json`) refuse l'étalement d'une portée ; ce module donne la forme
 * attendue, lisible en une ligne :
 *
 *   where: et({ isActive: true }, portee, recherche)
 *
 * Les clauses absentes (`undefined`, `null`, `false`) sont ignorées — pratique pour un filtre optionnel.
 * Module PUR : aucun import, utilisable partout (écran, serveur, test).
 */
export function et<W extends object>(...clauses: (W | null | undefined | false)[]): W {
  const presentes = clauses.filter((c): c is W => Boolean(c));
  return { AND: presentes } as unknown as W;
}
