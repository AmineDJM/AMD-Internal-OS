import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { annulerEffetSortant, annulerGeste, effetsSortantsDe, gestesDeLAssistant, retablirGeste } from "@/platform/ia/hors-requete";
import { phraseAnnulation } from "../domaine/terrain/oral";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « ANNULE » / « RÉTABLIS » — UNE porte, à l'ÉCRIT comme à la VOIX (Direction, 03/11/2026 : « si c'est fait par
 * l'assistant, on peut lui demander d'annuler lui-même et il le fait lui-même ; pas de pop-up ; ça doit vraiment
 * annuler »). Exécuté TOUT DE SUITE : annuler est lui-même réversible (« rétablis »), une carte de confirmation
 * d'annulation ajoutait un geste à annuler. Remplace l'opération à carte `annuler_mon_action`.
 *
 *   • ANNULER : la DERNIÈRE chose faite au nom de la personne, de moins de 30 minutes — un ENVOI encore dans sa fenêtre
 *     (rien ne part : `annulerEffetSortant`) s'il est plus récent, sinon le dernier GESTE de l'assistant (`annulerGeste`,
 *     effet par effet ; un courriel déjà parti est compensé par un rectificatif, et la phrase le dit).
 *   • RÉTABLIR : la dernière annulation (< 30 min) s'annule ; ce qui a bougé depuis est dit, jamais écrasé.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const ANNULATION_MS = 30 * 60_000;

export async function annulerLaDerniere(user: CurrentUser): Promise<{ ok: boolean; message: string }> {
  const recent = (iso: string) => Date.now() - new Date(iso).getTime() < ANNULATION_MS;
  const [gestes, envois] = await Promise.all([gestesDeLAssistant(user, { limite: 5 }), effetsSortantsDe(user, { depuisMinutes: 30 })]);
  const g = gestes.find((x) => !x.annuleLe && recent(x.quand));
  // Un envoi encore en fenêtre, hors geste de l'assistant (son geste l'annule avec lui).
  const e = envois.find((x) => x.statut === "EN_ATTENTE" && recent(x.creeLe) && (!g || !x.gesteId || x.gesteId !== g.id));
  if (e && (!g || new Date(e.creeLe) > new Date(g.quand))) {
    (await import("./operations/envoi-gmail")).enregistrerExecuteurGmail();
    const r = await annulerEffetSortant(e.id, user);
    return { ok: r.ok, message: r.message };
  }
  if (!g) return { ok: false, message: "Il n'y a pas d'action récente de l'assistant à annuler (moins de 30 minutes)." };
  const r = await annulerGeste(g.id, user);
  if ("refus" in r) return { ok: false, message: r.refus };
  return { ok: true, message: `${phraseAnnulation(g.libelle, r.details)} « Rétablis » la refait si vous changez d'avis.` };
}

export async function retablirLaDerniere(user: CurrentUser): Promise<{ ok: boolean; message: string }> {
  const g = (await gestesDeLAssistant(user, { limite: 10 })).find((x) => x.annuleLe && Date.now() - new Date(x.annuleLe).getTime() < ANNULATION_MS);
  if (!g) return { ok: false, message: "Il n'y a pas d'annulation récente à rétablir." };
  const r = await retablirGeste(g.id, user);
  if ("refus" in r) return { ok: false, message: r.refus };
  return { ok: true, message: phraseAnnulation(g.libelle, r.details, true) };
}

/** Les deux outils de l'écrit — `echoues` reçoit ceux qui ont échoué (la garde de vérité ne les compte pas comme faits). */
export function outilsAnnulation(user: CurrentUser, echoues: Set<string>): PowerTool[] {
  const ouvert = (u: CurrentUser) => u.id === user.id && !u.impersonatedBy;
  const outil = (name: string, description: string, label: string, f: (u: CurrentUser) => Promise<{ ok: boolean; message: string }>): PowerTool => ({
    def: { name, description, input_schema: { type: "object", properties: {} } },
    allowed: ouvert,
    label,
    run: async () => {
      const r = await f(user);
      if (!r.ok) echoues.add(name);
      return JSON.stringify({ statut: r.ok ? "FAIT" : "RIEN", message: r.message, consigne: "Dis ce message tel quel, en une phrase." });
    },
  });
  return [
    outil("annuler_ma_derniere_action", "ANNULE TOUT DE SUITE la dernière chose que l'assistant a faite pour la personne (moins de 30 min) : un envoi encore en attente ne part pas ; sinon son dernier geste est défait. À appeler dès qu'elle dit « annule », « défais », « remets comme avant ». Réversible (« rétablis »).", "Action annulée", annulerLaDerniere),
    outil("retablir_ma_derniere_annulation", "RÉTABLIT TOUT DE SUITE la dernière annulation (moins de 30 min) : ce qui avait été défait est refait, sauf ce qui a bougé depuis (dit).", "Annulation rétablie", retablirLaDerniere),
  ];
}
