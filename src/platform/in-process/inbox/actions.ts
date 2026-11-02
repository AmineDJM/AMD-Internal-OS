"use server";

import { requireUser } from "@/lib/session";
import { peutVoirAdam, REFUS_ADAM } from "@/lib/rbac";
import { decideValidation } from "@/lib/actions/validation-actions";
import { decidePayment } from "@/modules/finances/actions-centre";
import { deciderAccordMission, fournirElementMission } from "@/lib/actions/mission-runtime-actions";
import { markNotificationRead } from "@/lib/actions/notification-actions";
import { corrigerConstat, ignorerConstat } from "@/lib/quality/decide";
import { estGesteValide, type Geste } from "@/lib/assistant/inbox/model";

export interface ResultatGeste { ok: boolean; message: string }

/**
 * UN CLIC SUR UNE CARTE = L'ACTION CANONIQUE DU MODULE, ni plus ni moins.
 *
 * Cette action ne décide rien elle-même : elle vérifie la FORME du geste (une donnée venue du
 * navigateur) et le remet à l'action qui gouverne déjà ce type d'objet — `decideValidation`,
 * `decidePayment`, `deciderAccordMission`, `fournirElementMission`, `markNotificationRead`.
 * Chacune relit la session, revérifie ses droits et son état (« ce n'est pas encore votre
 * tour », « déjà traitée »). La boîte de décision n'est donc pas une porte dérobée : un geste
 * qui échouerait depuis l'écran du module échoue ici, avec le même message.
 */
export async function agirSurCarte(geste: Geste, saisie?: string | null): Promise<ResultatGeste> {
  const user = await requireUser();
  // La boîte de décision est un écran d'Adam, réservé au Super Admin (§118.153). Les mêmes
  // décisions restent ouvertes à chacun depuis l'écran de leur module — rien n'est retiré.
  if (!peutVoirAdam(user)) return { ok: false, message: REFUS_ADAM };
  if (!estGesteValide(geste)) return { ok: false, message: "Geste inconnu : rien n'a été fait." };
  const texte = (saisie ?? "").trim().slice(0, 2000);

  switch (geste.kind) {
    case "validation.decide": {
      if (geste.decision !== "APPROVED" && !texte) return { ok: false, message: "Dites pourquoi : le demandeur lira ce motif." };
      const fd = new FormData();
      fd.set("stepId", geste.stepId);
      fd.set("decision", geste.decision);
      if (texte) fd.set("reason", texte);
      const r = await decideValidation(fd);
      return { ok: r.ok, message: r.ok ? (r.message ?? "Décision enregistrée.") : (r.error ?? "Décision refusée.") };
    }
    case "paiement.decide": {
      if (geste.decision !== "APPROVE" && !texte) return { ok: false, message: "Dites pourquoi : sans motif, le demandeur ne peut que deviner." };
      const fd = new FormData();
      fd.set("id", geste.orderId);
      fd.set("decision", geste.decision);
      if (texte) fd.set("body", texte);
      const r = await decidePayment(fd);
      return { ok: r.ok, message: r.ok ? (r.message ?? "Décision enregistrée.") : (r.error ?? "Décision refusée.") };
    }
    case "mission.accord": {
      const r = await deciderAccordMission(geste.approvalId, geste.decision);
      return { ok: r.ok, message: r.message };
    }
    case "mission.element": {
      if (!texte) return { ok: false, message: "Dites ce que la mission attend : c'est ce texte qui la fera repartir." };
      const r = await fournirElementMission(geste.missionId, geste.stepKey, texte);
      return { ok: r.ok, message: r.message };
    }
    case "notification.lue": {
      await markNotificationRead(geste.notificationId);
      return { ok: true, message: "Vu." };
    }
    case "qualite.corriger": {
      const r = await corrigerConstat(user, geste.constatId);
      return { ok: r.ok, message: r.message };
    }
    case "qualite.ignorer": {
      if (!texte) return { ok: false, message: "Dites pourquoi ce n'est pas une anomalie : le motif reste avec le constat." };
      const r = await ignorerConstat(user, geste.constatId, texte);
      return { ok: r.ok, message: r.message };
    }
    default:
      return { ok: false, message: "Ce geste s'exécute dans le navigateur, pas ici." };
  }
}
