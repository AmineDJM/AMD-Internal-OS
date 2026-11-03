import type { OutilChantier } from "@/lib/missions/chantiers/outils";
import { annulerProgramme, donnerConsigneProgramme, lancerProgramme, ouEnEstProgramme, validerIntegrationProgramme } from "@/lib/missions/equipe/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DE CONVERSATION DES PROGRAMMES (lot O2, décision 0059) — offerts, comme ceux des chantiers, à l'Assistant
 * IA et à Adam, au Super Admin seul (rôle relu par le service à chaque geste) :
 *
 *   lancer_un_programme   « fais faire X, Y et Z par l'équipe » — MiMo décompose (ou Terra donne le plan), le CODE valide,
 *                         les travailleurs partent en parallèle quand c'est sûr ; la demande VAUT approbation du plan ;
 *   ou_en_est_programme   tâches, travailleurs, dépendances, conflits, file d'intégration, coûts par rôle ;
 *   consigne_programme    une consigne de la Direction à une tâche (sa session) ou au programme ;
 *   annuler_programme     tout arrêter, réservations libérées (une intégration faite se compense par un revert).
 * La fusion sur main reste sous carte de la Direction (`valider_chantier` sur la carte de l'intégration).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const json = (o: unknown) => JSON.stringify(o);
const texte = (v: unknown) => (typeof v === "string" ? v : undefined);

export const OUTILS_PROGRAMME: readonly OutilChantier[] = [
  {
    def: {
      name: "lancer_un_programme",
      description: "PROGRAMME DE DÉVELOPPEMENT (Super Admin) : confie un ENSEMBLE de modifications de code à une ÉQUIPE de sessions Claude Code. MiMo le décompose en tâches (graphe de dépendances, périmètres, critères vérifiables), le code VALIDE le plan, les tâches indépendantes partent en parallèle (au plus 3 par défaut), celles qui se recouvrent sont sérialisées ; chaque tâche finie passe par la FILE D'INTÉGRATION (CI complète du résultat fusionné avec la dernière version de la cible) ; la fusion sur main attend la validation de la Direction. Aucun déploiement. Donne `demande` (en clair) et `depot` ; ou `plan` si tu l'as déjà écrit.",
      input_schema: {
        type: "object",
        properties: {
          demande: { type: "string", description: "Ce que la Direction veut, fidèlement (MiMo le décompose)." },
          depot: { type: "object", properties: { proprietaire: { type: "string" }, nom: { type: "string" } }, required: ["proprietaire", "nom"] },
          cible: { type: "string", description: "Branche où le travail s'intègre (défaut main)." },
          plan: { type: "object", description: "Facultatif : le plan déjà écrit { titre, objectif, depot, cible, concurrence, budget, taches: [{ cle, titre, objectif, perimetre, ressources, criteres, commandesVerif, dependances, migrations, taille }] } — il passe le même validateur." },
        },
      },
    },
    label: "Programme lancé",
    run: async (e, userId) => {
      const r = await lancerProgramme(userId, {
        ...(texte(e.demande) ? { demande: texte(e.demande) } : {}), ...(e.plan !== undefined ? { plan: e.plan } : {}),
        ...(e.depot && typeof e.depot === "object" ? { depot: e.depot as { proprietaire: string; nom: string } } : {}), ...(texte(e.cible) ? { cible: texte(e.cible) } : {}),
      }, { origine: "conversation:programme" });
      if (!r.ok) return json({ statut: "PLAN_REFUSE", raison: r.erreur, fautes: r.fautes?.slice(0, 12) ?? [], consigne: "Dis à la Direction ce qui bloque ; si tu peux corriger le plan toi-même, rappelle l'outil avec `plan`." });
      const [v] = await ouEnEstProgramme(userId, r.programmeId);
      return json({
        statut: "DEMARRE", programmeId: r.programmeId, taches: v?.taches.map((t) => ({ cle: t.cle, titre: t.titre, dependances: t.dependances })) ?? [], conflitsSerialises: v?.conflits ?? [],
        consigne: "Dis en deux phrases que l'équipe travaille en arrière-plan (combien de tâches, lesquelles en parallèle), que c'est suivi au tableau « Missions d'Adam », et que la fusion sur main te sera soumise. Ne promets aucun résultat.",
      });
    },
  },
  {
    def: {
      name: "ou_en_est_programme",
      description: "L'état RÉEL d'un programme de développement (ou des derniers) : chaque tâche (en attente et pourquoi, lancée, en file d'intégration, renvoyée à son travailleur, intégrée), ses dépendances, les recouvrements sérialisés, la file d'intégration, les coûts (superviseur MiMo/Sol, travailleurs, infra).",
      input_schema: { type: "object", properties: { programmeId: { type: "string", description: "Facultatif : les derniers sinon." } } },
    },
    label: "État des programmes lu",
    run: async (e, userId) => json({ programmes: await ouEnEstProgramme(userId, texte(e.programmeId)), consigne: "Réponds avec les FAITS lus ; n'annonce aucune intégration que la file ne montre pas FUSIONNEE." }),
  },
  {
    def: {
      name: "consigne_programme",
      description: "Transmet une CONSIGNE de la Direction à un programme : à une tâche précise (`tache` : elle part à la MÊME session Claude Code) ou au programme entier (gardée, utilisée à la prochaine replanification ; un programme en pause « attend tes consignes » reprend). N'appelle cet outil QUE pour une consigne que la Direction vient de donner.",
      input_schema: { type: "object", properties: { programmeId: { type: "string" }, consigne: { type: "string" }, tache: { type: "string" }, canal: { type: "string", enum: ["ecrit", "oral"] } }, required: ["programmeId", "consigne"] },
    },
    label: "Consigne transmise au programme",
    run: async (e, userId) => {
      const r = await donnerConsigneProgramme(String(e.programmeId ?? ""), userId, { texte: String(e.consigne ?? ""), ...(texte(e.tache) ? { tache: texte(e.tache) } : {}), canal: e.canal === "oral" ? "oral" : "ecrit" });
      return json(r.ok ? { statut: "TRANSMIS", message: r.message } : { statut: "REFUS", raison: r.erreur });
    },
  },
  {
    def: {
      name: "valider_programme",
      description: "Donne la décision de la Direction sur l'INTÉGRATION qu'un programme attend dans une branche protégée (main) : la CI est verte sur le résultat intégré avec la dernière version de main. N'appelle cet outil QUE si la Direction vient de dire explicitement « valide », « vas-y », « fusionne » ou « refuse » — jamais de toi-même. En vocal, relis d'abord le geste (« intégrer la tâche … dans main ») et attends sa réponse.",
      input_schema: { type: "object", properties: { programmeId: { type: "string" }, decision: { type: "string", enum: ["valide", "refuse"] }, canal: { type: "string", enum: ["ecrit", "oral"] } }, required: ["programmeId", "decision"] },
    },
    label: "Décision de la Direction transmise",
    run: async (e, userId) => {
      const r = await validerIntegrationProgramme(String(e.programmeId ?? ""), userId, e.decision === "refuse" ? "REFUSEE" : "ACCORDEE", e.canal === "oral" ? "oral" : "ecrit");
      return json(r.ok ? { statut: "TRANSMIS", message: r.message } : { statut: "REFUS", raison: r.erreur });
    },
  },
  {
    def: {
      name: "annuler_programme",
      description: "Arrête un programme de développement à la demande de la Direction : chantiers annulés, file d'intégration vidée, réservations libérées. Ce qui est déjà intégré reste (compensable par une PR de revert).",
      input_schema: { type: "object", properties: { programmeId: { type: "string" } }, required: ["programmeId"] },
    },
    label: "Programme arrêté",
    run: async (e, userId) => {
      const r = await annulerProgramme(String(e.programmeId ?? ""), userId);
      return json(r.ok ? { statut: "FAIT", message: r.message } : { statut: "REFUS", raison: r.erreur });
    },
  },
];
