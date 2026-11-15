import { timingSafeEqual } from "crypto";

/**
 * LA CLÉ DU SERVICE PORTEFEUILLE DCI. Les flux `/api/donnees-marche/v1/*` n'ont pas de session : ils exigent l'en-tête
 * `Authorization: Bearer <DONNEES_MARCHE_API_KEY>`. Sans clé configurée, tout est refusé (503) — jamais ouvert.
 * Comparaison à temps constant ; la réponse ne dit pas ce qui a échoué.
 */
export function verifierCleApi(entete: string | null): { ok: true } | { ok: false; statut: 401 | 503 } {
  const attendue = process.env.DONNEES_MARCHE_API_KEY?.trim();
  if (!attendue || attendue.length < 24) return { ok: false, statut: 503 };
  const recue = (entete ?? "").replace(/^Bearer\s+/i, "").trim();
  const a = Buffer.from(recue), b = Buffer.from(attendue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, statut: 401 };
  return { ok: true };
}
