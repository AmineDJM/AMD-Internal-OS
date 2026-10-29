import { prisma } from "@/lib/prisma";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { champs, nombre, texte, type OperationIA, type PropositionOperation } from "./types";
import { replier } from "./annuaire-medical";
import { dateLongue, DECALAGE_ALGER_H, decrireCalendrier, FUSEAU, JOURS, prochaines, type Calendrier, type Frequence } from "@/lib/agent/routines/calendrier";
import {
  changerStatut, creerRoutine, executerMaintenant, listerRoutines, modifierRoutine, routinesActives, ROUTINES_ACTIVES_MAX, supprimerRoutine,
} from "@/lib/agent/routines/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PROGRAMMER ET GÉRER UNE ROUTINE — par la conversation, confirmé sur une carte.
 *
 * L'assistant ne DEVINE pas l'heure (« dimanche matin » se demande : 8 h, 9 h ?) — la panne la plus
 * citée des tâches planifiées de ChatGPT. La carte dit tout ce qui sera fait, en heure d'Alger,
 * avec les trois prochains passages ; rien n'est programmé avant le geste de la personne.
 * Une routine LIT et RAPPORTE : une demande qui commence par « envoie », « relance », « crée »…
 * est refusée en le disant — le geste reste à la personne, depuis le rapport.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const FREQUENCES: Record<string, Frequence> = {
  "une fois": "ONCE", unique: "ONCE", once: "ONCE",
  quotidienne: "DAILY", quotidien: "DAILY", "chaque jour": "DAILY", daily: "DAILY",
  hebdomadaire: "WEEKLY", "chaque semaine": "WEEKLY", weekly: "WEEKLY",
  mensuelle: "MONTHLY", mensuel: "MONTHLY", "chaque mois": "MONTHLY", monthly: "MONTHLY",
};
const ECRITURE = /^\s*(envoie|envoyer|relance|relancer|cr[ée]e|cr[ée]er|supprime|supprimer|valide|valider|paie|paye|payer|r[ée]ponds|r[ée]pondre|[ée]cris|[ée]crire|commande|commander)\b/i;

/** « 08:00 », « 8h », « 8 h 30 », « 18H15 » → heure et minute ; rien d'autre n'est accepté. */
export function lireHeure(brut: string): { heure: number; minute: number } | null {
  const m = brut.trim().toLowerCase().match(/^(\d{1,2})\s*(?:[:h]\s*(\d{2})?)?\s*(?:min)?$/);
  if (!m) return null;
  const heure = Number(m[1]);
  const minute = m[2] ? Number(m[2]) : 0;
  return heure <= 23 && minute <= 59 ? { heure, minute } : null;
}

export function lireJours(e: Record<string, unknown>): number[] {
  const brut = Array.isArray(e.jours) ? e.jours.map(String) : typeof e.jours === "string" ? e.jours.split(/[,;]| et /) : [];
  const out = new Set<number>();
  for (const b of brut) {
    const k = replier(b);
    if (/ouvr|semaine de travail|working/.test(k)) [0, 1, 2, 3, 4].forEach((j) => out.add(j));
    else if (/tous|chaque jour/.test(k)) [0, 1, 2, 3, 4, 5, 6].forEach((j) => out.add(j));
    else {
      const i = JOURS.findIndex((j) => k.startsWith(replier(j).slice(0, 3)));
      if (i >= 0) out.add(i);
    }
  }
  return [...out].sort();
}

/** Une date AAAA-MM-JJ et une heure d'Alger → l'instant UTC. */
const instantAlger = (date: string, h: number, m: number) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)), h - DECALAGE_ALGER_H, m));
const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type LectureCalendrier = { ok: true; calendrier: Calendrier } | { manque: string[] } | { erreur: string };

export function lireCalendrier(e: Record<string, unknown>, now = new Date()): LectureCalendrier {
  const frequence = FREQUENCES[replier(texte(e, "frequence"))] ?? null;
  const heure = lireHeure(texte(e, "heure"));
  const jours = lireJours(e);
  const date = texte(e, "date");
  const jdm = replier(texte(e, "jourDuMois")) === "dernier" ? -1 : nombre(e, "jourDuMois");
  const manque = [
    !frequence ? "à quelle fréquence : une fois, chaque jour, chaque semaine ou chaque mois" : null,
    !heure ? `à quelle heure (${FUSEAU}) — par exemple 8:00 ou 9:00 ; ne la suppose pas` : null,
    frequence === "WEEKLY" && !jours.length ? "quel(s) jour(s) de la semaine" : null,
    frequence === "ONCE" && !RE_DATE.test(date) ? "quel jour (date)" : null,
    frequence === "MONTHLY" && jdm == null ? "quel jour du mois (1 à 31, ou le dernier)" : null,
  ].filter((x): x is string => x !== null);
  if (manque.length) return { manque };
  if (jdm != null && jdm !== -1 && (jdm < 1 || jdm > 31)) return { erreur: "Un jour du mois va de 1 à 31 (ou « dernier »)." };
  const intervalle = Math.max(1, Math.min(12, Math.round(nombre(e, "intervalle") ?? 1)));
  const fin = texte(e, "fin");
  const finLe = RE_DATE.test(fin) ? instantAlger(fin, 23, 59) : null;
  const max = nombre(e, "nombreDeFois");
  const debutLe = frequence === "ONCE" ? instantAlger(date, heure!.heure, heure!.minute) : RE_DATE.test(date) ? instantAlger(date, 0, 0) : now;
  if (frequence === "ONCE" && debutLe.getTime() <= now.getTime()) return { erreur: "Cette date et cette heure sont déjà passées." };
  return {
    ok: true,
    calendrier: {
      frequence: frequence!, intervalle: frequence === "ONCE" ? 1 : intervalle, jours: frequence === "WEEKLY" ? jours : [],
      jourDuMois: frequence === "MONTHLY" ? jdm : null, heure: heure!.heure, minute: heure!.minute,
      debutLe, finLe, maxExecutions: max != null && max > 0 ? Math.round(max) : null,
    },
  };
}

async function trouverRoutine(user: CurrentUser, nom: string): Promise<{ id: string; titre: string; statut: string } | { manque: string }> {
  const routines = await prisma.assistantRoutine.findMany({ where: { userId: user.id }, select: { id: true, titre: true, statut: true } });
  if (!routines.length) return { manque: "vous n'avez aucune routine — voulez-vous en programmer une ?" };
  const k = replier(nom);
  const t = k ? routines.filter((r) => replier(r.titre).includes(k) || k.includes(replier(r.titre))) : [];
  if (t.length === 1) return t[0]!;
  return { manque: `quelle routine : ${routines.map((r) => `« ${r.titre} »`).join(", ")}` };
}

export const PROGRAMMER_ROUTINE: OperationIA = {
  nom: "programmer_routine",
  module: "ASSISTANT_IA",
  libelle: "Routine préparée",
  description:
    "PROGRAMME (ou modifie, avec `remplace`) une ROUTINE que l'utilisateur te DEMANDE : « fais-moi un briefing du marché pharmaceutique en Algérie chaque dimanche "
    + "à 8 h ». À chaque passage, tu rejoueras `consigne` sous ses droits, en lecture seule (ERP + recherche web), et le rapport lui parvient. `titre` : court, "
    + "à l'impératif, sans date. `consigne` : la demande réécrite comme s'il la tapait. Ne DEVINE jamais l'heure ni le jour : laisse-les vides s'il ne les a "
    + `pas donnés — elle répond \`manque\`, pose alors UNE seule question. Heure d'Alger. Jamais de ta propre initiative.`,
  schema: {
    type: "object",
    properties: {
      titre: { type: "string" },
      consigne: { type: "string" },
      frequence: { type: "string", enum: ["une fois", "quotidienne", "hebdomadaire", "mensuelle"] },
      jours: { type: "array", items: { type: "string" }, description: "Hebdomadaire : jours de la semaine (« dimanche »…), ou « jours ouvrés » (dimanche → jeudi)." },
      heure: { type: "string", description: "HH:MM, heure d'Alger — seulement si l'utilisateur l'a dite." },
      date: { type: "string", description: "AAAA-MM-JJ : le jour d'une routine « une fois », ou la date de début." },
      jourDuMois: { type: "string", description: "Mensuelle : 1 à 31, ou « dernier »." },
      intervalle: { type: "number", description: "Toutes les N périodes (2 = une semaine sur deux)." },
      fin: { type: "string", description: "AAAA-MM-JJ : dernière date possible (facultatif)." },
      nombreDeFois: { type: "number", description: "Nombre de passages au plus (facultatif)." },
      remplace: { type: "string", description: "Le titre d'une routine existante à MODIFIER." },
    },
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user): Promise<PropositionOperation> {
    const existante = texte(e, "remplace") ? await trouverRoutine(user, texte(e, "remplace")) : null;
    if (existante && "manque" in existante) return { manque: [existante.manque] };
    const manque = [
      !texte(e, "consigne") ? "ce que je dois faire à chaque passage" : null,
      !texte(e, "titre") ? "un nom court pour la routine" : null,
    ].filter((x): x is string => x !== null);
    const cal = lireCalendrier(e);
    if ("manque" in cal) manque.push(...cal.manque);
    if (manque.length) return { manque };
    if (!("ok" in cal)) return { erreur: "erreur" in cal ? cal.erreur : "Calendrier incomplet." };
    if (ECRITURE.test(texte(e, "consigne"))) {
      return { erreur: "Une routine LIT et RAPPORTE : elle ne peut pas envoyer, relancer, créer, valider ni payer. Je peux programmer un rapport ; le geste reste le vôtre, depuis ce rapport." };
    }
    if (!existante && (await routinesActives(user.id)) >= ROUTINES_ACTIVES_MAX) {
      return { erreur: `Vous avez déjà ${ROUTINES_ACTIVES_MAX} routines actives : mettez-en une en pause ou supprimez-la d'abord.` };
    }
    const c = cal.calendrier;
    const suivants = prochaines(c, 3, new Date());
    if (!suivants.length) return { erreur: "Ce calendrier ne tombe jamais dans le futur : vérifiez la date, l'heure ou la fin." };
    return {
      carte: {
        title: `${existante ? "Modifier la routine" : "Routine"} « ${texte(e, "titre")} »`,
        fields: champs([
          ["À chaque passage", texte(e, "consigne")],
          ["Quand", decrireCalendrier(c)],
          ["Prochains passages", suivants.map((d) => dateLongue(d)).join("\n")],
          ["Où arrive le rapport", "Onglet « Routines » de l'assistant, et une notification"],
        ]),
        warnings: [
          "En lecture seule : la routine lit l'ERP avec VOS droits du moment et cherche sur le web ; elle n'envoie rien, ne crée rien, ne relance personne.",
          "Chaque passage laisse une trace, même « rien de nouveau » ou un échec — jamais un silence.",
        ],
        libelleBouton: existante ? "Modifier la routine" : "Programmer",
      },
      args: {
        remplace: existante ? (existante as { id: string }).id : null,
        titre: texte(e, "titre"), consigne: texte(e, "consigne"), calendrier: JSON.stringify(c),
      },
    };
  },

  async executer(a, user) {
    let c: Calendrier;
    try {
      const brut = JSON.parse(a.calendrier ?? "{}") as Calendrier & { debutLe: string; finLe: string | null };
      c = { ...brut, debutLe: new Date(brut.debutLe), finLe: brut.finLe ? new Date(brut.finLe) : null };
    } catch {
      return { ok: false, error: "Calendrier illisible." };
    }
    const donnees = { titre: a.titre ?? "Routine", consigne: a.consigne ?? "", calendrier: c };
    const r = a.remplace ? await modifierRoutine(user.id, a.remplace, donnees) : await creerRoutine(user.id, donnees);
    if (!r.ok) return { ok: false, error: r.erreur };
    return {
      ok: true, link: `/assistant?routine=${r.routine.id}`,
      message: `Routine ${a.remplace ? "modifiée" : "programmée"} : prochain passage le ${dateLongue(r.routine.prochaineLe!)} (${FUSEAU}).`,
    };
  },
};

const ACTIONS: Record<string, "PAUSE" | "REPRENDRE" | "SUPPRIMER" | "EXECUTER"> = {
  pause: "PAUSE", "mettre en pause": "PAUSE", suspendre: "PAUSE", reprendre: "REPRENDRE", relancer: "REPRENDRE", activer: "REPRENDRE",
  supprimer: "SUPPRIMER", effacer: "SUPPRIMER", "executer maintenant": "EXECUTER", executer: "EXECUTER", lancer: "EXECUTER",
};
const LIBELLE_ACTION = { PAUSE: "Mettre en pause", REPRENDRE: "Reprendre", SUPPRIMER: "Supprimer", EXECUTER: "Exécuter maintenant" } as const;

export const GERER_ROUTINE: OperationIA = {
  nom: "gerer_routine",
  module: "ASSISTANT_IA",
  libelle: "Geste sur une routine préparé",
  description: "MET EN PAUSE, REPREND, SUPPRIME ou EXÉCUTE MAINTENANT une routine de l'utilisateur, désignée par son titre. Pour la modifier : programmer_routine avec `remplace`.",
  schema: {
    type: "object",
    properties: {
      routine: { type: "string", description: "Le titre (ou un mot du titre) de la routine." },
      action: { type: "string", enum: ["mettre en pause", "reprendre", "supprimer", "exécuter maintenant"] },
    },
  },
  ouverte: (u) => Boolean(u.id),

  async proposer(e, user): Promise<PropositionOperation> {
    const r = await trouverRoutine(user, texte(e, "routine"));
    const action = ACTIONS[replier(texte(e, "action"))] ?? null;
    const manque = ["manque" in r ? r.manque : null, !action ? "quel geste : mettre en pause, reprendre, supprimer ou exécuter maintenant" : null].filter((x): x is string => x !== null);
    if (manque.length) return { manque };
    const routine = r as { id: string; titre: string; statut: string };
    return {
      carte: {
        title: `${LIBELLE_ACTION[action!]} « ${routine.titre} »`,
        fields: champs([["Routine", routine.titre], ["État actuel", routine.statut === "ACTIVE" ? "active" : routine.statut === "PAUSED" ? "en pause" : "terminée"]]),
        warnings: action === "SUPPRIMER" ? ["La routine et l'historique de ses passages seront effacés."] : action === "EXECUTER" ? ["Un passage hors calendrier : il ne compte pas dans les passages prévus."] : [],
        libelleBouton: LIBELLE_ACTION[action!],
        ...(action === "SUPPRIMER" ? { level: "SENSITIVE" as const } : {}),
      },
      args: { id: routine.id, action },
    };
  },

  async executer(a, user) {
    const id = a.id ?? "";
    if (a.action === "SUPPRIMER") return (await supprimerRoutine(user.id, id)) ? { ok: true, message: "Routine supprimée." } : { ok: false, error: "Routine introuvable." };
    if (a.action === "EXECUTER") {
      const r = await executerMaintenant(user.id, id);
      return r.ok ? { ok: true, message: r.statut === "ECHEC" ? "Le passage a échoué : la cause est dans l'onglet Routines." : "Passage fait : le rapport est dans l'onglet Routines.", link: `/assistant?routine=${id}` } : { ok: false, error: r.erreur };
    }
    const r = await changerStatut(user.id, id, a.action === "PAUSE" ? "PAUSED" : "ACTIVE");
    if (!r.ok) return { ok: false, error: r.erreur };
    return { ok: true, message: a.action === "PAUSE" ? "Routine en pause." : `Routine reprise : prochain passage le ${r.routine.prochaineLe ? dateLongue(r.routine.prochaineLe) : "—"}.` };
  },
};

/** Lire SES routines — ce qu'elles font, quand, et le dernier passage. */
export function lectureRoutines(user: CurrentUser): PowerTool {
  return {
    def: {
      name: "mes_routines",
      description: "Tes routines programmées : ce qu'elles font, quand, leur état, leur prochain passage et l'aperçu du dernier rapport.",
      input_schema: { type: "object", properties: {} },
    } as PowerTool["def"],
    allowed: (u) => u.id === user.id,
    label: "Routines consultées",
    run: async () => {
      const r = await listerRoutines(user.id);
      return JSON.stringify({
        routines: r.map((x) => ({
          titre: x.titre, consigne: x.consigne, quand: x.quand, etat: x.statut,
          prochainPassage: x.prochaineLe ? dateLongue(new Date(x.prochaineLe)) : null,
          dernierPassage: x.passages[0] ? { le: dateLongue(new Date(x.passages[0].debutLe)), statut: x.passages[0].statut, apercu: x.passages[0].apercu } : null,
        })),
        actives: `${r.filter((x) => x.statut === "ACTIVE").length}/${ROUTINES_ACTIVES_MAX}`,
      });
    },
  };
}

