import { plier } from "@/lib/utils";
/**
 * LES PARTIES — ce qui S'AFFICHE, et ce qui se CLIQUE.
 *
 * Une partie à un contrat, l'expéditeur d'un courrier, son destinataire : trois champs qui
 * étaient du texte libre. On y écrivait « Sarl Imprimerie du Centre », « imprimerie centre »,
 * « IMPRIMERIE DU CENTRE (M. Belkacem) » — trois orthographes pour un seul prestataire, dont
 * aucune ne portait un numéro de téléphone. Le jour où il faut le joindre, on cherche sur une
 * vieille facture.
 *
 * Désormais elles se CHOISISSENT dans l'annuaire de l'entreprise. Ce qui s'affiche reste le nom
 * (ou l'institution) — une fiche de contrat n'a pas à porter un pavé de coordonnées — mais ce
 * nom s'OUVRE : le mail, les téléphones, la personne à demander sont là, sous le clic.
 *
 * ── MODULE PUR ───────────────────────────────────────────────────────────────────────────────
 *
 * Il n'importe RIEN : ni Prisma, ni le RBAC, ni un module qui lit des fichiers. C'est ce qui lui
 * permet d'être importé par le sélecteur, qui est un composant CLIENT (voir la doctrine
 * « frontière client / serveur » : un `"use client"` qui remonte jusqu'à `fs` casse la
 * compilation de production, et le typecheck ne le voit pas).
 */

export interface PartyOption {
  id: string;
  /** Ce qui s'affiche : la raison sociale ou l'institution. */
  name: string;
  /** Le métier (« Imprimeur », « Transitaire ») — ce par quoi on cherche le plus souvent. */
  kind: string | null;
  /** La personne qu'on demande au téléphone. */
  contactName: string | null;
  email: string | null;
  phone: string | null;
  phoneAlt: string | null;
  city: string | null;
  /** L'entité de rattachement, quand il y en a une. */
  companyLabel: string | null;
}

/** Ce qui s'affiche d'une partie, et rien de plus. Le reste est sous le clic. */
export function partyLabel(p: PartyOption): string {
  return p.name;
}

/**
 * LE TEXTE ENREGISTRÉ à côté des identifiants.
 *
 * Les colonnes `counterparty`, `sender` et `recipient` restent du TEXTE : la recherche, les
 * exports, les briefs exécutifs et les outils d'Adam les lisent tel quel, et les réécrire tous
 * pour aller chercher un nom dans une seconde table n'aurait rien apporté à personne. Le serveur
 * les tient donc à jour à partir de la sélection — jamais l'inverse.
 *
 * L'ordre suit celui de la SÉLECTION, pas celui de l'annuaire : « nous et eux » n'est pas « eux
 * et nous ».
 */
export function partiesText(options: readonly PartyOption[], ids: readonly string[]): string {
  const byId = new Map(options.map((o) => [o.id, o]));
  const noms = ids.map((id) => byId.get(id)?.name).filter((n): n is string => Boolean(n));
  return noms.join(", ");
}

/** Les parties retenues, dans l'ordre choisi — les identifiants inconnus sont écartés. */
export function resolveParties(options: readonly PartyOption[], ids: readonly string[]): PartyOption[] {
  const byId = new Map(options.map((o) => [o.id, o]));
  return ids.map((id) => byId.get(id)).filter((p): p is PartyOption => Boolean(p));
}

/**
 * LA RECHERCHE — les trois entrées réelles : le métier, le nom, ou quelques chiffres du numéro.
 *
 * On ne se souvient pas de la raison sociale du traiteur ; on sait qu'on veut un traiteur. Et
 * l'on arrive parfois avec une facture à la main, dont on ne lit que le numéro.
 */
export function matchesParty(p: PartyOption, query: string): boolean {
  const q = plier(query.trim());
  if (!q) return true;
  const champs = [p.name, p.kind, p.contactName, p.email, p.city, p.companyLabel, p.phone, p.phoneAlt];
  return champs.some((c) => c && plier(c).includes(q));
}

/**
 * COMBIEN DE PARTIES ce champ accepte. `1` pour un expéditeur ou un destinataire — un pli part
 * d'un endroit et arrive à un autre ; `Infinity` pour les parties d'un contrat, qui sont
 * réellement plusieurs (co-traitance, groupement, avenant tripartite).
 */
export type PartyArity = 1 | "many";

/** Ce que produit une sélection quand on ajoute `id`, en respectant la cardinalité. */
export function withParty(ids: readonly string[], id: string, arity: PartyArity): string[] {
  if (ids.includes(id)) return [...ids];
  return arity === 1 ? [id] : [...ids, id];
}
