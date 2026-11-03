import {
  annulerChantier, donnerConsigneChantier, approuverChantier, demanderRevertFusion, ouEnEstChantier, pauserChantier, proposerChantier, validerGesteChantier, type VueChantier,
} from "@/lib/missions/chantiers/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES OUTILS DE CONVERSATION DES CHANTIERS (C1, décision 0042) — une seule définition, offerte à l'Assistant IA
 * (`modules/assistant-ia/infra/chantiers.ts`) ET à Adam (`platform/in-process/chantiers/outils-adam.ts`), au Super Admin seul (le
 * service relit le rôle à chaque geste) :
 *
 *   lancer_un_chantier   Terra (le modèle de la conversation) rédige la consigne technique ; la demande de la Direction
 *                        VAUT approbation du plan — fusion, production et rollback de production restent sous carte ;
 *   ou_en_est_chantier   l'état réel lu de GitHub et Render, coût, rapport (et son document au Drive) ;
 *   valider_chantier     « valide » / « vas-y » / « refuse », SUR LES MOTS de la Direction, écrit ou oral ;
 *   annuler_chantier     annuler, suspendre, ou compenser une fusion par une PR de revert.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const SERVICE = {
  type: "object",
  properties: {
    id: { type: "string", description: "Identifiant Render du service (srv-…)." },
    nom: { type: "string" },
    role: { type: "string", enum: ["erp", "app", "worker"], description: "erp se déploie AVANT app et worker (migrations)." },
    production: { type: "boolean", description: "Vrai : déploiement et rollback sous validation de la Direction." },
    branche: { type: "string", description: "La branche que le service déploie, si ce n'est pas celle du chantier (ex. main → fusion validée d'abord)." },
    url: { type: "string" },
    healthCheckPath: { type: "string" },
  },
  required: ["id", "role"],
};

const json = (o: unknown) => JSON.stringify(o);
const resume = (v: VueChantier) => ({
  chantierId: v.id, titre: v.titre, statut: v.statut, pause: v.pause, depot: v.depot, branche: v.branche,
  coutUsd: v.coutUsd, plafondUsd: v.plafondUsd, etapes: v.etapes.map((e) => `${e.titre} : ${e.statut}${e.attente ? ` (${e.attente})` : ""}${e.erreur ? ` — ${e.erreur}` : ""}`),
  reservations: v.reservations, sessions: v.sessions, pr: v.pr, shaVert: v.vert, deploiements: v.deploiements,
  validationsAttendues: v.validationsAttendues, lancements: v.compteurs.lancements, rapport: v.rapport,
});

/** UN OUTIL DE CHANTIER, sans personne : `run` reçoit l'identifiant de qui l'appelle (le service relit son rôle). */
export interface OutilChantier {
  def: { name: string; description: string; input_schema: Record<string, unknown> };
  label: string;
  run: (entree: Record<string, unknown>, userId: string) => Promise<string>;
}

export const OUTILS_CHANTIER: readonly OutilChantier[] = [
    {
      def: {
        name: "lancer_un_chantier",
        description: "CHANTIER DE DÉVELOPPEMENT (Super Admin) : confie une modification de code à Claude Code, sur SA branche, dans un périmètre de fichiers RÉSERVÉ ; le moteur attend les commits, vérifie les checks CI sur le SHA exact, fait corriger si rouge (borné), déploie sur Render (ERP avant app/worker), vérifie la santé, rollback si malsain, et rend un rapport avec preuves. Production, fusion sur main et rollback de production attendent la validation de la Direction. Rédige toi-même la consigne technique : objectif précis, critères vérifiables, commandes de test.",
        input_schema: {
          type: "object",
          properties: {
            titre: { type: "string" },
            objectif: { type: "string", description: "Ce que le code doit faire, précisément (comportement attendu, cas limites)." },
            depot: { type: "object", properties: { proprietaire: { type: "string" }, nom: { type: "string" } }, required: ["proprietaire", "nom"] },
            branche: { type: "string", description: "Branche du chantier (ex. « claude/sante-api ») — jamais main." },
            brancheBase: { type: "string", description: "Branche de base de la PR (défaut main)." },
            perimetre: { type: "array", items: { type: "string" }, description: "Globs des fichiers que le chantier peut toucher (réservés)." },
            criteres: { type: "array", items: { type: "string" }, description: "Critères d'acceptation vérifiables." },
            commandesVerif: { type: "array", items: { type: "string" }, description: "Commandes de vérification (npm test…)." },
            migrations: { type: "boolean", description: "Le chantier écrit une migration de base." },
            services: { type: "array", items: SERVICE, description: "Services Render à déployer après le vert (vide : pas de déploiement)." },
            dependances: { type: "array", items: { type: "string" }, description: "Chantiers (identifiants) à terminer avant celui-ci." },
            budget: { type: "object", properties: { usd: { type: "number" }, lancements: { type: "number" }, deploiements: { type: "number" }, tentatives: { type: "number" } } },
          },
          required: ["titre", "objectif", "depot", "branche", "perimetre", "criteres"],
        },
      },
      label: "Chantier lancé",
      run: async (entree, userId) => {
        const p = await proposerChantier(userId, entree, { origine: "conversation:chantier" });
        if (!p.ok) return json({ statut: "PLAN_REFUSE", fautes: p.fautes.slice(0, 10), consigne: "Corrige le plan et rappelle l'outil." });
        const a = await approuverChantier(p.chantierId, userId);
        if (!a.ok) return json({ statut: "REFUS", raison: a.erreur });
        return json({
          statut: "DEMARRE", chantierId: p.chantierId, etapes: p.plan.etapes.length, plafondUsd: p.plafondUsd, gestesSousValidation: p.gestesCritiques,
          consigne: "Dis en deux phrases que le chantier tourne en arrière-plan (réservations, puis Claude Code), qu'il est suivi au tableau « Missions », et quels gestes te seront soumis. Ne promets aucun résultat.",
        });
      },
    },
    {
      def: {
        name: "ou_en_est_chantier",
        description: "L'état RÉEL d'un chantier de développement (ou des derniers) : étapes, attente en cours, réservations, sessions Claude Code, PR, SHA vert, déploiements et santé, validations attendues, coût, rapport final.",
        input_schema: { type: "object", properties: { chantierId: { type: "string", description: "Facultatif : les 8 derniers sinon." } } },
      },
      label: "État des chantiers lu",
      run: async (entree, userId) => {
        const vues = await ouEnEstChantier(userId, typeof entree.chantierId === "string" ? entree.chantierId : undefined);
        return json({ chantiers: vues.map(resume), consigne: "Réponds avec les FAITS lus (SHA, statuts, liens) ; n'annonce aucune réussite que le rapport ne prouve pas." });
      },
    },
    {
      def: {
        name: "valider_chantier",
        description: "Donne la décision de la Direction sur un geste critique qu'un chantier ATTEND (fusionner la PR dans la base, déployer en production, rollback de production). N'appelle cet outil QUE si la Direction vient de dire explicitement « valide », « vas-y », « déploie », « fusionne », « accorde » ou « refuse » — jamais de toi-même. En vocal, relis d'abord le geste (« fusionner la PR n° … dans main ») et attends sa réponse.",
        input_schema: {
          type: "object",
          properties: {
            chantierId: { type: "string" },
            decision: { type: "string", enum: ["valide", "refuse"] },
            canal: { type: "string", enum: ["ecrit", "oral"], description: "oral si la Direction l'a dit en conversation vocale." },
            note: { type: "string" },
          },
          required: ["chantierId", "decision"],
        },
      },
      label: "Décision de la Direction transmise",
      run: async (entree, userId) => {
        const r = await validerGesteChantier(String(entree.chantierId ?? ""), userId, {
          decision: entree.decision === "refuse" ? "REFUSEE" : "ACCORDEE",
          canal: entree.canal === "oral" ? "oral" : "ecrit",
          ...(typeof entree.note === "string" ? { note: entree.note } : {}),
        });
        return json(r.ok ? { statut: "TRANSMIS", message: r.message } : { statut: "REFUS", raison: r.erreur });
      },
    },
    {
      def: {
        name: "consigne_chantier",
        description: "Transmet une CONSIGNE de la Direction à un chantier de développement (« dis-lui de … », « change d'approche, fais … », « attends encore », à l'écrit ou à l'oral) : elle part à la MÊME session Claude Code (sinon dans le fil de la PR, sinon à une session neuve avec l'historique), est journalisée, ouvre une nouvelle approche (tentatives remises à zéro) et fait reprendre un chantier en pause « attend tes consignes ». N'appelle cet outil QUE pour une consigne que la Direction vient de donner — jamais de ta propre initiative ; reformule-la fidèlement, sans rien ajouter.",
        input_schema: {
          type: "object",
          properties: {
            chantierId: { type: "string" },
            consigne: { type: "string", description: "La consigne, fidèle à ce que la Direction a dit." },
            canal: { type: "string", enum: ["ecrit", "oral"], description: "oral si la Direction l'a dite en conversation vocale." },
            durable: { type: "boolean", description: "Vrai si elle vaut pour l'avenir (« toujours », « désormais ») : gardée aussi dans la mémoire technique du dépôt." },
          },
          required: ["chantierId", "consigne"],
        },
      },
      label: "Consigne transmise au chantier",
      run: async (entree, userId) => {
        const r = await donnerConsigneChantier(String(entree.chantierId ?? ""), userId, {
          texte: String(entree.consigne ?? ""), canal: entree.canal === "oral" ? "oral" : "ecrit", durable: entree.durable === true,
        });
        return json(r.ok ? { statut: "TRANSMIS", message: r.message } : { statut: "REFUS", raison: r.erreur });
      },
    },
    {
      def: {
        name: "annuler_chantier",
        description: "Arrête (annule : réservations libérées, rapport « annulé ») ou suspend (pause) un chantier de développement, à la demande de la Direction — ou COMPENSE sa fusion (`annulerFusion`) : une PR de revert est ouverte et proposée, jamais un force-push.",
        input_schema: { type: "object", properties: { chantierId: { type: "string" }, pause: { type: "boolean", description: "Vrai : suspendre seulement." }, annulerFusion: { type: "boolean", description: "Vrai : compenser la fusion déjà faite par une PR de revert." } }, required: ["chantierId"] },
      },
      label: "Chantier arrêté",
      run: async (entree, userId) => {
        const id = String(entree.chantierId ?? "");
        const r = entree.annulerFusion === true ? await demanderRevertFusion(id, userId) : entree.pause === true ? await pauserChantier(id, userId) : await annulerChantier(id, userId);
        return json(r.ok ? { statut: "FAIT", message: r.message } : { statut: "REFUS", raison: r.erreur });
      },
    },
];


/** La porte pour les écrans (console, carte de validation) — le module ne passe que par ce fichier. */
export { etatMimo, lireReglagesChantiers, lireReglagesConsole, validerGesteChantier } from "@/lib/missions/chantiers/service";
/** O2 (décision 0059) : les outils des programmes passent par la MÊME porte (aucun couplage neuf du module). */
export { OUTILS_PROGRAMME } from "@/lib/missions/equipe/outils";
