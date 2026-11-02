/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — L'ESPION DE PRISMA : la PREUVE qu'une ligne d'autrui n'a jamais été lue.
 *
 * Un refus poli ne prouve rien : le serveur a pu lire la paie, la jetonner, et seul le révélateur l'a cachée. L'espion
 * se branche sur le client Prisma du processus (`$use`, appelé pour chaque requête du modèle ET les requêtes brutes)
 * et regarde chaque RÉSULTAT rendu par la base pendant le tour joué : un témoin interdit à la persona qui y figure est
 * une LECTURE — la ligne est sortie de la base pour ce tour. Ce n'est pas une fuite (la valeur n'a pas atteint la
 * personne), c'est une défense en profondeur manquante, dite au rapport avec le modèle et l'opération en cause.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { PrismaClient } from "@prisma/client";
import { fuites, type Temoin } from "./verdicts";

export interface Lecture { modele: string; operation: string; temoin: string; nature: string }

type Middleware = (params: { model?: string; action: string }, next: (p: unknown) => Promise<unknown>) => Promise<unknown>;

let interdits: readonly Temoin[] | null = null;
let lues: Lecture[] = [];
let installe = false;

const enTexte = (r: unknown): string => {
  try {
    return JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? v.toString() : v)) ?? "";
  } catch {
    return "";
  }
};

/** Branche l'espion une fois par processus. Sans tour en cours, il ne fait rien (coût nul). */
export function installerEspion(client: PrismaClient): void {
  if (installe) return;
  installe = true;
  const espion: Middleware = async (params, next) => {
    const r = await next(params);
    if (interdits?.length && r != null) {
      for (const f of fuites(enTexte(r), interdits, "base")) {
        lues.push({ modele: params.model ?? "(requête brute)", operation: params.action, temoin: f.temoin.libelle, nature: f.temoin.nature });
      }
    }
    return r;
  };
  (client as unknown as { $use: (m: Middleware) => void }).$use(espion);
}

/** Ouvre la fenêtre d'un tour : les témoins interdits à la persona qui le joue. */
export function ecouter(t: readonly Temoin[]): void {
  interdits = t;
  lues = [];
}

/** Ferme la fenêtre et rend les lectures (dédoublonnées) — rien n'est plus écouté ensuite. */
export function relever(): Lecture[] {
  const out = lues;
  interdits = null;
  lues = [];
  const vus = new Set<string>();
  return out.filter((l) => {
    const k = `${l.modele}|${l.operation}|${l.temoin}`;
    if (vus.has(k)) return false;
    vus.add(k);
    return true;
  });
}
