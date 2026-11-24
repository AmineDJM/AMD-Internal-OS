/**
 * L'ACCÈS RÉSOLU VU PAR UNE RÈGLE PURE — la forme minimale de `SessionUser.access` qu'une règle de domaine sait lire sans
 * importer le RBAC (ni base, ni session). Module PUR, ZÉRO import : il est cité par les règles des centres
 * (`finances/domaine/authorization.ts`, `ad-pro/domaine/centre.ts`, `validations/centre.ts`) et par le RBAC lui-même.
 *
 * POURQUOI (Super Admin, 24/11/2026 : « je peux donner ou révoquer l'accès à TOUT module affiché »). Les centres et le
 * bureau d'Adam s'ouvraient par une liste de rôles écrite dans le code, À CÔTÉ de leur module : la console affichait une case
 * qui n'ouvrait rien (accorder menait à une page introuvable) et un blocage qui ne fermait rien (le rôle passait outre). La
 * règle lit désormais la clé que la console règle, et elle seule.
 */

/** Ce que la règle lit d'un accès résolu. `SessionUser.access` s'y conforme tel quel. */
export interface AccesStructurel {
  modules?: ReadonlyMap<string, { actions: ReadonlySet<string> }>;
  /** Les gestes que seul un INTÉRIM donne (`getAccess`) : un siège ne se prête pas (§118.185). */
  pretes?: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * LA CONSOLE OUVRE-T-ELLE CE GESTE SUR CE MODULE À CETTE PERSONNE ? — le rôle, l'« autre rôle » et Administration › Accès,
 * tels que `getAccess` les a résolus, MOINS un geste qui ne tiendrait qu'à un intérim.
 *
 * `null` quand l'accès n'est pas résolu (une règle appelée hors session, avec un simple `{ role }`) : l'appelant retombe
 * alors sur le DÉFAUT de son rôle — exactement ce que la console donne à qui n'a aucun réglage.
 */
export function accesOuvertParLaConsole(acces: AccesStructurel | undefined | null, module: string, geste: string): boolean | null {
  if (!acces?.modules) return null;
  if (!(acces.modules.get(module)?.actions.has(geste) ?? false)) return false;
  return !(acces.pretes?.get(module)?.has(geste) ?? false);
}
