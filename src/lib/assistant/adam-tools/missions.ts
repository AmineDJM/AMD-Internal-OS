import type { PowerTool } from "@/platform/ia/outil";
import {
  prisma, createMission, missionSnapshot, activeMissions, setMissionExtracted, nudgeCandidates, MISSION_STATUS_LABEL,
} from "./dependances";
import { EXEC, str, num, fr } from "./commun";

/**
 * OUTILS D'ADAM — les MISSIONS de sollicitation : créer, suivre les participants, consolider, relancer.
 *
 * Morceau de `ADAM_TOOLS` (`../adam-tools.ts`), recomposé dans l'ordre d'origine : l'ordre des
 * outils fait partie du prompt de l'IA.
 */
export const OUTILS_MISSIONS: PowerTool[] = [
  // ───────────────────────────── MISSIONS ─────────────────────────────
  {
    def: {
      name: "mission_create",
      description:
        "Crée une MISSION : une demande qui survit à la conversation (« demande à Regulatory ce dont ils ont besoin de Deepak »). "
        + "Adam tiendra ensuite l'état : qui a répondu, qui manque, ce qu'ils demandent. Créer la mission AVANT de préparer le message, puis passer son id à gmail_prepare_mail.",
      input_schema: {
        type: "object",
        properties: {
          title: { type: "string", description: "Titre court de la mission." },
          objective: { type: "string", description: "Ce qu'on cherche à obtenir." },
          people: { type: "string", description: "Les personnes sollicitées : noms d'employés ou adresses, séparés par des virgules." },
          context: { type: "string", description: "Contexte utile." },
        },
        required: ["title", "objective"],
      },
    },
    allowed: EXEC,
    label: "Mission créée",
    run: async (input, user) => {
      const people = str(input, "people");
      const participants: { userId?: string | null; email?: string | null; name?: string | null }[] = [];
      for (const raw of people.split(/[,;]/).map((s) => s.trim()).filter(Boolean)) {
        if (raw.includes("@")) { participants.push({ email: raw.toLowerCase(), name: raw }); continue; }
        const person = await prisma.user.findFirst({
          where: { name: { contains: raw, mode: "insensitive" }, isActive: true },
          select: { id: true, name: true, email: true },
        });
        if (!person) return `Personne inconnue : « ${raw} ». Donnez un nom exact du registre, ou une adresse.`;
        participants.push({ userId: person.id, email: person.email.toLowerCase(), name: person.name });
      }
      const mission = await createMission({
        ownerId: user.id,
        title: str(input, "title"),
        objective: str(input, "objective"),
        context: str(input, "context") || null,
        participants,
      });
      return JSON.stringify({
        missionId: mission.id,
        titre: mission.title,
        personnes: participants.map((p) => p.name ?? p.email),
        prochaineEtape: "Préparer le message avec gmail_prepare_mail (en passant missionId), puis proposer send_prepared_mail pour l'approbation.",
      });
    },
  },

  {
    def: {
      // ── RENOMMÉ : IL S'APPELAIT `mission_status`, COMME UN AUTRE ──────────────────────
      //
      // Deux capacités portaient ce nom : celle-ci (la SOLLICITATION — qui a répondu, qui
      // manque) et celle du Mission Runtime (`business-capabilities.ts` — les étapes, les
      // éventails, l'avancement). Le registre en envoyait DEUX au modèle, avec deux schémas
      // qui ne s'accordent pas (`missionId` ici, `mission` là), et l'aiguillage n'en atteignait
      // qu'une : celle-ci était donc morte à l'exécution, et sa description faisait écrire au
      // modèle une clé que l'autre ignore — la réponse revenait alors sur TOUTES les missions
      // au lieu de celle demandée. Un faux succès silencieux.
      //
      // Les deux répondent à des questions différentes et méritent d'exister ; ce sont les
      // NOMS qui ne pouvaient pas coexister. `capability-surface.test.ts` interdit désormais
      // le doublon, pour que la question ne se repose pas.
      name: "mission_participants",
      description:
        "QUI A RÉPONDU ET QUI MANQUE sur une mission de sollicitation : ce qui a été demandé à chacun, "
        + "qui a répondu et ce qu'il dit, qui n'a pas répondu et depuis quand, les relances envoyées, "
        + "les demandes consolidées et la prochaine action. "
        + "C'est la réponse à « qui n'a pas répondu ? ». Pour l'AVANCEMENT des étapes d'une mission "
        + "du moteur (éventails, sous-missions, ce qui attend votre accord), c'est `mission_status`.",
      input_schema: {
        type: "object",
        properties: {
          missionId: { type: "string", description: "Mission précise. Omettre pour la liste des missions vivantes." },
        },
      },
    },
    allowed: EXEC,
    label: "Participants d'une mission",
    run: async (input, user) => {
      const missionId = str(input, "missionId");
      if (missionId) {
        const snap = await missionSnapshot(missionId);
        if (!snap) return "Mission introuvable.";
        return JSON.stringify({
          id: snap.id, titre: snap.title, objectif: snap.objective, etat: MISSION_STATUS_LABEL[snap.status],
          ontRepondu: snap.responded.map((r) => ({ qui: r.name, ceQuIlsDisent: r.note?.slice(0, 400) })),
          manquent: snap.missing.map((m) => ({ qui: m.name, sollicitéLe: m.askedAt ? fr(m.askedAt) : null, relanceLe: m.nudgedAt ? fr(m.nudgedAt) : null })),
          demandesConsolidees: snap.extracted,
          prochaineAction: snap.nextAction,
        });
      }
      const missions = await activeMissions(user.id, 15);
      if (missions.length === 0) return JSON.stringify({ missions: [], message: "Aucune mission en cours." });
      return JSON.stringify({
        missions: missions.map((m) => ({
          id: m.id, titre: m.title, etat: MISSION_STATUS_LABEL[m.status],
          ontRepondu: m.participants.filter((p) => p.state === "RESPONDED").map((p) => p.name ?? p.email),
          manquent: m.participants.filter((p) => p.state !== "RESPONDED").map((p) => p.name ?? p.email),
          misAJour: fr(m.updatedAt),
        })),
      });
    },
  },

  {
    def: {
      name: "mission_consolidate",
      description:
        "Consolide les demandes recueillies dans une mission (ce que chacun demande), pour préparer le message à transmettre. "
        + "Donner la liste telle qu'on la comprend des réponses — Adam la mémorise sur la mission.",
      input_schema: {
        type: "object",
        properties: {
          missionId: { type: "string" },
          items: { type: "string", description: "Une demande par ligne, au format « Personne : demande »." },
          nextAction: { type: "string", description: "La prochaine action suggérée." },
        },
        required: ["missionId", "items"],
      },
    },
    allowed: EXEC,
    label: "Mission consolidée",
    run: async (input, user) => {
      const missionId = str(input, "missionId");
      const mission = await prisma.mission.findFirst({ where: { id: missionId, ownerId: user.id }, select: { id: true } });
      if (!mission) return "Mission introuvable.";
      const items = str(input, "items")
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((line) => {
          const idx = line.indexOf(":");
          return idx > 0
            ? { from: line.slice(0, idx).trim(), request: line.slice(idx + 1).trim() }
            : { from: "—", request: line };
        });
      if (items.length === 0) return "Aucune demande à consolider.";
      await setMissionExtracted(missionId, items);
      const next = str(input, "nextAction");
      if (next) await prisma.mission.update({ where: { id: missionId }, data: { nextAction: next } });
      return JSON.stringify({ ok: true, consolidees: items.length, prochaineAction: next || null });
    },
  },

  {
    def: {
      name: "mission_nudge_candidates",
      description:
        "Qui faut-il RELANCER ? Rend les personnes sollicitées depuis plus de 48 h qui n'ont pas répondu et qu'on n'a pas déjà relancées. "
        + "Adam prépare ensuite la relance avec gmail_prepare_mail — l'envoi reste soumis à la politique.",
      input_schema: {
        type: "object",
        properties: { afterHours: { type: "number", description: "Délai en heures (défaut 48)." } },
      },
    },
    allowed: EXEC,
    label: "Relances à préparer",
    run: async (input, user) => {
      const candidates = await nudgeCandidates(user.id, num(input, "afterHours") ?? 48);
      if (candidates.length === 0) return JSON.stringify({ aRelancer: 0, message: "Personne à relancer pour l'instant." });
      return JSON.stringify({ aRelancer: candidates.length, personnes: candidates });
    },
  },
];
