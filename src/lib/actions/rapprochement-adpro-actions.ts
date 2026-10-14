"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { accepterCertaines, annulerDecision, decider, lireTranche, lotActifGere, type ProgressionLecture } from "@/lib/budget-marketing/rapprochement-serveur";
import type { DecisionRapprochement, SensRapprochement } from "@/lib/budget-marketing/rapprochement";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RAPPROCHEMENT AD & PRO — LES GESTES (Budget Marketing › Intégration 2026 › Rapprochement, Direction 14/10/2026).
 *
 *   • LIRE une tranche de pièces par Luna (quelques fichiers, une vingtaine de secondes au plus) — l'écran rappelle tant
 *     qu'il en reste ; chaque pièce n'est lue qu'une fois (empreinte) ;
 *   • DÉCIDER d'une proposition : accepter (éventuellement vers une autre demande ou un autre poste), refuser, signaler
 *     « pas Ad & Pro » (une dépense) ;
 *   • ACCEPTER TOUTES LES PROPOSITIONS CERTAINES (règle stricte, confirmation exigée au serveur) ;
 *   • ANNULER une décision.
 *
 * Porte : gérer l'enveloppe du lot d'intégration (gestionnaire, Super Admin) — relue par chaque geste. Rien ne touche le
 * livre de trésorerie ni un ordre de dépense ; tout est audité.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function revalider() {
  for (const p of ["/budget-marketing", "/budget-marketing/integration", "/budget-marketing/integration/rapprochement", "/budget-marketing/depenses", "/budget-marketing/ad-pro", "/budgets"]) revalidatePath(p);
}

export async function lireTranchePiecesRapprochement(formData: FormData): Promise<{ ok: boolean; error?: string; progression?: ProgressionLecture & { luesCetteFois: number; erreurs: string[] } }> {
  const user = await requireUser();
  const lot = await lotActifGere(user, fdStr(formData, "envelopeId"));
  if (!lot) return { ok: false, error: "Lot introuvable, ou vous ne gérez pas cette enveloppe." };
  const progression = await lireTranche(user);
  return { ok: true, progression };
}

const DECISIONS: readonly DecisionRapprochement[] = ["ACCEPTEE", "REFUSEE", "PAS_ADPRO"];

export async function deciderRapprochement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const sens = fdStr(formData, "sens");
  const decision = fdStr(formData, "decision");
  const source = fdStr(formData, "source");
  if ((sens !== "DEPENSE" && sens !== "PIECE") || !source || !DECISIONS.includes(decision as DecisionRapprochement)) {
    return { ok: false, error: "Décision incomplète." };
  }
  const r = await decider(user, fdStr(formData, "envelopeId"), {
    sens: sens as SensRapprochement, source, decision: decision as DecisionRapprochement,
    demandeRowId: fdStr(formData, "demandeRowId"), posteId: fdStr(formData, "posteId"), pieceCle: fdStr(formData, "pieceCle"), enveloppe: fdStr(formData, "enveloppe"),
  });
  if (!r.ok) return { ok: false, error: r.erreur };
  revalider();
  return { ok: true, message: r.message };
}

export async function accepterRapprochementsCertains(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (fdStr(formData, "confirme") !== "on") return { ok: false, error: "Confirmez : seules les propositions qui remplissent la règle « certaine » seront acceptées." };
  const r = await accepterCertaines(user, fdStr(formData, "envelopeId"));
  if (!r.ok) return { ok: false, error: r.erreur };
  revalider();
  return { ok: true, message: r.message };
}

export async function annulerDecisionRapprochement(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  const r = await annulerDecision(user, fdStr(formData, "id"));
  if (!r.ok) return { ok: false, error: r.erreur };
  revalider();
  return { ok: true, message: r.message };
}
