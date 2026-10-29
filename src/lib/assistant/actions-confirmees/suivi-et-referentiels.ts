/**
 * EXÉCUTION APRÈS CONFIRMATION — Suivi d'une demande, documents juridiques, ajout d'un établissement.
 * Des séries de branches de l'ancienne chaîne de `performAction` qui n'écrivent pas elles-mêmes en
 * base, recopiées telles quelles ; `actions-confirmees/executer.ts` appelle chacune à son rang, et
 * elle rend `undefined` quand l'action n'est pas la sienne.
 */

import {
  prisma, createLegalDocument, updateLegalDocument, createInstitution, createStockHospital, createStockAnnex,
} from "@/lib/assistant/coeur/erp";
// Les demandes Ad & Pro, le secrétariat et les circuits : par le pont (frontière Adam ↔ ERP).
import { updateRequestStatus, assignRequest, addRequestComment } from "@/platform/in-process/demandes";
import { toNumber } from "@/lib/utils";
import type { ExecuteResult, ContexteExecution } from "@/lib/assistant/actions-confirmees/aides";

/** Branches de `performAction` : mise à jour d'une demande administrative, documents juridiques (création, modification). */
export async function executerDemandeEtJuridique(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { payload } = c;

  if (payload?.kind === "update_request") {
    // L'exécution repasse par LES ACTIONS DU MODULE : mêmes gardes (gestionnaire), mêmes
    // notifications au demandeur, même archivage sur DONE. On ne réécrit pas ces règles ici.
    const done: string[] = [];
    if (payload.assigneeId) {
      const fd = new FormData();
      fd.set("id", payload.requestId);
      fd.set("assignedToId", payload.assigneeId);
      const r = await assignRequest(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Réassignation refusée." };
      done.push(`réassignée à ${payload.assigneeName ?? "un collègue"}`);
    }
    if (payload.status) {
      const fd = new FormData();
      fd.set("id", payload.requestId);
      fd.set("status", payload.status);
      const r = await updateRequestStatus(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Changement de statut refusé." };
      done.push(`statut ${payload.status}`);
    }
    if (payload.comment?.trim()) {
      const fd = new FormData();
      fd.set("id", payload.requestId);
      fd.set("body", payload.comment.trim());
      const r = await addRequestComment(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "Commentaire refusé." };
      done.push("commentaire ajouté");
    }
    if (done.length === 0) return { ok: false, error: "Aucun changement à appliquer." };
    return { ok: true, message: `Demande ${payload.reference} : ${done.join(", ")}.`, link: `/demandes/${payload.requestId}`, revalidate: ["/demandes", `/demandes/${payload.requestId}`] };
  }

  if (payload?.kind === "create_legal_document") {
    // `createLegalDocument` revérifie LEGAL CREATE, la validité des dates et la pièce amont.
    const fd = new FormData();
    fd.set("kind", payload.docKind);
    fd.set("title", payload.title);
    if (payload.reference) fd.set("reference", payload.reference);
    // Un NOM, résolu par l'action contre l'annuaire — le texte libre n'est plus lu (§118.148).
    if (payload.counterparty) fd.set("counterpartyName", payload.counterparty);
    if (payload.amount != null) fd.set("amount", String(payload.amount));
    if (payload.startDate) fd.set("startDate", payload.startDate);
    if (payload.endDate) fd.set("endDate", payload.endDate);
    if (payload.notes) fd.set("notes", payload.notes);
    if (payload.chainFromId) fd.set("chainFromId", payload.chainFromId);
    const r = await createLegalDocument(undefined, fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La pièce n'a pas pu être déclarée." };
    return {
      ok: true,
      // La phrase de l'action PASSE : sur un bon de commande, elle dit à quel centre il attend.
      message: `Pièce « ${payload.title} » déclarée au Legal${payload.chainFromLabel ? ` (chaînée à ${payload.chainFromLabel})` : ""}.${r.message ? ` ${r.message}` : ""}`,
      link: r.id ? `/legal/${r.id}` : "/legal",
      revalidate: ["/legal"],
    };
  }

  if (payload?.kind === "update_legal_document") {
    // `updateLegalDocument` REMPLACE tous les champs : on relit la fiche et l'on ne change que
    // ce qui a été confirmé — jamais un champ effacé par omission.
    const current = await prisma.legalDocument.findUnique({
      where: { id: payload.documentId },
      select: { id: true, title: true, reference: true, kind: true, counterparty: true, counterpartyIds: true, amount: true, startDate: true, endDate: true, notes: true, folderId: true, chainFromId: true },
    });
    if (!current) return { ok: false, error: "Cette pièce Legal n'existe plus." };
    const u = payload.updates;
    const fd = new FormData();
    fd.set("id", current.id);
    fd.set("kind", current.kind);
    fd.set("title", u.title ?? current.title);
    fd.set("reference", u.reference ?? current.reference ?? "");
    // LES PARTIES DE L'ANNUAIRE SONT REPORTÉES, jamais omises (§118.148) : `updateLegalDocument`
    // REMPLACE la liste, et n'envoyer que le nom en texte — que l'action ne lit plus — faisait
    // refuser toute modification d'une pièce déjà rattachée à l'annuaire. Une partie CHANGÉE
    // passe par son nom, résolu contre l'annuaire par l'action, et remplace les précédentes.
    if (u.counterparty) fd.set("counterpartyName", u.counterparty);
    else for (const pid of current.counterpartyIds) fd.append("counterpartyIds", pid);
    fd.set("amount", u.amount != null ? String(u.amount) : current.amount != null ? String(toNumber(current.amount)) : "");
    fd.set("startDate", u.startDate ?? (current.startDate ? current.startDate.toISOString().slice(0, 10) : ""));
    fd.set("endDate", u.endDate ?? (current.endDate ? current.endDate.toISOString().slice(0, 10) : ""));
    fd.set("notes", u.notes ?? current.notes ?? "");
    fd.set("folderId", current.folderId ?? "");
    fd.set("chainFromId", u.chainFromId ?? current.chainFromId ?? "");
    const r = await updateLegalDocument(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La modification a été refusée." };
    return {
      ok: true,
      message: `Pièce « ${u.title ?? current.title} » modifiée (${payload.changes.join(", ")}).`,
      link: `/legal/${current.id}`,
      revalidate: ["/legal", `/legal/${current.id}`],
    };
  }

  return undefined;
}

/** Branches de `performAction` : ajout d'un établissement à l'annuaire. */
export async function executerAjoutEtablissement(c: ContexteExecution): Promise<ExecuteResult | undefined> {
  const { payload } = c;

  if (payload?.kind === "create_hospital") {
    const name = (payload.name ?? "").trim();
    if (!name) return { ok: false, error: "Nom manquant." };
    if (payload.registre === "STOCKS") {
      // `createStockHospital` / `createStockAnnex` revérifient : Super Admin uniquement.
      const fd = new FormData();
      fd.set("name", name);
      if (payload.institutionId) fd.set("institutionId", String(payload.institutionId));
      const r = payload.annexKind === "ANNEX" ? await createStockAnnex(fd) : await createStockHospital(fd);
      if (!r.ok) return { ok: false, error: r.error ?? "L'ajout a été refusé." };
      return { ok: true, message: `« ${name} » ajouté aux lieux de stock.`, link: "/stocks", revalidate: ["/stocks"] };
    }
    const fd = new FormData();
    fd.set("name", name);
    if (payload.institutionType) fd.set("type", payload.institutionType);
    if (payload.sector) fd.set("sector", payload.sector);
    // La ville a quitté l'annuaire des établissements : la wilaya est le seul découpage.
    if (payload.wilaya ?? payload.city) fd.set("wilaya", String(payload.wilaya ?? payload.city));
    const r = await createInstitution(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "L'ajout a été refusé." };
    return { ok: true, message: `Établissement « ${name} » ajouté à l'annuaire médical.`, link: "/medical", revalidate: ["/medical"] };
  }

  return undefined;
}
