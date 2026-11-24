/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * OÙ MÈNE « VISITE MÉDICALE » — l'aiguillage par métier (Super Admin, 11/2026).
 *
 * Le menu pointait en dur sur « Ma journée » : tout le monde — Super Admin, directeur des
 * opérations, managers — arrivait sur l'écran du DÉLÉGUÉ, et lisait « 0 / 0 visites » ou « Aucun
 * praticien rattaché — chez votre superviseur » d'un compte qui n'a ni tournée ni superviseur.
 * L'entrée pointe désormais sur `/medical`, et `/medical` décide ICI, une fois :
 *
 *   • la DIRECTION (Super Admin, Direction, Directeur Général, Directeur des opérations) → le
 *     Cockpit Opérations, son écran de tête ;
 *   • le DÉLÉGUÉ (il saisit des visites ET il est un homme de terrain : rattaché comme KAM, porteur
 *     d'un panel, ou délégué / National Sales qui ne supervise aucune BU) → « Ma journée » ;
 *   • le SUPERVISEUR ou le MANAGER → l'écran de son équipe (Force de vente › Pilotage, sur sa BU) ;
 *   • tous les autres → le plan de tournée, comme avant.
 *
 * ── POURQUOI UN DÉLÉGUÉ SANS PANEL VA QUAND MÊME SUR « MA JOURNÉE » ──────────────────────────
 *
 * C'est là que le panel vide DIT sa cause et offre « Prévenir mon superviseur ». L'envoyer ailleurs
 * parce que son panel est vide lui cacherait précisément le remède.
 *
 * Module PUR — aucune base : les faits sont lus par `queries/aiguillage-visite.ts`.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Les rôles de tête : leur écran est le Cockpit Opérations. */
const ROLES_DIRECTION = ["SUPER_ADMIN", "DIRECTION", "GENERAL_MANAGER", "OPERATIONS_DIRECTOR"] as const;
/** Les rôles de terrain : un délégué médical, ou un National Sales (capacités du délégué). */
const ROLES_TERRAIN = ["MEDICAL_DELEGATE", "NATIONAL_SALES"] as const;
/** Les rôles d'encadrement du terrain, même sans BU désignée. */
const ROLES_ENCADREMENT = ["MEDICAL_PROMOTION_MANAGER", "HEAD_OF_SALES"] as const;

export interface FaitsAiguillage {
  /** Rôle principal et rôle secondaire (une casquette prêtée compte : c'est le métier qu'on exerce). */
  roles: readonly string[];
  /** Peut saisir une visite (`MEDICAL` · `CREATE`). */
  peutSaisir: boolean;
  /** Rattaché comme KAM à une BU (`SalesRepProfile`). */
  estKam: boolean;
  /** Son panel compte au moins un praticien. */
  aUnPanel: boolean;
  /** Les BU dont il est le superviseur (ou le chef), dans l'ordre d'affichage. */
  busSupervisees: readonly string[];
  /** Ouvre le Cockpit Opérations. */
  voitCockpit: boolean;
  /** Ouvre la Force de vente. */
  voitForceDeVente: boolean;
}

export type Destination = "COCKPIT" | "JOURNEE" | "EQUIPE" | "PLAN";

const aUnDe = (roles: readonly string[], liste: readonly string[]) => roles.some((r) => liste.includes(r));

/**
 * Le délégué : il saisit, et il est de terrain — rattaché comme KAM, porteur d'un panel, ou d'un rôle de terrain.
 * Un National Sales qui SUPERVISE une BU sans tournée à lui (ni rattachement ni panel) est un superviseur : son
 * écran est celui de son équipe, pas une journée vide.
 */
export function estDelegue(f: FaitsAiguillage): boolean {
  return f.peutSaisir && (f.estKam || f.aUnPanel || (aUnDe(f.roles, ROLES_TERRAIN) && f.busSupervisees.length === 0));
}

export function destinationVisite(f: FaitsAiguillage): Destination {
  // LA DIRECTION D'ABORD : un Super Admin qui aurait un panel de test n'en devient pas délégué.
  if (aUnDe(f.roles, ROLES_DIRECTION) && f.voitCockpit) return "COCKPIT";
  if (estDelegue(f)) return "JOURNEE";
  if ((f.busSupervisees.length > 0 || aUnDe(f.roles, ROLES_ENCADREMENT)) && f.voitForceDeVente) return "EQUIPE";
  // Une tête sans Cockpit ouvert (réglage de la console) retombe sur son équipe, puis sur le plan.
  if (aUnDe(f.roles, ROLES_DIRECTION) && f.voitForceDeVente) return "EQUIPE";
  return "PLAN";
}

/** L'adresse de la destination — la BU du superviseur filtre l'écran d'équipe. */
export function cheminDeDestination(d: Destination, busSupervisees: readonly string[] = []): string {
  if (d === "COCKPIT") return "/operations";
  if (d === "JOURNEE") return "/medical/ma-journee";
  if (d === "EQUIPE") return busSupervisees[0] ? `/planning?bu=${encodeURIComponent(busSupervisees[0])}` : "/planning";
  return "/medical/plan-de-tournee";
}
