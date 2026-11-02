import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { peutUtiliserAssistantIA } from "@/lib/rbac";
import { designerMission } from "../../domaine/missions/pilotage";
import type { OperationIA } from "../../domaine/operations/types";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * FUSIONNER DES MISSIONS (lot P1, décision 0047) — « merge-les dans le même tableau » : N missions → UNE.
 *
 * Constat de la Direction (02/11) : l'assistant a lancé une TROISIÈME mission au lieu de fusionner les deux premières.
 * La carte dit ce qui sera ARRÊTÉ (sous-missions comprises) et ce qui reste : soit une mission GARDÉE (la plus avancée
 * par défaut, renommée si un titre est donné), soit une NOUVELLE mission dont le plan couvre l'union des objectifs
 * (`plan`, même forme que `lancer_un_travail`, relu contre le catalogue de la personne). Confirmée : les autres sont
 * arrêtées par une pause marquée « fusionnée dans « … » » — « reprendre » en relance une, l'arrêt se défait ; la
 * conversation ne reçoit qu'UNE synthèse (celle de la mission qui reste).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const VIVANTES = new Set(["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "BUDGET_HOLD", "EN_PAUSE", "BLOQUE"]);
const liste = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split(/\s*[,;]\s*/) : []).map((x) => String(x).trim()).filter(Boolean).slice(0, 12);

export const FUSION_MISSIONS: OperationIA = {
  nom: "fusionner_missions",
  module: "ASSISTANT_IA",
  libelle: "Fusion de missions préparée",
  description:
    "FUSIONNE plusieurs missions de la personne en UNE (« merge-les », « mets-les dans le même tableau ») — au lieu d'en lancer une de plus. "
    + "Désigne-les par identifiant ou nom (vide = toutes les missions vivantes). Soit tu GARDES l'une (`garder`, la plus avancée par défaut ; `titre` la renomme), "
    + "soit tu donnes un `plan` (même forme que lancer_un_travail) qui couvre l'union des objectifs : une nouvelle mission le porte. Les autres sont arrêtées "
    + "(sous-missions comprises, réversible : « reprendre »). Carte à confirmer : rien n'est fait avant.",
  schema: {
    type: "object",
    properties: {
      missions: { type: "array", items: { type: "string" }, description: "Identifiants (lus par mes_missions) ou noms des missions à fusionner ; vide = toutes les vivantes." },
      garder: { type: "string", description: "Identifiant ou nom de la mission qui reste (si pas de plan)." },
      titre: { type: "string", description: "Le titre de la mission unique." },
      plan: { type: "object", description: "Facultatif : le plan unique { titre, objectif, etapes } qui couvre TOUS les objectifs (forme de lancer_un_travail)." },
    },
  },
  ouverte: (u: CurrentUser) => peutUtiliserAssistantIA(u),

  async proposer(entree, user) {
    const { mesMissions } = await import("../missions/pilotage");
    const { missions } = await mesMissions(user.id);
    const vivantes = missions.filter((m) => VIVANTES.has(m.etat) && !m.parentId);
    if (vivantes.length < 2) return { erreur: `Il n'y a pas plusieurs missions à fusionner (${vivantes.length} mission vivante${vivantes.length > 1 ? "s" : ""}${vivantes.length ? ` : « ${vivantes[0]!.titre} »` : ""}).` };
    // Les missions désignées — chaque désignation doit en viser UNE (sinon on nomme les candidates, on ne devine pas).
    const designations = liste(entree.missions);
    let choisies = vivantes;
    if (designations.length) {
      const ids = new Set<string>();
      for (const d of designations) {
        const { vises, ambigu } = designerMission(vivantes, d);
        if (!vises.length) return { erreur: `Aucune mission vivante ne correspond à « ${d} ». Missions : ${vivantes.map((m) => `« ${m.titre} » (${m.id})`).join(", ")}.` };
        if (ambigu && designations.length > 1) return { erreur: `« ${d} » désigne plusieurs missions : ${vises.map((m) => `« ${m.titre} » (${m.id})`).join(", ")} — désigne-les par identifiant.` };
        for (const v of vises) ids.add(v.id);
      }
      choisies = vivantes.filter((m) => ids.has(m.id));
    }
    if (choisies.length < 2) return { erreur: `Une fusion porte sur au moins deux missions (une seule désignée : « ${choisies[0]?.titre ?? "?"} »).` };

    const titre = typeof entree.titre === "string" ? entree.titre.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    let plan: unknown = null;
    let garder: (typeof choisies)[number] | null = null;
    if (entree.plan && typeof entree.plan === "object") {
      const { PERSONA_ASSISTANT_IA, lirePlan } = await import("../travaux");
      const brut = { ...(entree.plan as Record<string, unknown>), ...(titre ? { titre } : {}) };
      const lu = lirePlan(brut, await PERSONA_ASSISTANT_IA.catalogue(user.id));
      if (!lu.ok) return { erreur: `Le plan unique ne passe pas : ${lu.fautes.slice(0, 4).join(" ")}` };
      plan = brut;
    } else {
      const g = typeof entree.garder === "string" && entree.garder.trim() ? designerMission(choisies, entree.garder) : null;
      if (g && g.vises.length !== 1) return { erreur: `« ${entree.garder} » ne désigne pas UNE des missions à fusionner (${choisies.map((m) => `« ${m.titre} »`).join(", ")}).` };
      // Par défaut, la plus avancée (étapes faites, puis la plus récente) : rien de fait n'est refait.
      garder = g?.vises[0] ?? [...choisies].sort((a, b) => b.etapes.faites - a.etapes.faites || b.majLe.localeCompare(a.majLe))[0]!;
    }
    const arreter = choisies.filter((m) => m.id !== garder?.id);
    const titreFinal = plan ? String((plan as { titre?: unknown }).titre ?? titre) : (titre || garder!.titre);
    const etapesPlan = plan ? ((plan as { etapes?: unknown[] }).etapes ?? []).length : 0;
    return {
      carte: {
        title: `Fusionner ${choisies.length} missions en une : « ${titreFinal} »`,
        fields: [
          ...(garder
            ? [{ label: "Reste", value: `« ${garder.titre} » (${garder.etapes.faites}/${garder.etapes.total} étapes)${titre && titre !== garder.titre ? ` — renommée « ${titre} »` : ""}` }]
            : [{ label: "Nouvelle mission", value: `« ${titreFinal} » — ${etapesPlan} étape(s), objectifs réunis` }]),
          ...arreter.map((m, i) => ({ label: i === 0 ? "Sera arrêtée" : "Et arrêtée", value: `« ${m.titre} » (${m.etapes.faites}/${m.etapes.total} étapes, ${m.libelle.toLowerCase()})` })),
        ],
        warnings: [
          "Les missions arrêtées le sont avec leurs sous-missions ; rien de ce qu'elles ont déjà fait n'est perdu.",
          "Réversible : « reprendre » relance une mission arrêtée ; l'annulation du geste (Ce que l'assistant a fait) remet tout comme avant.",
          ...(plan ? ["La nouvelle mission démarre d'office si son plan n'a aucun geste et que votre réglage le permet ; sinon elle attend votre approbation au tableau « Missions »."] : []),
        ],
        libelleBouton: "Fusionner",
      },
      args: {
        garder: garder?.id ?? null,
        arreter: JSON.stringify(arreter.map((m) => m.id)),
        titre: titre || null,
        titreFinal,
        plan: plan ? JSON.stringify(plan) : null,
      },
    };
  },

  async executer(args, user) {
    const t = await import("../travaux");
    const { travauxDOfficePour } = await import("../sous-missions");
    const arreter = (() => { try { return (JSON.parse(args.arreter ?? "[]") as unknown[]).map(String).slice(0, 12); } catch { return []; } })();
    const titreFinal = (args.titreFinal ?? args.titre ?? "mission unique").slice(0, 120);
    let reste: { id: string; titre: string; message: string };
    if (args.plan) {
      const r = await t.proposerTravail(user.id, t.PERSONA_ASSISTANT_IA, JSON.parse(args.plan), { origine: "assistant-ia:fusion" });
      if (!r.ok) return { ok: false, error: `Le plan unique ne passe plus : ${r.fautes.slice(0, 3).join(" ")} Rien n'a été arrêté.` };
      let message = "elle attend votre approbation au tableau « Missions »";
      if ((await travauxDOfficePour(user)) && t.planSansGeste(r.plan, r.gestes)) {
        const d = await t.demarrerDOffice(r.travailId, user.id, t.PERSONA_ASSISTANT_IA);
        if (d.ok) message = "elle a démarré d'office";
      }
      reste = { id: r.travailId, titre: r.plan.titre, message };
      // LA SYNTHÈSE UNIQUE : la nouvelle mission rejoint la conversation de la plus récente des missions fusionnées.
      const tour = await prisma.assistantIaTour.findFirst({
        where: { userId: user.id, role: "assistant", syntheseDe: null, OR: arreter.map((id) => ({ travaux: { array_contains: [id] } })) },
        orderBy: { createdAt: "desc" }, select: { id: true, travaux: true },
      });
      if (tour) await prisma.assistantIaTour.update({ where: { id: tour.id }, data: { travaux: [...(Array.isArray(tour.travaux) ? tour.travaux : []), r.travailId] as Prisma.InputJsonValue } });
    } else {
      const id = args.garder ?? "";
      const m = await prisma.mission.findFirst({ where: { id, principalId: user.id, ownerId: user.id, kind: "TRAVAIL" }, select: { id: true, title: true } });
      if (!m) return { ok: false, error: "La mission à garder n'existe plus. Rien n'a été arrêté." };
      if (args.titre && args.titre !== m.title) await t.renommerTravail(m.id, user.id, args.titre);
      reste = { id: m.id, titre: args.titre || m.title, message: "elle continue" };
    }
    const faits: string[] = [];
    const refus: string[] = [];
    for (const id of arreter) {
      const r = await t.arreterTravail(id, user.id, `${t.MOTIF_FUSION} « ${reste.titre} »`);
      if (r.ok) faits.push(id); else refus.push(r.erreur);
    }
    const titres = await prisma.mission.findMany({ where: { id: { in: faits } }, select: { title: true } });
    return {
      ok: refus.length === 0,
      message: `Fusion faite : « ${reste.titre} » reste (${reste.message}) ; arrêtée${titres.length > 1 ? "s" : ""} : ${titres.map((x) => `« ${x.title} »`).join(", ") || "aucune"}.${refus.length ? ` Non arrêtée(s) : ${refus.join(" ; ")}` : ""} « Reprendre » relance une mission arrêtée.`,
      ...(refus.length ? { error: refus.join(" ; ") } : {}),
      link: `/assistant?travail=${reste.id}`,
    };
  },
};
