/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA RÈGLE DE L'ACCÈS PAR BASE (lot D2, décision 0057) — PURE.
 *
 * Réponses de la Direction (02/11/2026) : la base OUVRE et FERME ; réglage par rôle ET par personne, la personne prime ;
 * droits DATÉS et MOTIVÉS ; AUCUNE exception (le Super Admin aussi) — avec un garde-fou anti-verrouillage ; l'accès à SES
 * PROPRES données quand la base est fermée se règle base par base.
 *
 *   NORMAL         les modules décident seuls (aucun réglage en vigueur).
 *   LECTURE_SEULE  on lit ce que les modules permettent ; on n'écrit rien dans la base.
 *   FERMEE         ni lecture ni écriture, quel que soit le module.
 *   OUVERTE        lecture de toute la base même sans module (+ écriture si `ecriture`) — SOUS les gardes par ligne
 *                  d'aujourd'hui : périmètre d'entité, et S1 (les valeurs sensibles d'AUTRUI restent fermées sans droit
 *                  RH, avenant ou droit daté ; seule la base Paie OUVERTE nommément les montre, et c'est journalisé).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { CATALOGUE_BASES } from "./catalogue.genere";
import type { BaseCatalogue, DroitBase, DroitModules, NiveauBase, NiveauResolu, NiveauStocke, ReglageBase } from "./types";

export const LIBELLE_NIVEAU_BASE: Record<NiveauBase, string> = {
  NORMAL: "Normal",
  LECTURE_SEULE: "Lecture seule",
  FERMEE: "Fermée",
  OUVERTE: "Ouverte",
};

const PAR_CLE = new Map(CATALOGUE_BASES.map((b) => [b.cle, b]));
const TABLE_VERS_BASE = new Map(CATALOGUE_BASES.flatMap((b) => b.tables.map((t) => [t, b.cle] as const)));

export const baseDe = (cle: string): BaseCatalogue | null => PAR_CLE.get(cle) ?? null;
export const estBase = (cle: unknown): cle is string => typeof cle === "string" && PAR_CLE.has(cle);

/** La base d'un modèle Prisma (`Employee`, ou l'accesseur `employee`). Null si inconnu. */
export function baseDuModele(modele: string): string | null {
  if (!modele) return null;
  return TABLE_VERS_BASE.get(modele) ?? TABLE_VERS_BASE.get(modele[0].toUpperCase() + modele.slice(1)) ?? null;
}

/** Les bases où une personne garde, par défaut, l'accès à SES PROPRES données quand la base lui est fermée (son dossier). */
const PROPRES_DONNEES_PAR_DEFAUT: ReadonlySet<string> = new Set(["personnel", "paie", "recrutement"]);
export function propresDonneesParDefaut(base: string): boolean {
  return PROPRES_DONNEES_PAR_DEFAUT.has(base);
}

/** Un réglage vaut-il À CET INSTANT ? (commencé, pas fini — le jour de fin compris —, pas révoqué) */
export function enVigueur(r: Pick<ReglageBase, "du" | "au" | "revoqueLe">, maintenant: Date): boolean {
  if (r.revoqueLe && r.revoqueLe <= maintenant) return false;
  if (r.du > maintenant) return false;
  if (r.au) {
    const finDuJour = new Date(r.au);
    finDuJour.setUTCHours(23, 59, 59, 999);
    if (finDuJour < maintenant) return false;
  }
  return true;
}

/** Du plus restrictif au moins restrictif : entre deux réglages de rôle, le plus restrictif l'emporte. */
const RANG: Record<NiveauStocke, number> = { FERMEE: 0, LECTURE_SEULE: 1, OUVERTE: 2 };

/**
 * LE NIVEAU D'UNE BASE POUR UNE PERSONNE. Un réglage NOMINATIF en vigueur prime sur tout (le plus récent, s'il y en a
 * plusieurs) ; sinon, parmi les réglages de ses rôles (principal et secondaire), le plus restrictif ; sinon « Normal ».
 */
export function niveauPour(
  personne: { userId: string; roles: readonly (string | null | undefined)[] },
  base: string,
  reglages: readonly ReglageBase[],
  maintenant: Date,
): NiveauResolu {
  const vivants = reglages.filter((r) => r.base === base && enVigueur(r, maintenant));
  const nominatifs = vivants.filter((r) => r.userId === personne.userId).sort((a, b) => +b.du - +a.du);
  if (nominatifs.length) {
    const r = nominatifs[0];
    return { niveau: r.niveau, ecriture: r.niveau === "OUVERTE" && r.ecriture, source: "personne", reglageId: r.id };
  }
  const roles = new Set(personne.roles.filter((x): x is string => !!x));
  const deRole = vivants.filter((r) => r.role && roles.has(r.role)).sort((a, b) => RANG[a.niveau] - RANG[b.niveau] || +b.du - +a.du);
  if (deRole.length) {
    const r = deRole[0];
    return { niveau: r.niveau, ecriture: r.niveau === "OUVERTE" && r.ecriture, source: "role", reglageId: r.id };
  }
  return { niveau: "NORMAL", ecriture: false, source: "defaut", reglageId: null };
}

/** Ce que les modules d'une personne donnent sur une base (au moins un module de la base). */
export function droitParModules(base: BaseCatalogue, peut: (module: string, geste: string) => boolean): DroitModules {
  const lecture = base.modules.some((m) => peut(m, base.lectureExige ?? "VIEW"));
  const ecriture = base.modules.some((m) => ["CREATE", "UPDATE", "DELETE", "VALIDATE", "UPLOAD"].some((g) => peut(m, g)));
  return { lecture, ecriture };
}

/** LE DROIT EFFECTIF : modules ET niveau de base. Ne lit rien, ne décide rien d'autre — les gardes par ligne restent après. */
export function droitEffectif(modules: DroitModules, n: NiveauResolu, nomBase: string): DroitBase {
  const via = n.source === "personne" ? "réglage nominatif" : n.source === "role" ? "réglage de son rôle" : "";
  switch (n.niveau) {
    case "FERMEE":
      return { lecture: false, ecriture: false, niveau: n.niveau, source: n.source, chemin: `Base « ${nomBase} » fermée (${via})` };
    case "LECTURE_SEULE":
      return {
        lecture: modules.lecture, ecriture: false, niveau: n.niveau, source: n.source,
        chemin: modules.lecture ? `Lecture par ses modules ; écriture retirée (${via})` : `Lecture seule (${via}), mais aucun module ne lui ouvre la base`,
      };
    case "OUVERTE":
      return {
        lecture: true, ecriture: n.ecriture || modules.ecriture, niveau: n.niveau, source: n.source,
        chemin: `Base ouverte${n.ecriture ? " en lecture et écriture" : " en lecture"} (${via})`,
      };
    default:
      return {
        lecture: modules.lecture, ecriture: modules.ecriture, niveau: "NORMAL", source: "defaut",
        chemin: modules.lecture ? "Par ses modules" : "Aucun module ne lui ouvre la base",
      };
  }
}

/**
 * LE GARDE-FOU ANTI-VERROUILLAGE (Direction, 02/11) : aucune exception, le Super Admin aussi est soumis — mais on ne
 * peut pas fermer « Comptes & droits » (la console d'accès) au DERNIER Super Admin actif. Rend la raison du refus, ou null.
 *
 * `superAdminsAccesConsole` : les Super Admins actifs qui, APRÈS le réglage envisagé, garderaient la console (niveau ≠
 * FERMEE et ≠ LECTURE_SEULE sur « comptes-et-droits ») — l'appelant le calcule avec `niveauPour` sur la liste augmentée.
 */
export const BASE_CONSOLE = "comptes-et-droits";
export function refusVerrouillage(base: string, niveau: NiveauStocke, superAdminsAccesConsoleApres: number): string | null {
  if (base !== BASE_CONSOLE || niveau === "OUVERTE") return null;
  if (superAdminsAccesConsoleApres > 0) return null;
  return "Refusé : ce réglage fermerait « Comptes, connexions & droits d'accès » — donc la console d'accès — au dernier Super Admin actif. Personne ne pourrait plus la rouvrir.";
}

/** Un réglage restrictif qui toucherait un Super Admin exige une confirmation explicite. */
export const touchePlusRestrictifSuperAdmin = (niveau: NiveauStocke, visesSuperAdmins: number): boolean =>
  niveau !== "OUVERTE" && visesSuperAdmins > 0;
