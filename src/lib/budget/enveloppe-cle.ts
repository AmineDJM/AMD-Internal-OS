/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CLÉ D'UNE ENVELOPPE — (société, direction, année). Jamais le nom (Super Admin, 25/11/2026).
 *
 * Les doublons relevés en production venaient tous du même défaut : chaque ouverture « d'office » cherchait SON
 * enveloppe à sa façon (un code dans `module`, une catégorie reconnaissable, un domaine, parfois rien) et en créait une
 * seconde dès que sa recherche ne voyait pas la première — « Administration » créée à la main, puis « Administration
 * 2026 » ouverte par les charges fixes ; « Operations & Sales 2026 » d'Adventum, puis la même sans société. Une clé
 * unique, lue de la même façon par tous, et une seule fonction qui crée (`enveloppe-unique.ts`) : la seconde ne naît plus.
 *
 * LA DIRECTION d'une enveloppe :
 *   • un DOMAINE de pôle (MARKETING, REGULATORY, OPERATIONS) — l'enveloppe d'un budget de pôle ;
 *   • sinon un CODE porté par `module` (ADMINISTRATION, IMPOTS_TAXES, INFORMATIQUE, DEPARTEMENT:<id>…) ou, pour une
 *     enveloppe générale créée à la main, son premier module couvert ;
 *   • `null` : une enveloppe LIBRE (générale, sans module) — elle n'a pas de direction, il n'y a rien à dédoublonner.
 *
 * Module PUR (aucun import lourd) : lu par les écrans (le nom de la société à côté de l'enveloppe) et par le serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const DOMAINES_DIRECTION = ["MARKETING", "REGULATORY", "OPERATIONS"] as const;

/** Les codes de direction posés dans `module` par les ouvertures d'office — jamais un module de l'application. */
export const CODES_DIRECTION = ["ADMINISTRATION", "IMPOTS_TAXES", "INFORMATIQUE"] as const;

/** Le préfixe du code d'une enveloppe de pôle ouverte par la campagne budgétaire pour un département sans autre code. */
export const PREFIXE_DEPARTEMENT = "DEPARTEMENT:";

export interface CleEnveloppe {
  companyId: string | null;
  annee: number;
  /** Domaine de pôle ou code de direction ; `null` = enveloppe libre (jamais dédoublonnée). */
  direction: string | null;
  /** Le périmètre d'une enveloppe de pôle. `undefined` = indifférent (ouverture d'office) ; `null` = sans BU. */
  businessUnitId?: string | null;
  productId?: string | null;
}

export interface EnveloppePourCle {
  companyId: string | null;
  domaine: string;
  module: string | null;
  modules: readonly string[];
  periodStart: Date;
  businessUnitId?: string | null;
  productId?: string | null;
}

export const estDomaineDirection = (d: string | null | undefined): boolean =>
  !!d && (DOMAINES_DIRECTION as readonly string[]).includes(d);

/** Un code de direction (ADMINISTRATION, DEPARTEMENT:…) — à garder quand on édite les modules couverts. */
export const estCodeDirection = (m: string | null | undefined): boolean =>
  !!m && ((CODES_DIRECTION as readonly string[]).includes(m) || m.startsWith(PREFIXE_DEPARTEMENT));

/** La direction d'une enveloppe existante (voir l'en-tête). */
export function directionDe(e: Pick<EnveloppePourCle, "domaine" | "module" | "modules">): string | null {
  if (estDomaineDirection(e.domaine)) return e.domaine;
  return e.module ?? e.modules[0] ?? null;
}

/** L'année d'une enveloppe : celle de son début. */
export const anneeDe = (e: Pick<EnveloppePourCle, "periodStart">): number => e.periodStart.getUTCFullYear();

/** La clé en texte — sert le verrou de base et les messages. Le périmètre n'y entre que s'il est dit. */
export function texteCle(c: CleEnveloppe): string {
  const perimetre = c.businessUnitId !== undefined || c.productId !== undefined ? `:${c.businessUnitId ?? "-"}:${c.productId ?? "-"}` : "";
  return `${c.companyId ?? "groupe"}:${c.direction ?? "libre"}:${c.annee}${perimetre}`;
}

/** Cette enveloppe répond-elle à la clé (société mise à part) ? */
export function memeDirection(e: EnveloppePourCle, c: CleEnveloppe): boolean {
  if (c.direction === null) return false;
  if (anneeDe(e) !== c.annee) return false;
  if (estDomaineDirection(c.direction)) {
    if (e.domaine !== c.direction) return false;
  } else {
    if (estDomaineDirection(e.domaine)) return false;
    if (!(e.module === c.direction || (e.module === null && e.modules.includes(c.direction)))) return false;
  }
  if (c.businessUnitId !== undefined && (e.businessUnitId ?? null) !== c.businessUnitId) return false;
  if (c.productId !== undefined && (e.productId ?? null) !== c.productId) return false;
  return true;
}

/**
 * L'ENVELOPPE QUI RÉPOND À LA CLÉ parmi des candidates (même direction, même année), ou `null`.
 *
 * - La société d'abord ; à défaut, une enveloppe du GROUPE (sans société) de la même direction la sert, comme avant.
 * - Une clé SANS société (une personne sans rattachement) : l'enveloppe du groupe, sinon — LA RÈGLE DU DOUBLON —
 *   l'unique enveloppe de société de cette direction et de cette année. C'est exactement le cas qui a doublé
 *   « Operations & Sales 2026 » ; s'il y en a plusieurs, on ne devine pas une société.
 * - Entre deux candidates (un doublon ancien, en attendant son dédoublonnage) : l'active, puis la plus ancienne.
 */
export function choisirEnveloppe<E extends EnveloppePourCle & { id: string; isActive: boolean; createdAt: Date }>(candidates: readonly E[], c: CleEnveloppe): E | null {
  const ok = candidates.filter((e) => memeDirection(e, c));
  const ordre = (a: E, b: E) => Number(b.isActive) - Number(a.isActive) || a.createdAt.getTime() - b.createdAt.getTime();
  const premiere = (xs: E[]) => (xs.length ? [...xs].sort(ordre)[0]! : null);
  if (c.companyId) return premiere(ok.filter((e) => e.companyId === c.companyId)) ?? premiere(ok.filter((e) => e.companyId === null));
  const groupe = premiere(ok.filter((e) => e.companyId === null));
  if (groupe) return groupe;
  const societes = new Set(ok.map((e) => e.companyId));
  return societes.size === 1 ? premiere(ok) : null;
}

/**
 * LE NOM D'UNE ENVELOPPE, avec sa société quand plusieurs sociétés existent (« Administration 2026 · Pharmagène »).
 * Trois « Informatique 2026 » ne sont pas un doublon — une par société — mais rien ne le disait à l'écran.
 */
export function nomAvecSociete(nom: string, societe: string | null | undefined): string {
  return societe ? `${nom} · ${societe}` : nom;
}
