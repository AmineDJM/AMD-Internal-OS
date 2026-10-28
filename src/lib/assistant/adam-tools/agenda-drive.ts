import type { PowerTool } from "@/lib/assistant/power-tools";
import { prisma } from "@/lib/prisma";
import { listEvents, freeBusy, findFreeSlots, ALGIERS_TZ } from "@/lib/google/calendar/provider";
import { searchFiles, downloadFile, uploadFile as uploadToGoogleDrive } from "@/lib/google/drive/provider";
import { wrapUntrusted } from "@/lib/comms/untrusted";
import { getBlob } from "@/lib/drive-storage";
import { resolveDriveAccess, canViewDrive } from "@/lib/drive";
import { extractAttachmentText } from "@/lib/assistant-files";
import { EXEC, str, num, fr, activeOrMessage } from "./commun";

/**
 * OUTILS D'ADAM — l'agenda Google (chercher, créneaux libres) et le Drive Google (chercher, lire,
 * rapatrier un fichier dans le Drive interne).
 *
 * Morceau de `ADAM_TOOLS` (`../adam-tools.ts`), recomposé dans l'ordre d'origine : l'ordre des
 * outils fait partie du prompt de l'IA.
 */
export const OUTILS_AGENDA_DRIVE: PowerTool[] = [
  // ───────────────────────────── AGENDA ─────────────────────────────
  {
    def: {
      name: "gcal_search",
      description: "Lit l'agenda Google d'Adam : réunions à venir (ou passées), participants, lieu, lien de visio. Fuseau d'Alger.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Mots cherchés dans le titre." },
          days: { type: "number", description: "Fenêtre en jours (défaut 14 ; négatif pour le passé)." },
          limit: { type: "number", description: "Nombre maximum (défaut 15)." },
        },
      },
    },
    allowed: EXEC,
    label: "Agenda Google consulté",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const days = num(input, "days") ?? 14;
      const now = new Date();
      const events = await listEvents(active.token, {
        timeMin: days >= 0 ? now : new Date(now.getTime() + days * 86_400_000),
        timeMax: days >= 0 ? new Date(now.getTime() + days * 86_400_000) : now,
        q: str(input, "q") || undefined,
        maxResults: num(input, "limit") ?? 15,
      });
      if (events.length === 0) return JSON.stringify({ evenements: [], message: "Aucun événement sur cette période." });
      return JSON.stringify({
        fuseau: ALGIERS_TZ,
        evenements: events.map((e) => ({
          id: e.id, titre: e.summary, debut: e.start, fin: e.end,
          participants: e.attendees.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`),
          lieu: e.location, visio: e.meetLink, statut: e.status,
        })),
      });
    },
  },

  {
    def: {
      name: "gcal_free_slots",
      description:
        "Trouve des CRÉNEAUX LIBRES dans l'agenda d'Adam (heures ouvrables, week-end algérien vendredi/samedi exclu). "
        + "Utiliser avant de proposer une réunion : proposer un horaire déjà pris fait perdre un aller-retour.",
      input_schema: {
        type: "object",
        properties: {
          durationMin: { type: "number", description: "Durée souhaitée en minutes (défaut 60)." },
          withinDays: { type: "number", description: "Horizon de recherche en jours (défaut 7)." },
          limit: { type: "number", description: "Nombre de créneaux (défaut 5)." },
        },
      },
    },
    allowed: EXEC,
    label: "Créneaux cherchés",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const withinDays = num(input, "withinDays") ?? 7;
      const from = new Date();
      const to = new Date(from.getTime() + withinDays * 86_400_000);
      const busy = await freeBusy(active.token, { timeMin: from, timeMax: to });
      const slots = findFreeSlots(busy, {
        from, to, durationMin: num(input, "durationMin") ?? 60, limit: num(input, "limit") ?? 5,
      });
      if (slots.length === 0) return JSON.stringify({ creneaux: [], message: "Aucun créneau libre sur cette période." });
      return JSON.stringify({
        fuseau: ALGIERS_TZ,
        creneaux: slots.map((s) => ({ debut: s.start.toISOString(), fin: s.end.toISOString(), lisible: `${fr(s.start)} → ${fr(s.end)}` })),
      });
    },
  },

  // ───────────────────────────── DRIVE GOOGLE ─────────────────────────────
  {
    def: {
      name: "gdrive_search",
      description: "Cherche dans le Drive Google d'Adam (nom et contenu). Distinct du Drive INTERNE de l'ERP — préciser lequel dans la réponse.",
      input_schema: {
        type: "object",
        properties: {
          q: { type: "string", description: "Mots cherchés." },
          limit: { type: "number", description: "Nombre maximum (défaut 15)." },
        },
      },
    },
    allowed: EXEC,
    label: "Drive Google consulté",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const files = await searchFiles(active.token, { q: str(input, "q") || undefined, maxResults: num(input, "limit") ?? 15 });
      if (files.length === 0) return JSON.stringify({ fichiers: [], message: "Aucun fichier correspondant dans le Drive Google." });
      return JSON.stringify({
        fichiers: files.map((f) => ({
          id: f.id, nom: f.name, type: f.isFolder ? "dossier" : f.mimeType,
          modifieLe: f.modifiedAt, lien: f.webViewLink, tailleOctets: f.sizeBytes,
        })),
      });
    },
  },

  {
    def: {
      name: "gdrive_read",
      description: "Lit le contenu texte d'un fichier du Drive Google (documents Google exportés automatiquement).",
      input_schema: {
        type: "object",
        properties: { fileId: { type: "string", description: "Identifiant du fichier (rendu par gdrive_search)." } },
        required: ["fileId"],
      },
    },
    allowed: EXEC,
    label: "Fichier Google lu",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const fileId = str(input, "fileId");
      try {
        const file = await downloadFile(active.token, fileId);
        const extracted = await extractAttachmentText(file.filename, file.buffer);
        if (!extracted.text) {
          return JSON.stringify({ fichier: file.filename, lisible: false, raison: extracted.note ?? "Contenu non extractible." });
        }
        return JSON.stringify({
          fichier: file.filename,
          contenu: wrapUntrusted(extracted.text, { source: `Drive Google — ${file.filename}`, kind: "fichier", maxChars: 9000 }),
        });
      } catch (e) {
        return `Lecture impossible : ${e instanceof Error ? e.message : "erreur inconnue"}.`;
      }
    },
  },

  {
    def: {
      name: "gdrive_put_internal_file",
      description:
        "Copie un fichier du Drive INTERNE de l'ERP vers le Drive Google d'Adam (pour le partager ensuite ou le joindre). "
        + "Le fichier interne reste intact ; vos droits sur lui sont revérifiés.",
      input_schema: {
        type: "object",
        properties: { name: { type: "string", description: "Nom (ou fragment) du fichier interne." } },
        required: ["name"],
      },
    },
    allowed: EXEC,
    label: "Fichier interne déposé sur Google Drive",
    run: async (input, user) => {
      const active = await activeOrMessage(user.id);
      if (typeof active === "string") return active;
      const wanted = str(input, "name");
      const node = await prisma.driveNode.findFirst({
        where: { name: { contains: wanted, mode: "insensitive" }, type: "FILE", isTrashed: false },
        select: { id: true, name: true, mimeType: true },
        orderBy: { updatedAt: "desc" },
      });
      if (!node) return `Aucun fichier « ${wanted} » dans le Drive interne.`;
      if (!canViewDrive(await resolveDriveAccess(user, node.id))) return `Vous n'avez pas accès à « ${node.name} ».`;
      const version = await prisma.fileVersion.findFirst({ where: { nodeId: node.id }, orderBy: { version: "desc" }, select: { blobId: true } });
      if (!version) return `« ${node.name} » n'a aucun contenu téléversé.`;
      const bytes = await getBlob(version.blobId);
      if (!bytes) return `Le contenu de « ${node.name} » est illisible.`;
      const up = await uploadToGoogleDrive(active.token, { name: node.name, content: bytes, mimeType: node.mimeType ?? undefined });
      return JSON.stringify({ ok: true, fichier: up.name, googleFileId: up.id, lien: up.webViewLink });
    },
  },
];
