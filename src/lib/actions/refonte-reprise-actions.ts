"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit";
import { repriseParCle } from "@/lib/referentiels/reprises";
import type { BilanReprise } from "@/lib/referentiels/reprises/types";

/**
 * LES REPRISES DE LA REFONTE — l'action serveur unique de l'écran `Administration › Refonte des données`
 * (contrat commun, `docs/architecture/refonte-vague-2.md`).
 *
 * Super Admin SEUL : une reprise lit toute une table et écrit un référentiel. L'aperçu n'écrit rien ;
 * l'exécution traite UN lot et rend où reprendre. Chaque geste est audité (module « Refonte des données »,
 * `field: reprise:<clé>`) : c'est le journal que l'écran relit.
 */

const CHEMIN = "/admin/refonte-donnees";
const TAILLE_LOT = 100;

type Reponse<T> = { ok: true; bilan: T } | { ok: false; error: string };

async function porte(cle: string) {
  const user = await requireUser();
  if (user.role !== "SUPER_ADMIN") return { refus: "Réservé au Super Admin." } as const;
  const reprise = repriseParCle(cle);
  if (!reprise) return { refus: "Reprise inconnue." } as const;
  return { user, reprise } as const;
}

/** Une ligne d'audit lisible : les compteurs, et le nombre d'anomalies (le détail reste à l'écran). */
const resume = (b: BilanReprise) =>
  `lues ${b.lues} · créées ${b.creees} · liées ${b.liees} · doublons proposés ${b.doublonsProposes} · ignorées ${b.ignorees} · anomalies ${b.erreurs.length}`;

export async function apercuReprise(cle: string): Promise<Reponse<BilanReprise>> {
  const p = await porte(cle);
  if ("refus" in p) return { ok: false, error: p.refus as string };
  const bilan = await p.reprise.apercu();
  await recordAudit({
    actorId: p.user.id, action: "VALIDATE", module: "Refonte des données", field: `reprise:${cle}`,
    summary: `Aperçu à blanc — ${p.reprise.titre} : ${resume(bilan)}`,
  });
  return { ok: true, bilan };
}

export async function executerReprise(cle: string, apresId: string | null): Promise<Reponse<BilanReprise & { suite: string | null }>> {
  const p = await porte(cle);
  if ("refus" in p) return { ok: false, error: p.refus as string };
  const bilan = await p.reprise.executer({ taille: TAILLE_LOT, apresId });
  await recordAudit({
    actorId: p.user.id, action: "IMPORT", module: "Refonte des données", field: `reprise:${cle}`,
    summary: `Lot exécuté — ${p.reprise.titre}${apresId ? ` (après ${apresId})` : " (premier lot)"} : ${resume(bilan)}${bilan.suite ? "" : " — terminé"}`,
  });
  revalidatePath(CHEMIN);
  return { ok: true, bilan };
}
