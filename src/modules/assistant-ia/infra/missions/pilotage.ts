import type { CurrentUser } from "@/lib/session";
import type { PowerTool } from "@/platform/ia/outil";
import { arreterTravail, pauserTravail, PERSONA_ASSISTANT_IA, renommerTravail, reprendreMonTravail, tableauDesTravaux, travauxAFaireAvancer, type MissionTableau } from "../travaux";
import {
  designerMission, diagnostiquerMission, phraseDernierBalayage, silenceDesExecutants, type Diagnostic, type EtatDesExecutants,
} from "../../domaine/missions/pilotage";
import { LIBELLE_MISSION } from "../../domaine/sous-missions";
import { etatDesExecutants } from "./executants";
import { sansBloquer } from "@/lib/journal";
import { lienDeMission, projeterMission } from "../../domaine/observation/projecteurs";
import { dureeLisible, type Observation } from "../../domaine/observation/contrat";

export { etatDesExecutants };

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * PILOTER SES MISSIONS (lot P1, décision 0047) — la même porte pour l'ÉCRIT (outils `mes_missions`, `piloter_mission`,
 * carte `fusionner_missions`) et l'ORAL (`voix/oral.ts commandeMission`) : lire ses missions réelles avec ce qui les
 * bloque, les mettre en pause, les reprendre, les arrêter (réversible), les renommer. Le cloisonnement est celui du
 * moteur (`principalId` dans chaque `where`) : une mission d'un autre ne se voit ni ne se touche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface MissionLue {
  id: string;
  titre: string;
  objectif: string;
  etat: string;
  libelle: string;
  etapes: { faites: number; total: number; enEchec: number };
  coutUsd: number;
  plafondUsd: number | null;
  diagnostic: Diagnostic;
  parentId: string | null;
  majLe: string;
}

const VIVANTS = new Set(["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "BUDGET_HOLD", "EN_PAUSE", "BLOQUE"]);

/** Pourquoi le balayage ne prendra pas une mission vivante (quand la requête du moteur ne la rend pas). */
export function raisonNonCandidate(m: Pick<MissionTableau, "etat" | "attente">): string {
  if (m.etat === "A_APPROUVER") return "le plan attend ton approbation";
  if (m.etat === "EN_ATTENTE") return m.attente ?? "elle attend un événement ou une réponse, aucune étape n'est prête";
  if (m.etat === "EN_PAUSE" || m.etat === "ARRETE") return "elle est en pause";
  return "aucune étape n'est prête à partir (dépendances non satisfaites)";
}

/** Les missions de la personne que le PROCHAIN passage du balayage prendrait — la requête même du moteur. */
export async function candidatesAuBalayage(userId: string): Promise<Set<string> | undefined> {
  const prises = await travauxAFaireAvancer(100, [userId]).catch(sansBloquer("missions.candidates", null));
  return prises ? new Set(prises.map((p) => p.id)) : undefined;
}

/** Le diagnostic d'une mission du tableau, candidature comprise — la même phrase pour le chat, l'écran et la carte. */
export function diagnosticDuTableau(m: MissionTableau, ex: EtatDesExecutants, maintenant: number, candidates?: ReadonlySet<string>): Diagnostic {
  return diagnostiquerMission({
    etat: m.etat, motifPause: m.motifPause, attente: m.attente, etapes: m.etapes, majLe: m.majLe,
    ...(candidates ? { candidate: candidates.has(m.id), raisonNonCandidate: candidates.has(m.id) ? null : raisonNonCandidate(m) } : {}),
  }, ex, maintenant);
}

export function lireMission(m: MissionTableau, ex: EtatDesExecutants, maintenant: number, candidates?: ReadonlySet<string>): MissionLue {
  return {
    id: m.id, titre: m.titre, objectif: m.objectif, etat: m.etat, libelle: LIBELLE_MISSION[m.etat] ?? m.etat,
    etapes: { faites: m.avancement.faites, total: m.avancement.total, enEchec: m.avancement.enEchec },
    coutUsd: m.coutUsd, plafondUsd: m.plafondUsd, parentId: m.parentId, majLe: m.majLe,
    diagnostic: diagnosticDuTableau(m, ex, maintenant, candidates),
  };
}

/** LES MISSIONS DE LA PERSONNE, lues — les vivantes d'abord ; `toutes` : avec les finies et arrêtées des 3 derniers jours. */
export async function mesMissions(userId: string, opts: { toutes?: boolean; maintenant?: Date } = {}): Promise<{ missions: MissionLue[]; executants: EtatDesExecutants; alerte: string | null; tableau: MissionTableau[]; candidates?: Set<string> }> {
  const maintenant = opts.maintenant ?? new Date();
  const [tableau, executants, candidates] = await Promise.all([tableauDesTravaux(userId, maintenant), etatDesExecutants(), candidatesAuBalayage(userId)]);
  const lues = tableau.map((m) => lireMission(m, executants, maintenant.getTime(), candidates));
  const missions = opts.toutes ? lues : lues.filter((m) => VIVANTS.has(m.etat));
  const enAttente = lues.some((m) => m.diagnostic.code === "ATTENTE_EXECUTANT");
  const silence = silenceDesExecutants(executants, maintenant.getTime());
  return { missions, executants, tableau, candidates, alerte: enAttente && silence ? `Les missions n'avancent pas : ${silence}. ${executants.raisonIgnore && !/worker/i.test(executants.raisonIgnore) ? "Rétablir le balayage des travaux (retirer TRAVAUX_SWEEP=off des variables du service)." : "Vérifier que le service worker tourne (Render › amd-worker, TACHES_DE_FOND=les-deux) ou que le web de l'ERP bat."}` : null };
}

/**
 * LA MISSION OBSERVÉE (lot I1, décision 0063) — le projecteur « mission » du contrat Observation, nourri de la lecture du
 * moteur : la même pour `mes_missions`, la re-projection de l'historique et la vue de mission de P1. Simple et stable.
 */
export function observationDeMission(m: MissionLue, maintenant: Date = new Date()): Observation {
  return projeterMission({ id: m.id, titre: m.titre, etat: m.etat, libelle: m.libelle, etapes: m.etapes, majLe: m.majLe, diagnostic: m.diagnostic.phrase }, maintenant);
}

export type ActionMission = "pause" | "reprendre" | "arreter" | "renommer";

const CIBLES: Record<ActionMission, readonly string[]> = {
  pause: ["EN_COURS", "EN_ATTENTE"],
  reprendre: ["EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ARRETE", "ECHEC"],
  arreter: ["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ECHEC"],
  renommer: ["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ARRETE", "TERMINE", "ECHEC"],
};
const QUOI: Record<ActionMission, string> = { pause: "à mettre en pause", reprendre: "à reprendre", arreter: "à arrêter", renommer: "à renommer" };

export type ResultatPilotage =
  | { ok: true; message: string; mission: { id: string; titre: string } }
  | { ok: false; erreur: string; candidates?: { id: string; titre: string; etat: string }[]; ambigu?: boolean };

/**
 * PILOTER UNE MISSION — par identifiant ou par nom. Ambigu : la réponse NOMME les candidates (le modèle choisit ou cite
 * leurs titres) ; aucune : elle dit lesquelles existent. Jamais « donnez-moi le titre ».
 */
export async function piloterMission(user: CurrentUser, d: { action: ActionMission; mission: string; titre?: string | null }): Promise<ResultatPilotage> {
  const tableau = await tableauDesTravaux(user.id);
  const candidats = tableau.filter((m) => CIBLES[d.action].includes(m.etat));
  const resume = (xs: readonly MissionTableau[]) => xs.slice(0, 8).map((m) => ({ id: m.id, titre: m.titre, etat: LIBELLE_MISSION[m.etat] ?? m.etat }));
  if (!candidats.length) return { ok: false, erreur: `Aucune mission ${QUOI[d.action]}.`, candidates: resume(tableau) };
  const { vises, ambigu } = designerMission(candidats, d.mission ?? "");
  if (!vises.length) return { ok: false, erreur: `Aucune mission ${QUOI[d.action]} ne correspond à « ${d.mission} ».`, candidates: resume(candidats) };
  if (ambigu) return { ok: false, ambigu: true, erreur: `${vises.length} missions ${QUOI[d.action]} correspondent : ${vises.slice(0, 4).map((m) => `« ${m.titre} »`).join(", ")}.`, candidates: resume(vises) };
  const m = vises[0]!;
  const r = d.action === "pause" ? await pauserTravail(m.id, user.id)
    : d.action === "reprendre" ? await reprendreMonTravail(m.id, user.id, PERSONA_ASSISTANT_IA)
      : d.action === "arreter" ? await arreterTravail(m.id, user.id)
        : await renommerTravail(m.id, user.id, String(d.titre ?? ""));
  if (!r.ok) return { ok: false, erreur: r.erreur };
  const fait = d.action === "pause" ? "Mise en pause" : d.action === "reprendre" ? "Reprise" : d.action === "arreter" ? "Arrêtée (« reprendre » la relance)" : "Renommée";
  return { ok: true, message: `${fait} : la mission « ${m.titre} ». ${r.message}`.trim(), mission: { id: m.id, titre: d.action === "renommer" ? String(d.titre ?? "").trim() : m.titre } };
}

const json = (o: unknown) => JSON.stringify(o);

/**
 * LES OUTILS DE L'ÉCRIT. Un pilotage refusé le dit par son statut (REFUS, AMBIGU) : le journal du tour ne le compte pas
 * comme une preuve (`infra/observation/journal.ts`).
 */
export function outilsMissions(user: CurrentUser): PowerTool[] {
  const ouvert = (u: CurrentUser) => u.id === user.id;
  return [
    {
      def: {
        name: "mes_missions",
        description: "LIS tes missions (tâches de fond) RÉELLES de la personne : titre, identifiant, état, étapes faites/total, coût, ce qui la bloque (en attente du worker, approbation, plafond, étape en échec), si le prochain balayage la prendra (et sinon pourquoi), son étape suivante, et le dernier balayage. À appeler AVANT de parler d'une mission, de dire qu'elle avance, de la fusionner ou de la piloter — jamais demander un titre à la personne.",
        input_schema: { type: "object", properties: { toutes: { type: "boolean", description: "Inclure les missions finies ou arrêtées des 3 derniers jours." } } },
      },
      allowed: ouvert,
      label: "Missions lues",
      run: async (e) => {
        const maintenant = new Date();
        const r = await mesMissions(user.id, { toutes: e.toutes === true, maintenant });
        const parId = new Map(r.tableau.map((t) => [t.id, t]));
        // I1 (étape 3) : des faits datés et un LIEN par mission ; P1 ter : l'observation du moteur (le balayage la prendra-t-il).
        return json({
          missions: r.missions.map((m) => ({
            id: m.id, titre: m.titre, lien: lienDeMission(m.id), etat: m.libelle, etapes: `${m.etapes.faites}/${m.etapes.total}`, coutUsd: m.coutUsd,
            ou_elle_en_est: m.diagnostic.phrase, derniere_activite: `il y a ${dureeLisible(Math.max(0, maintenant.getTime() - Date.parse(m.majLe)))}`,
            pris_par_le_balayage: !r.candidates ? "non vérifié" : r.candidates.has(m.id) ? "oui" : `non — ${m.diagnostic.phrase.replace(/^pas prise par le balayage des travaux : /, "")}`,
            etape_suivante: parId.get(m.id)?.etapes.find((x) => x.etat !== "FAITE" && x.etat !== "ECARTEE")?.titre ?? "aucune (toutes faites)",
            ...(m.parentId ? { sous_mission_de: m.parentId } : {}),
          })),
          dernier_balayage: phraseDernierBalayage(r.executants, maintenant.getTime()),
          total: r.missions.length,
          ...(r.alerte ? { alerte: r.alerte } : {}),
          _observations: r.missions.map((m) => observationDeMission(m, maintenant)),
        });
      },
    },
    {
      def: {
        name: "piloter_mission",
        description: "PILOTE une mission de la personne : pause, reprendre, arreter (réversible : « reprendre » la relance), renommer. Désigne-la par son identifiant (lu par mes_missions) ou par son nom. Exécuté tout de suite (réversible).",
        input_schema: {
          type: "object",
          properties: {
            action: { type: "string", enum: ["pause", "reprendre", "arreter", "renommer"] },
            mission: { type: "string", description: "Identifiant de la mission (de préférence) ou mots de son titre." },
            titre: { type: "string", description: "Le nouveau titre (action renommer)." },
          },
          required: ["action", "mission"],
        },
      },
      allowed: ouvert,
      label: "Mission pilotée",
      run: async (e) => {
        const action = String(e.action ?? "") as ActionMission;
        if (!(action in CIBLES)) return json({ statut: "REFUS", raison: "Action inconnue (pause, reprendre, arreter, renommer)." });
        const r = await piloterMission(user, { action, mission: String(e.mission ?? ""), titre: typeof e.titre === "string" ? e.titre : null });
        if (!r.ok) {
          return json({ statut: r.ambigu ? "AMBIGU" : "REFUS", raison: r.erreur, ...(r.candidates ? { missions: r.candidates } : {}), ...(r.ambigu ? {} : { fait: "rien" }) });
        }
        return json({ statut: "FAIT", message: r.message, mission: r.mission });
      },
    },
  ];
}
