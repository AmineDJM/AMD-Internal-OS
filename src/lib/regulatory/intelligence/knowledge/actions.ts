"use server";

import { requireUser } from "@/lib/session";
import { enLecture } from "@/lib/vue-lecture";
import { prisma } from "@/lib/prisma";
import { aiConfigured } from "@/lib/ai";
import { regCan, resolveRegCompanyIdFor } from "../access";
import { type ChatTurn, type DossierChatResult } from "./dossier-chat";
import { runDossierAgent, type AgentAttachment, type DossierAgentResult, type UnreadableAttachment } from "./dossier-agent";
import { appendThreadMessage, clearThread, loadThread, loadThreadMemory, type AttachmentRecord, type ThreadMessageView } from "./dossier-thread";
import { extractText } from "../extract/extract-text";
import { canOcr, ocrDocument } from "../ocr/ocr-engine";
import { askReserves } from "../reserves/chat";
import { sansBloquer } from "@/lib/journal";

/** Historique conversationnel transmis par le client (borné, texte pur — jamais une consigne). */
function parseHistory(raw: string): ChatTurn[] {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((t): t is { role: string; content: string } => t && typeof t.content === "string" && (t.role === "user" || t.role === "assistant"))
      .map((t) => ({ role: t.role as "user" | "assistant", content: String(t.content).slice(0, 800) }))
      .slice(-6);
  } catch {
    return [];
  }
}

/**
 * Action « DISCUTER AVEC LES RÉSERVES » — rédige/discute des réponses EXIGEANTES aux réserves ANPP
 * du dossier, sourcées et dans le périmètre technique (abstention prix/commercial ; renvoi
 * fournisseur si donnée absente). Mêmes gardes d'accès et d'isolation que le chatbot de dossier.
 */
/**
 * ACTION DE L'AGENT DE DOSSIER — la version OUTILLÉE de « Discuter avec ce dossier ».
 * Accepte des PIÈCES JOINTES (PDF, DOCX, images scannées, TXT…) : extraites ici (OCR réel au
 * besoin) puis remises à l'agent comme contenu de conversation. Mêmes gardes d'accès que le chat.
 *
 * MESSAGERIE : le fil persiste en base par (dossier, utilisateur) — on quitte l'app, on revient,
 * la discussion est là. L'historique et les pièces des tours précédents sont relus CÔTÉ SERVEUR
 * (le client n'envoie plus l'historique) : l'agent revoit les lettres déjà soumises. Une pièce
 * illisible n'échoue plus le message — son motif exact est remonté et l'agent répond avec le reste.
 */
export async function askDossierAgentAction(formData: FormData): Promise<DossierAgentResult> {
  const fail = (error: string): DossierAgentResult => ({ ok: false, configured: aiConfigured(), answer: "", citations: [], files: [], error });
  const user = await requireUser();
  if (!regCan(user, "regulatory.document.view") && user.role !== "SUPER_ADMIN") return fail("Non autorisé.");

  const dossierId = String(formData.get("dossierId") ?? "").trim();
  const question = String(formData.get("question") ?? "").trim();
  if (!dossierId || !question) return fail("Paramètres manquants.");

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return fail("Module non activé.");

  const version = await prisma.regulatoryDossierVersion.findFirst({
    where: { dossierId, dossier: { companyId } },
    orderBy: { versionNo: "desc" },
    select: { id: true },
  });
  if (!version) return fail("Aucune version de dossier.");

  // Mémoire du fil AVANT d'y écrire le nouveau message (sinon le tour courant s'y verrait en double).
  const memory = await loadThreadMemory(dossierId, user.id).catch(sansBloquer("knowledge-actions.askDossierAgentAction.loadThreadMemory", { history: [] as ChatTurn[], priorAttachments: [] as AgentAttachment[] }));

  // PIÈCES JOINTES : 3 max, 20 Mo chacune — extraites tout de suite, OCR réel si scan. Une pièce
  // qui résiste (scan vide, format hostile, dépassement) est marquée ILLISIBLE avec son motif et
  // le message CONTINUE : l'agent le dit et répond sur ce qui est lisible.
  const attachments: AgentAttachment[] = [];
  const unreadable: UnreadableAttachment[] = [];
  const records: AttachmentRecord[] = [];
  const files = formData.getAll("files").filter((f): f is File => f instanceof File && f.size > 0).slice(0, 3);
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) {
      unreadable.push({ filename: file.name, reason: "la pièce dépasse 20 Mo" });
      records.push({ filename: file.name, error: "dépasse 20 Mo" });
      continue;
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const ext = (file.name.split(".").pop() ?? "").toLowerCase();
    let text = "";
    let reason = "";
    try {
      const extracted = await extractText(ext, buffer);
      text = (extracted.text ?? "").trim();
      if ((extracted.status === "OCR_REQUIRED" || text.length < 40) && canOcr(ext)) {
        // OCR réel + SECOURS VISION : les pages que l'OCR n'arrive pas à lire sont transcrites
        // par le modèle multimodal (tracé sur le dossier, en cache). « Illisible » ne se dit
        // qu'après avoir VRAIMENT tout tenté.
        const ocr = await ocrDocument({ ext, buffer, aiRescue: { dossierId, label: file.name } });
        if (ocr.text.trim().length > text.length) text = ocr.text.trim();
      }
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
    }
    // Seuil VOLONTAIREMENT bas : même un texte pauvre se discute (l'agent voit ce qu'il y a et le
    // dit) — seul le VIDE est écarté, avec son motif exact.
    if (text.length >= 10) {
      attachments.push({ filename: file.name, text });
      records.push({ filename: file.name, text });
    } else {
      const detail = reason
        ? `échec d'extraction (${reason.slice(0, 200)})`
        : canOcr(ext)
          ? "aucun texte exploitable, même après OCR et transcription par IA (scan vide ou pur graphique)"
          : `aucun texte extrait (format « ${ext || "?"} » sans OCR possible)`;
      unreadable.push({ filename: file.name, reason: detail });
      records.push({ filename: file.name, error: detail });
    }
  }

  // Le message du pharmacien entre dans le fil TOUT DE SUITE (pièces comprises) : même si l'agent
  // échoue ensuite, la messagerie garde le message — comme une vraie messagerie. Sans clé IA on
  // n'écrit rien : la réponse « clé requise » n'est pas une conversation.
  if (aiConfigured()) {
    await appendThreadMessage(dossierId, user.id, { role: "user", content: question, attachments: records });
  }

  let result: DossierAgentResult;
  try {
    result = await runDossierAgent({
      dossierVersionId: version.id,
      userId: user.id,
      question,
      history: memory.history,
      attachments,
      priorAttachments: memory.priorAttachments,
      unreadable,
    });
  } catch (err) {
    result = fail(`L'agent a rencontré une erreur : ${err instanceof Error ? err.message : String(err)}`);
  }

  if (result.configured) {
    await appendThreadMessage(dossierId, user.id, {
      role: "assistant",
      content: result.ok ? result.answer || "(réponse vide)" : result.error ?? "Réponse indisponible.",
      citations: result.citations,
      files: result.files,
      error: !result.ok,
    });
  }
  return result;
}

/** Recharge le fil persistant du dossier (messagerie) — mêmes gardes d'accès que l'agent. */
export async function loadDossierChatAction(formData: FormData): Promise<{ ok: boolean; messages: ThreadMessageView[]; error?: string }> {
  const fail = (error: string) => ({ ok: false, messages: [] as ThreadMessageView[], error });
  const user = await enLecture(requireUser);
  if (!regCan(user, "regulatory.document.view") && user.role !== "SUPER_ADMIN") return fail("Non autorisé.");
  const dossierId = String(formData.get("dossierId") ?? "").trim();
  if (!dossierId) return fail("Paramètres manquants.");
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return fail("Module non activé.");
  const dossier = await prisma.regulatoryDossier.findFirst({ where: { id: dossierId, companyId }, select: { id: true } });
  if (!dossier) return fail("Dossier introuvable.");
  try {
    return { ok: true, messages: await loadThread(dossierId, user.id) };
  } catch {
    return fail("Fil indisponible.");
  }
}

/** Efface le fil de CET utilisateur sur CE dossier (« Nouvelle discussion »). */
export async function resetDossierChatAction(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const user = await requireUser();
  if (!regCan(user, "regulatory.document.view") && user.role !== "SUPER_ADMIN") return { ok: false, error: "Non autorisé." };
  const dossierId = String(formData.get("dossierId") ?? "").trim();
  if (!dossierId) return { ok: false, error: "Paramètres manquants." };
  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return { ok: false, error: "Module non activé." };
  const dossier = await prisma.regulatoryDossier.findFirst({ where: { id: dossierId, companyId }, select: { id: true } });
  if (!dossier) return { ok: false, error: "Dossier introuvable." };
  try {
    await clearThread(dossierId, user.id);
    return { ok: true };
  } catch {
    return { ok: false, error: "Effacement impossible." };
  }
}

export async function askReservesAction(formData: FormData): Promise<DossierChatResult> {
  const fail = (error: string): DossierChatResult => ({ ok: false, configured: aiConfigured(), answer: "", citations: [], error });
  const user = await requireUser();
  if (!regCan(user, "regulatory.document.view") && user.role !== "SUPER_ADMIN") return fail("Non autorisé.");

  const dossierId = String(formData.get("dossierId") ?? "").trim();
  const question = String(formData.get("question") ?? "").trim();
  if (!dossierId || !question) return fail("Paramètres manquants.");

  const companyId = await resolveRegCompanyIdFor(user.id);
  if (!companyId) return fail("Module non activé.");
  // Isolation : le dossier doit appartenir à l'organisation activée.
  const dossier = await prisma.regulatoryDossier.findFirst({ where: { id: dossierId, companyId }, select: { id: true } });
  if (!dossier) return fail("Dossier introuvable.");

  const history = parseHistory(String(formData.get("history") ?? ""));
  return askReserves(dossierId, question, undefined, history);
}
