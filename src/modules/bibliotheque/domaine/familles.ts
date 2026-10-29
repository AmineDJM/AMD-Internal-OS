/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CLÉS D'ACCÈS — « FAMILLE:id » : l'endroit où une pièce est rangée, et donc la règle qui dit qui
 * peut l'ouvrir (J1, décision du 29/10/2026).
 *
 * Une pièce lue une fois (une empreinte) peut être rangée à plusieurs endroits : le même PDF au Drive et
 * en pièce jointe d'une conversation. Sa fiche porte UNE clé par endroit ; la recherche la rend à qui peut
 * ouvrir AU MOINS l'un d'eux — par la règle même de l'écran qui sert le fichier (`infra/acces.ts`), jamais
 * par une règle recopiée ici.
 *
 * EXCLUSIVE : l'endroit ne désigne qu'UN contenu à la fois (la version courante d'un fichier du Drive,
 * le fichier d'un `Document` réécrit par l'éditeur, l'enregistrement d'une réunion remplacé). Inscrire un
 * nouveau contenu sous cette clé la RETIRE des autres pièces : une ancienne version ne ressort plus.
 *
 * Module pur, sans import : lu par le navigateur (écran de recherche) comme par le serveur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const FAMILLES = {
  DRIVE_NODE: { libelle: "Drive", exclusive: true, lien: (id: string) => `/drive/${id}` },
  DOCUMENT: { libelle: "Pièce d'un dossier", exclusive: true, lien: (id: string) => `/api/documents/${id}` },
  MESSAGE_PIECE: { libelle: "Messagerie", exclusive: false, lien: (id: string) => `/api/messaging/attachment/${id}` },
  SUJET_PIECE: { libelle: "Sujet", exclusive: false, lien: (id: string) => `/api/dossiers/message-attachment/${id}` },
  REUNION_PIECE: { libelle: "Réunion", exclusive: false, lien: (id: string) => `/api/meetings/message-attachment/${id}` },
  REUNION_AUDIO: { libelle: "Enregistrement de réunion", exclusive: true, lien: (id: string) => `/meetings/${id}` },
  RH_DOCUMENT: { libelle: "Dossier RH", exclusive: false, lien: (id: string) => `/api/rh/document/${id}` },
  TERRAIN_PIECE: { libelle: "Rapport terrain", exclusive: false, lien: (id: string) => `/api/field-reports/attachment/${id}` },
  TERRAIN_AUDIO: { libelle: "Vocal de rapport terrain", exclusive: true, lien: (id: string) => `/field-reports/${id}` },
  RETOUR_PIECE: { libelle: "Retour", exclusive: false, lien: (id: string) => `/api/feedback/attachment/${id}` },
  KPI_PIECE: { libelle: "Déclaration de KPI", exclusive: true, lien: (id: string) => `/api/kpi/piece/${id}` },
} as const satisfies Record<string, { libelle: string; exclusive: boolean; lien: (id: string) => string }>;

export type Famille = keyof typeof FAMILLES;
export const NOMS_FAMILLES = Object.keys(FAMILLES) as Famille[];

export function estFamille(f: string): f is Famille {
  return Object.prototype.hasOwnProperty.call(FAMILLES, f);
}

/** La clé d'accès d'un endroit. Un identifiant vide ou porteur d'un « : » est refusé (la clé serait ambiguë). */
export function cleAcces(famille: Famille, id: string): string {
  const i = (id ?? "").trim();
  if (!i || i.includes(":")) throw new Error(`identifiant d'objet invalide pour ${famille} : « ${id} »`);
  return `${famille}:${i}`;
}

/** Relit une clé ; `null` pour une clé d'une famille inconnue (elle n'ouvre rien). */
export function lireCle(cle: string): { famille: Famille; id: string } | null {
  const k = cle.indexOf(":");
  if (k <= 0) return null;
  const famille = cle.slice(0, k);
  const id = cle.slice(k + 1);
  return estFamille(famille) && id ? { famille, id } : null;
}

/** Les familles distinctes d'une liste de clés (la projection `familles` de la fiche). */
export function famillesDe(cles: readonly string[]): Famille[] {
  return [...new Set(cles.map((c) => lireCle(c)?.famille).filter((f): f is Famille => !!f))].sort();
}

/** Où ouvrir la pièce depuis cette clé (l'écran ou la route qui la sert, sous ses propres droits). */
export function lienDe(cle: string): string | null {
  const c = lireCle(cle);
  return c ? FAMILLES[c.famille].lien(c.id) : null;
}
