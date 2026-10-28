import type { Authority } from "./payment-authority";

/**
 * QUI PORTE QUELLE AUTORITÉ — la règle de résolution, isolée et testable.
 *
 * Le principe est posé une fois : une autorité se rattache à un RÔLE, jamais à une personne.
 * « Le directeur des opérations » valide, quel que soit celui qui occupe le poste — le jour où
 * la personne change, il n'y a rien à reprogrammer et aucune validation ne se retrouve orpheline.
 *
 * UNE SEULE EXCEPTION, assumée : la DIRECTION GÉNÉRALE est nominative. C'est une signature
 * personnelle, pas une fonction interchangeable — et c'est précisément pour ça qu'elle peut se
 * TRANSFÉRER nommément à quelqu'un d'autre, en laissant une trace de qui a signé à la place de
 * qui.
 *
 * Module PUR — testé.
 */

export interface HolderConfig {
  authority: Authority;
  /** Rôles porteurs — le cas normal. */
  roles: string[];
  /** Titulaires nommés — l'exception (direction générale). */
  userIds: string[];
  /** Transfert actif : la personne qui exerce l'autorité à la place du titulaire. */
  delegatedToUserId?: string | null;
}

export interface SubjectLike {
  id: string;
  role: string;
  secondaryRole?: string | null;
}

/**
 * Les autorités qu'une personne porte, à cet instant.
 *
 * Le second rôle compte autant que le premier : quelqu'un nommé référent Direction Marketing « en plus » de
 * sa fonction exerce réellement cette autorité, et l'ignorer bloquerait des chaînes que
 * l'entreprise croit fluides.
 */
export function authoritiesOf(subject: SubjectLike, config: readonly HolderConfig[]): Authority[] {
  const out: Authority[] = [];
  for (const h of config) {
    const byRole = h.roles.includes(subject.role)
      || (subject.secondaryRole ? h.roles.includes(subject.secondaryRole) : false);
    const byName = h.userIds.includes(subject.id);
    // Un transfert DONNE l'autorité au destinataire, le temps qu'il dure.
    const byDelegation = h.delegatedToUserId === subject.id;
    if (byRole || byName || byDelegation) out.push(h.authority);
  }
  return out;
}

/**
 * Le titulaire d'une autorité est-il DÉFINI ? Une chaîne dont une étape n'a aucun porteur ne
 * peut jamais s'achever : mieux vaut le dire à la configuration qu'attendre qu'un paiement
 * reste bloqué sans que personne ne comprenne pourquoi.
 */
export function isOrphan(h: HolderConfig): boolean {
  return h.roles.length === 0 && h.userIds.length === 0 && !h.delegatedToUserId;
}

/** Les autorités sans titulaire — à signaler en Console d'Administration. */
export function orphanAuthorities(config: readonly HolderConfig[]): Authority[] {
  return config.filter(isOrphan).map((h) => h.authority);
}

/**
 * Une autorité NOMINATIVE (titulaires nommés) peut se transférer ; une autorité portée par un
 * rôle, non — transférer « le directeur des opérations » ne veut rien dire, il suffit de
 * changer qui porte le rôle.
 */
export function isNominative(h: HolderConfig): boolean {
  return h.userIds.length > 0;
}
