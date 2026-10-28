import { cache } from "react";
import { prisma } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";

// Mémoïsation par requête (même patron que lib/company.ts) : une seule lecture par rendu.
const perRequest: <T extends (...args: never[]) => unknown>(fn: T) => T =
  typeof cache === "function" ? (cache as never) : (fn) => fn;

/**
 * VERSION DE TEST → VERSION DE PRODUCTION.
 *
 * Toute nouveauté livrée arrive au stade **TEST** : elle n'est visible que des comptes en
 * « mode test » (l'administration). Quand elle convient, l'administrateur la **valide**
 * depuis `/admin/versions` et elle passe au stade **PROD** — active pour tout le monde.
 * Le **retour arrière** est immédiat (repasser en TEST ou couper en OFF).
 *
 * Règle d'or : le code des deux versions cohabite dans la même application. Une nouveauté
 * n'est jamais « à moitié » livrée — c'est le drapeau qui décide qui la voit.
 *
 *   const nouveau = await featureEnabled(FEATURES.ASSISTANT_MEMORY.key, user);
 *   return nouveau ? <NouvelleVersion /> : <VersionActuelle />;
 */

/** Catalogue des nouveautés pilotables. Ajouter une entrée ici suffit : le drapeau est créé
 *  automatiquement au stade TEST à sa première utilisation. */
export const FEATURES = {
  ASSISTANT_MEMORY: {
    key: "assistant_memory",
    label: "Assistant — mémoire personnelle",
    description:
      "L'assistant se souvient des conversations passées de CHAQUE personne (fils persistants, mémoire distillée) et connaît son identité, son département et son N+1. Cloisonnement strict : personne ne peut atteindre la mémoire d'un autre.",
  },
  HOME_TODAY: {
    key: "home_today",
    label: "Écran d'accueil « Aujourd'hui »",
    description:
      "À l'ouverture, on voit ce qui nous attend (validations, tâches, échéances) au lieu d'un menu de modules. Objectif : adoption.",
  },
  MAIL_SMART: {
    key: "mail_smart",
    label: "Courrier « smart » (API + webhook)",
    description:
      "Envoi par API HTTPS et réception par webhook entrant, à la place d'IMAP/SMTP qui se bloquait. Nécessite un compte fournisseur et des enregistrements DNS.",
  },
  ASSISTANT_PROACTIVE: {
    key: "assistant_proactive",
    label: "Assistant proactif (point du matin)",
    description: "Un point quotidien dans le module Assistant : ce qui attend la personne, ce qui bloque, ce qui arrive à échéance.",
  },
} as const;

type Stage = "TEST" | "PROD" | "OFF";

/** Métadonnées du catalogue par clé (pour l'auto-création et l'écran d'administration). */
const CATALOG = new Map(Object.values(FEATURES).map((f) => [f.key as string, f]));

/**
 * Lit le stade d'une nouveauté, en créant le drapeau (au stade TEST) s'il n'existe pas
 * encore. Ne lève jamais : en cas de souci base, on retombe sur TEST (donc invisible du
 * grand public), ce qui est le comportement prudent.
 */
async function getStage(key: string): Promise<Stage> {
  try {
    const existing = await prisma.featureFlag.findUnique({ where: { key }, select: { stage: true } });
    if (existing) return existing.stage as Stage;
    const meta = CATALOG.get(key);
    await prisma.featureFlag.create({
      data: { key, label: meta?.label ?? key, description: meta?.description ?? null, stage: "TEST" },
    });
    return "TEST";
  } catch {
    return "TEST";
  }
}

/** Le compte est-il en « mode test » ? (mémoïsé par requête). */
export const isTestUser = perRequest(async (userId: string): Promise<boolean> => {
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { testMode: true } }).catch(sansBloquer("features.user", null));
  return Boolean(u?.testMode);
});

/**
 * Cette nouveauté est-elle visible pour CE compte ?
 *   • PROD → oui, pour tout le monde ;
 *   • TEST → uniquement si le compte est en mode test ;
 *   • OFF  → non.
 */
export async function featureEnabled(key: string, userId: string): Promise<boolean> {
  const stage = await getStage(key);
  if (stage === "PROD") return true;
  if (stage === "OFF") return false;
  return isTestUser(userId);
}

export interface FeatureRow {
  key: string;
  label: string;
  description: string | null;
  stage: Stage;
  promotedAt: string | null;
  promotedByName: string | null;
}

/**
 * Toutes les nouveautés du catalogue (les drapeaux manquants sont créés au passage), pour
 * l'écran d'administration : les nouveautés EN TEST d'abord, puis celles en production.
 */
export async function listFeatures(): Promise<FeatureRow[]> {
  for (const f of CATALOG.values()) await getStage(f.key);
  const rows = await prisma.featureFlag.findMany({
    include: { promotedBy: { select: { name: true } } },
    orderBy: [{ stage: "asc" }, { label: "asc" }],
  });
  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
    stage: r.stage as Stage,
    promotedAt: r.promotedAt?.toISOString() ?? null,
    promotedByName: r.promotedBy?.name ?? null,
  }));
}
