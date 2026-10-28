/**
 * RECRUTEMENT — les ANNONCES qui suivent une écriture d'étape : le fil de la demande, celui qui attend (le
 * demandeur, la marche, les RH), et le suivi désigné par le DG.
 *
 * Sorties de `actions/recruitment-actions.ts` (lot V4). L'action écrit l'étape (conditionnelle sur l'étape lue),
 * resynchronise l'offre du site, PUIS passe le formulaire à son annonce — qui relit la phrase que l'action a
 * exigée (le motif, ce qui a changé) pour la citer. Pour le contrat des actions, ce corps est celui du fichier
 * d'actions (`contrat/internes.ts`) : le fil et les notifications qu'il écrit comptent pour l'action.
 */
import type { SessionUser } from "@/lib/rbac";
import { rolesWithModule } from "@/lib/rbac";
import { notifyUser, notifyRoles } from "@/lib/notify";
import { fdStr } from "@/lib/actions/types";
import { ecrireAuFil } from "@/lib/ad-pro/fil";
import { sansBloquer } from "@/lib/journal";
import {
  STAGE_LABEL, currentStep, prevenusAuRetrait, type ChainStep, type RecruitmentStage, type reouverture,
} from "@/lib/recruitment/request-flow";
import {
  prevenirLaSuite, prevenirLeSuivi, prevenirLesApprobateurs, prevenirQuiLaReprend,
} from "@/lib/actions/internes/recruitment/circuit";

type Demande = { reference: string; position: string; requesterId: string };

/**
 * `decideRecruitmentStep` — on prévient CELUI QUI ATTEND : le demandeur d'un refus (avec le motif), sinon la
 * marche suivante ou les RH.
 */
export async function annoncerLaDecision(
  formData: FormData,
  ctx: {
    id: string; req: Parameters<typeof prevenirLaSuite>[1] & Demande; decision: "APPROVED" | "REJECTED";
    complete: boolean; nextSteps: ChainStep[];
  },
): Promise<void> {
  const { id, req, decision, complete, nextSteps } = ctx;
  const reason = fdStr(formData, "reason");
  // On prévient CELUI QUI ATTEND : la marche suivante, ou les RH quand la chaîne est franchie,
  // ou le demandeur quand c'est un refus. Une notification à tout le monde n'aiderait personne.
  if (decision === "REJECTED") {
    await notifyUser({
      userId: req.requesterId, type: "GENERIC",
      title: "Demande de recrutement refusée",
      body: `${req.reference} — ${req.position} · ${reason ?? ""}`,
      link: `/recrutement/${id}`,
    });
  } else {
    await prevenirLaSuite(id, req, complete, nextSteps);
  }
}

/** `cancelRecruitmentRequest` — retirée par son demandeur : les approbateurs engagés, les RH, le suivi. */
export async function annoncerLeRetrait(
  formData: FormData,
  ctx: {
    user: SessionUser; id: string;
    req: { reference: string; position: string; stage: RecruitmentStage; approvals: Parameters<typeof prevenusAuRetrait>[1] };
  },
): Promise<void> {
  const { user, id, req } = ctx;
  const motif = fdStr(formData, "reason");
  const prevenus = prevenusAuRetrait(req.stage, req.approvals, user.id);
  const corps = `${req.reference} — ${req.position} : retirée par son demandeur${motif ? ` (${motif})` : ""}. Il n'y a plus rien à traiter.`;
  await prevenirLesApprobateurs(id, prevenus.approbateurs, corps);
  if (prevenus.rh) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Demande de recrutement retirée", body: corps, link: `/recrutement/${id}` }).catch(sansBloquer("recruitment-actions.cancelRecruitmentRequest.notifyRoles"));
  }
  await prevenirLeSuivi(id, { title: "Demande de recrutement retirée", body: corps }, [user.id, ...prevenus.approbateurs]);
}

/** `renvoyerDemandeRecrutement` — renvoyée pour correction : au fil, au demandeur, au suivi. */
export async function annoncerLeRenvoi(formData: FormData, ctx: { user: SessionUser; id: string; req: Demande & { stage: string } }): Promise<void> {
  const { user, id, req } = ctx;
  const motif = fdStr(formData, "motif");
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Renvoyée pour correction (${STAGE_LABEL[req.stage as RecruitmentStage]}) — ${motif}` }).catch(sansBloquer("recruitment-actions.renvoyerDemandeRecrutement.ecrireAuFil"));
  await notifyUser({
    userId: req.requesterId, type: "GENERIC",
    title: "Demande de recrutement à corriger",
    body: `${req.reference} — ${req.position} · ${motif}`,
    link: `/recrutement/${id}`,
  });
  await prevenirLeSuivi(id, { title: "Demande de recrutement renvoyée pour correction", body: `${req.reference} — ${req.position} · ${motif}` }, [user.id, req.requesterId]);
}

/** `resoumettreDemandeRecrutement` — corrigée et renvoyée : au fil, puis à CELUI QUI ATTEND, et seulement lui. */
export async function annoncerLaCorrection(
  formData: FormData,
  ctx: {
    user: SessionUser; id: string; req: { reference: string; returnedById: string | null }; position: string;
    steps: ChainStep[]; materiels: string[]; repart: boolean; vers: RecruitmentStage;
  },
): Promise<void> {
  const { user, id, req, position, steps, materiels, repart, vers } = ctx;
  const changements = fdStr(formData, "changements");
  await ecrireAuFil({
    entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id,
    body: `Corrigée et renvoyée — ${changements}${repart ? ` · la chaîne repart de sa première marche : ${materiels.join(", ")}` : ""}`,
  }).catch(sansBloquer("recruitment-actions.resoumettreDemandeRecrutement.ecrireAuFil"));

  // On prévient CELUI QUI ATTEND, et seulement lui.
  const titre = repart ? "Demande de recrutement à valider de nouveau" : "Demande de recrutement corrigée";
  const corps = `${req.reference} — ${position.trim()} · ${changements}${repart ? ` · le besoin a changé : ${materiels.join(", ")}` : ""}`;
  const lien = `/recrutement/${id}`;
  if (vers === "CHAIN") {
    const marche = repart ? [...steps].sort((a, b) => a.order - b.order)[0] : currentStep(steps);
    if (marche) await notifyUser({ userId: marche.approverId, type: "GENERIC", title: titre, body: corps, link: lien });
    if (req.returnedById && req.returnedById !== marche?.approverId) {
      await notifyUser({ userId: req.returnedById, type: "GENERIC", title: "La demande que vous avez renvoyée est corrigée", body: corps, link: lien });
    }
  } else if (req.returnedById) {
    await notifyUser({ userId: req.returnedById, type: "GENERIC", title: titre, body: corps, link: lien });
  } else {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: titre, body: corps, link: lien });
  }
}

/** `rouvrirDemandeRecrutement` — rouverte : la décision précédente gardée au fil, qui la reprend, le demandeur, le suivi. */
export async function annoncerLaReouverture(
  formData: FormData,
  ctx: {
    user: SessionUser; id: string; req: Demande & { closingNote: string | null };
    ou: Exclude<ReturnType<typeof reouverture>, { refus: string }>; steps: ChainStep[];
  },
): Promise<void> {
  const { user, id, req, ou, steps } = ctx;
  const motif = fdStr(formData, "motif");
  // La décision qu'on rouvre reste lisible : la fiche la retire de son bloc « Décision », le fil la garde.
  await ecrireAuFil({
    entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id,
    body: `Rouverte — ${motif}${req.closingNote ? ` · la décision précédente : « ${req.closingNote} »` : ""}`,
  }).catch(sansBloquer("recruitment-actions.rouvrirDemandeRecrutement.ecrireAuFil"));
  const corps = `${req.reference} — ${req.position} · ${motif}`;
  const lien = `/recrutement/${id}`;
  await prevenirQuiLaReprend(ou, steps, corps, lien);
  if (req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Votre demande de recrutement est rouverte", body: corps, link: lien });
  }
  await prevenirLeSuivi(id, { title: "Demande de recrutement rouverte", body: corps }, [user.id, req.requesterId]);
}

/** `annulerEmbaucheRecrutement` — embauche annulée : au fil, au demandeur, au suivi, et aux RH s'ils n'en sont pas l'auteur. */
export async function annoncerLAnnulation(
  formData: FormData,
  ctx: { user: SessionUser; id: string; req: Demande; recrute: { fullName: string }; viewer: { isHr: boolean } },
): Promise<void> {
  const { user, id, req, recrute, viewer } = ctx;
  const motif = fdStr(formData, "motif");
  await ecrireAuFil({ entityType: "RECRUITMENT_REQUEST", entityId: id, authorId: user.id, body: `Embauche de ${recrute.fullName} annulée — ${motif}` }).catch(sansBloquer("recruitment-actions.annulerEmbaucheRecrutement.ecrireAuFil"));
  const corps = `${req.reference} — ${recrute.fullName} · ${motif}`;
  const lien = `/recrutement/${id}`;
  if (req.requesterId !== user.id) {
    await notifyUser({ userId: req.requesterId, type: "GENERIC", title: "Embauche annulée — le poste est rouvert", body: corps, link: lien });
  }
  await prevenirLeSuivi(id, { title: "Embauche annulée — le poste est rouvert", body: corps }, [user.id, req.requesterId]);
  if (!viewer.isHr) {
    await notifyRoles(rolesWithModule("RH", "UPDATE"), { type: "GENERIC", title: "Embauche annulée — plus d'intégration à préparer", body: corps, link: lien });
  }
}
