import type { CurrentUser } from "@/lib/session";
import type { Module } from "@/lib/rbac";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OPÉRATIONS DE L'ASSISTANT IA — l'agent qui AGIT dans l'ERP, sans jamais écrire lui-même.
 *
 * Une opération = un geste de l'écran (créer une demande de sponsoring, ajouter un poste…) en
 * DEUX temps, séparés par la personne :
 *
 *   1. `proposer` (pendant le tour) — LIT avec les droits de la personne, CONTRÔLE avant de
 *      remplir (doublons, pièces exigées, seuil de validation, budget quand il se lit), et rend :
 *        • `manque` : ce qu'il faut encore demander — l'agent pose UNE question à la fois ;
 *        • ou une CARTE récapitulative + les `args` mémorisés sur une intention ;
 *   2. `executer` (au clic « Confirmer », dans la requête de la personne) — appelle L'ACTION
 *      MÉTIER DE L'ÉCRAN avec ces `args`. Elle revérifie tout : droit, champs, pièces. Jamais
 *      d'écriture directe en base, jamais de chemin parallèle à celui de l'écran.
 *
 * Pourquoi un registre À PART des « ops » d'Adam (`lib/assistant/ops`) : ce sont deux produits.
 * Les décisions prises pour Adam (en pause, gestes exclus) ne doivent pas lier l'Assistant IA, et
 * l'inverse. Le MÉCANISME est partagé — intention persistée, réclamation atomique, reçu, refus
 * de rejouer (`executeIntentGuarded`) —, les gestes ne le sont pas.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface CarteOperation {
  title: string;
  fields: { label: string; value: string }[];
  /** Ce que la personne doit savoir AVANT de confirmer : doublon possible, seuil, pièce, budget. */
  warnings: string[];
  level?: "SENSITIVE" | "CRITICAL";
  confirmText?: string;
}

export type PropositionOperation =
  | { manque: string[]; precision?: string }
  | { erreur: string }
  | { carte: CarteOperation; args: Record<string, string | null> };

export interface ResultatOperation {
  ok: boolean;
  message?: string;
  error?: string;
  link?: string;
  revalidate?: string[];
}

export interface OperationIA {
  /** Nom de l'outil vu par le modèle. */
  nom: string;
  /** Module RBAC qui garde le geste (affiché, et revérifié par l'action métier). */
  module: Module;
  /** Libellé humain (« Sponsoring préparé »). */
  libelle: string;
  description: string;
  schema: Record<string, unknown>;
  /** Pré-filtre : l'outil n'est même pas offert à qui ne peut pas faire le geste à l'écran. */
  ouverte: (user: CurrentUser) => boolean;
  proposer: (entree: Record<string, unknown>, user: CurrentUser) => Promise<PropositionOperation>;
  executer: (args: Record<string, string | null>, user: CurrentUser) => Promise<ResultatOperation>;
}

/** La charge d'une intention de l'Assistant IA — exécutée par SON registre, jamais par celui d'Adam. */
export interface ChargeOperationIA {
  kind: "assistant_ia_op";
  op: string;
  args: Record<string, string | null>;
}

export const estChargeOperationIA = (p: unknown): p is ChargeOperationIA =>
  !!p && typeof p === "object" && (p as { kind?: unknown }).kind === "assistant_ia_op" && typeof (p as { op?: unknown }).op === "string";

export const texte = (e: Record<string, unknown>, cle: string): string =>
  typeof e[cle] === "string" ? (e[cle] as string).trim() : typeof e[cle] === "number" ? String(e[cle]) : "";

export const nombre = (e: Record<string, unknown>, cle: string): number | null => {
  const v = e[cle];
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[\s  ]/g, "").replace(",", ".")) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Une liste écrite par le modèle : tableau, ou texte séparé par virgules / points-virgules. */
export const liste = (e: Record<string, unknown>, cle: string): string[] => {
  const v = e[cle];
  const brut = Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/[;,\n]/) : [];
  return [...new Set(brut.map((x) => x.trim()).filter(Boolean))];
};

export const champs = (pairs: [string, string | null | undefined][]) =>
  pairs.filter((p): p is [string, string] => Boolean(p[1])).map(([label, value]) => ({ label, value }));

export const dzd = (n: number): string => `${new Intl.NumberFormat("fr-FR").format(n)} DZD`;
