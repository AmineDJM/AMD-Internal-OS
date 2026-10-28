/**
 * Anti-bruteforce de la connexion — **serveur uniquement**.
 *
 * Suivi des échecs par identifiant (fenêtre glissante) + verrouillage temporaire
 * croissant. Best-effort : aucune erreur ne doit empêcher une connexion légitime
 * (en cas de panne du suivi, on laisse passer plutôt que de bloquer tout le monde).
 */
import { prisma } from "./prisma";
import { sansBloquer } from "@/lib/journal";

export const MAX_FAILURES = 5; // échecs tolérés avant verrouillage
const WINDOW_MS = 15 * 60_000; // fenêtre glissante de comptage (15 min)
const BASE_LOCK_MS = 15 * 60_000; // durée de verrouillage de base (15 min)
const MAX_LOCK_MS = 2 * 60 * 60_000; // plafond (2 h)

export interface LockState {
  locked: boolean;
  until?: Date;
}

/** Indique si l'identifiant est actuellement verrouillé. */
export async function checkLockout(email: string): Promise<LockState> {
  const row = await prisma.loginAttempt.findUnique({ where: { email } }).catch(sansBloquer("login-throttle.checkLockout.loginAttempt", null));
  if (row?.lockedUntil && row.lockedUntil > new Date()) return { locked: true, until: row.lockedUntil };
  return { locked: false };
}

export interface FailureResult {
  lockedNow: boolean; // le verrouillage vient-il d'être déclenché ?
  until?: Date;
  failures: number;
}

/**
 * Enregistre un échec de connexion et applique la politique de verrouillage.
 * La durée double à chaque palier de `MAX_FAILURES` atteint, plafonnée à 2 h.
 */
export async function recordFailure(email: string, ip: string | null): Promise<FailureResult> {
  const now = new Date();
  const row = await prisma.loginAttempt.findUnique({ where: { email } }).catch(sansBloquer("login-throttle.recordFailure.loginAttempt", null));

  // Fenêtre glissante : une dernière tentative trop ancienne (sans verrou actif)
  // repart de zéro pour ne pas pénaliser un utilisateur légitime occasionnel.
  const stillLocked = row?.lockedUntil && row.lockedUntil > now;
  const withinWindow = row && now.getTime() - row.lastAttempt.getTime() < WINDOW_MS;
  const prevFailures = withinWindow || stillLocked ? row!.failures : 0;
  const failures = prevFailures + 1;

  let lockedUntil: Date | null = stillLocked ? row!.lockedUntil! : null;
  let lockedNow = false;
  if (failures >= MAX_FAILURES && !lockedUntil) {
    const tier = Math.floor(failures / MAX_FAILURES); // 1, 2, 3…
    const duration = Math.min(BASE_LOCK_MS * 2 ** (tier - 1), MAX_LOCK_MS);
    lockedUntil = new Date(now.getTime() + duration);
    lockedNow = true;
  }

  await prisma.loginAttempt
    .upsert({
      where: { email },
      create: { email, ipAddress: ip, failures, lockedUntil, lastAttempt: now },
      update: { ipAddress: ip, failures, lockedUntil, lastAttempt: now },
    })
    .catch(sansBloquer("login-throttle.recordFailure.loginAttempt"));

  return { lockedNow, until: lockedUntil ?? undefined, failures };
}

/** Réinitialise le compteur (connexion réussie). */
export async function clearAttempts(email: string): Promise<void> {
  await prisma.loginAttempt.deleteMany({ where: { email } }).catch(sansBloquer("login-throttle.clearAttempts.loginAttempt"));
}
