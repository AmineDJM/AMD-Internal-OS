"use server";

import { gesteReversible } from "@/lib/effets/ecran";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { fdStr, type ActionResult } from "@/lib/actions/types";
import { recruitmentViewer } from "@/lib/recruitment/access";
import {
  classerCandidature, effacerCandidature, peutTraiterCandidaturesSite, rattacherCandidature, remettreATrier,
} from "@/lib/site-web/candidatures";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * TRIER LES CANDIDATURES REÇUES DU SITE (§118.159) — la boîte d'arrivée des RH.
 *
 * Les règles vivent dans `lib/site-web/candidatures.ts` ; ce fichier vérifie la session et
 * revalide les écrans. Rattacher exige en plus d'être partie à la demande visée : c'est la porte du
 * recrutement (`recruitmentViewer`), la même que celle qui ouvre la fiche de ce poste.
 *
 * Ces gestes ne sont pas offerts à Adam : ils portent sur des données PERSONNELLES de candidats
 * externes — les rattacher à un poste, les écarter, les effacer à leur demande — et c'est une
 * personne des RH qui en répond. La décision est écrite dans `action-registry.ts` (EXCLUDED).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

function revalider(requestId?: string | null) {
  revalidatePath("/recrutement");
  revalidatePath("/recrutement/candidatures");
  if (requestId) revalidatePath(`/recrutement/${requestId}`);
}

export async function rattacherCandidatureSite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "candidatures-site-actions:rattacherCandidatureSite", libelle: "Candidature rattachée à un recrutement" }, async () => {
    if (!peutTraiterCandidaturesSite(user)) return { ok: false, error: "Les candidatures du site se trient par les RH." };
    const id = fdStr(formData, "id");
    const requestId = fdStr(formData, "requestId");
    if (!id) return { ok: false, error: "Candidature manquante." };
    if (!requestId) return { ok: false, error: "Choisissez le recrutement auquel la rattacher." };
    const r = await rattacherCandidature(user, id, requestId, async (rid) => Boolean(await recruitmentViewer(user, rid)));
    revalider(requestId);
    return r.ok ? { ok: true, id: r.candidateId, message: r.message } : { ok: false, error: r.erreur };
  });
}

export async function classerCandidatureSite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "candidatures-site-actions:classerCandidatureSite", libelle: "Candidature classée" }, async () => {
    if (!peutTraiterCandidaturesSite(user)) return { ok: false, error: "Les candidatures du site se trient par les RH." };
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Candidature manquante." };
    const r = await classerCandidature(user, id, fdStr(formData, "motif"));
    revalider();
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.erreur };
  });
}

export async function remettreCandidatureATrier(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  return gesteReversible(user, { capaciteId: "candidatures-site-actions:remettreCandidatureATrier", libelle: "Candidature remise à trier" }, async () => {
    if (!peutTraiterCandidaturesSite(user)) return { ok: false, error: "Les candidatures du site se trient par les RH." };
    const id = fdStr(formData, "id");
    if (!id) return { ok: false, error: "Candidature manquante." };
    const r = await remettreATrier(user, id);
    revalider();
    return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.erreur };
  });
}

export async function effacerCandidatureSite(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutTraiterCandidaturesSite(user)) return { ok: false, error: "Les candidatures du site se trient par les RH." };
  const id = fdStr(formData, "id");
  if (!id) return { ok: false, error: "Candidature manquante." };
  const r = await effacerCandidature(user, id);
  revalider();
  return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.erreur };
}
