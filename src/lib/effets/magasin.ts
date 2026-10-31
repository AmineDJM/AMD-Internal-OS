import type { AsyncLocalStorage } from "node:async_hooks";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE MAGASIN DU CONTEXTE DE GESTE (J8, étendu par J7 — décision 0029) — sans dépendance : `prisma.ts`, la garde de
 * sortie et le stockage objet le lisent, et aucun d'eux ne peut importer `contexte-geste.ts` (qui lit la base).
 *
 * Un geste porte : son MODE (réel ou simulation), son PRINCIPAL (la personne au nom de qui il s'exécute), son origine
 * (carte, travail, mandat), le travail et l'étape, la clé d'idempotence — et, pendant qu'il s'exécute, ce qu'il a
 * écrit (`capture`) et le client de base qui le porte (`client` : la transaction annulée d'une simulation, ou le client
 * qui capture d'un geste réel journalisé).
 *
 * Le contexte ne se pose QUE par le code serveur (`contexte-geste.ts`, `effets/simulation.ts`, `effets/journal.ts`) :
 * aucune requête ne peut le fournir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export type ModeGeste = "REEL" | "SIMULATION";

/** D'où vient un geste d'agent — c'est ce qui le fait entrer au journal des effets. */
export type OrigineGeste = "carte" | "travail" | "mandat" | "hors-requete" | string;

/** Une écriture en base, telle que la capture l'a vue. Les valeurs sont SÉRIALISÉES (`effets/valeurs.ts`). */
export interface EcritureCapturee {
  modele: string;
  operation: "CREATE" | "UPDATE" | "DELETE" | "SQL";
  /** L'identifiant de la ligne — `null` pour une écriture en lot sans identifiant (createMany) ou du SQL brut. */
  id: string | null;
  avant: Record<string, unknown> | null;
  apres: Record<string, unknown> | null;
  champs: string[];
  /** Des écritures imbriquées (relation créée ou modifiée par la même requête) que la capture ne détaille pas. */
  imbriquee?: boolean;
  /** Lignes supprimées EN CASCADE avec celle-ci (comptées avant la suppression). */
  cascade?: number;
  /** Écriture en lot sans identifiant : combien de lignes. */
  nombre?: number;
}

/** Un effet qui serait sorti de la base (courriel, notification poussée, stockage, site, appel réseau). */
export interface EffetExterneCapture {
  acte: "COURRIEL" | "NOTIFICATION_PUSH" | "INVITATION_AGENDA" | "ECRITURE_EXTERNE" | "PAIEMENT" | "STOCKAGE" | "RESEAU";
  cible: string;
  apercu?: string;
  origine?: string;
  /** VRAI en simulation : rien n'est parti. FAUX en réel : l'effet a eu lieu (journalisé, irréversible). */
  neutralise: boolean;
}

export interface Capture {
  ecritures: EcritureCapturee[];
  effets: EffetExterneCapture[];
  /** Requêtes en cours et instant de la dernière : le geste est « calme » quand plus rien ne tourne (`capture.ts`). */
  enVol?: number;
  derniere?: number;
  /** Une écriture arrivée APRÈS l'inscription au journal (une promesse « au mieux » non attendue) : journalisée à part. */
  tardive?: (e: EcritureCapturee) => void;
}

export interface EtatGeste {
  mode: ModeGeste;
  /** La personne rendue par `requireUser` / `getCurrentUser` — seulement quand le geste la fournit (hors requête). */
  user: CurrentUser | null;
  principalId: string | null;
  origine: OrigineGeste;
  travailId?: string | null;
  etape?: string | null;
  cleIdempotence?: string | null;
  debut: number;
  capture: Capture | null;
  /** Le client Prisma du geste — `prisma.ts` y route toute requête tant que le geste dure. */
  client: unknown;
}

type ConstructeurAls = typeof AsyncLocalStorage;

/**
 * LE CONSTRUCTEUR, SANS IMPORT STATIQUE D'UN MODULE NODE : `prisma.ts` lit ce magasin, et des écrans client importent
 * (de loin) `prisma.ts` — un `import "node:async_hooks"` ici casse la compilation du navigateur (« Unhandled scheme »).
 * Côté serveur, Node le fournit (`process.getBuiltinModule`, ou le global posé par Next) ; côté navigateur, il n'y a ni
 * geste ni magasin.
 */
function constructeur(): ConstructeurAls | null {
  const g = globalThis as { AsyncLocalStorage?: ConstructeurAls; process?: { getBuiltinModule?: (n: string) => unknown } };
  if (typeof g.AsyncLocalStorage === "function") return g.AsyncLocalStorage;
  const m = g.process?.getBuiltinModule?.("node:async_hooks") as { AsyncLocalStorage?: ConstructeurAls } | undefined;
  return m?.AsyncLocalStorage ?? null;
}

const g = globalThis as { __amdMagasinGeste?: AsyncLocalStorage<EtatGeste> | null };
// UN SEUL magasin par processus, même si deux copies du module sont chargées (Next sépare parfois les couches).
const magasin: AsyncLocalStorage<EtatGeste> | null = (g.__amdMagasinGeste ??= (() => {
  const C = constructeur();
  return C ? new C<EtatGeste>() : null;
})());

export function etatDuGeste(): EtatGeste | null {
  return magasin?.getStore() ?? null;
}

export function sousGeste<T>(etat: EtatGeste, fn: () => T): T {
  if (!magasin) throw new Error("Un geste d'agent s'exécute côté serveur seulement (contexte asynchrone indisponible).");
  return magasin.run(etat, fn);
}

/**
 * LE PORT COMMUN : un effet externe va avoir lieu. En simulation, il est NOTÉ et NEUTRALISÉ (`true` : l'appelant ne
 * sort pas, il rend un succès simulé) ; en réel sous un geste journalisé, il est noté (`false` : l'appelant sort).
 * Hors de tout geste, rien n'est noté.
 */
export function noterEffetExterne(effet: Omit<EffetExterneCapture, "neutralise">): boolean {
  const e = etatDuGeste();
  if (!e) return false;
  const neutralise = e.mode === "SIMULATION";
  e.capture?.effets.push({ ...effet, neutralise });
  return neutralise;
}
