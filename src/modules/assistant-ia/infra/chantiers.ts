import type { CurrentUser } from "@/lib/session";
import type { OutilTravail } from "@/platform/ia/travaux/outil";
import {
  annulerChantier, approuverChantier, etatMimo, lireReglagesChantiers, lireReglagesConsole, ouEnEstChantier, pauserChantier, proposerChantier,
  validerGesteChantier, type VueChantier,
} from "@/lib/missions/chantiers/service";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES CHANTIERS DANS LA CONVERSATION (lot C1, décision 0041) — « je parle à Adventum IA ; il organise et supervise
 * Claude Code ». Quatre outils, offerts au SUPER ADMIN seul (rôle relu par le service à chaque geste) :
 *
 *   lancer_un_chantier      Terra formule la consigne technique (objectif, dépôt, branche, périmètre, critères) ;
 *                           la demande de la Direction VAUT approbation du plan (autonomie contrôlée) — les gestes
 *                           critiques (production, fusion sur main, rollback de production) restent sous validation ;
 *   ou_en_est_chantier      l'état réel lu de GitHub et Render par le moteur, coût compris ;
 *   valider_chantier        « valide » / « refuse » / « déploie » — SEULEMENT sur les mots explicites de la Direction,
 *                           à l'écrit comme à l'oral ; seule une validation ATTENDUE peut être donnée ;
 *   annuler_chantier        arrêter (annuler) ou suspendre.
 *
 * Le RAPPORT final (SHA, checks verts, statut live, santé, coût) revient par notification et par `ou_en_est_chantier` ;
 * le transmettre par WhatsApp passe par l'outil des canaux (K6) sur demande — ce module n'envoie rien lui-même.
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

export function outilsChantierPour(user: CurrentUser): OutilTravail[] {
  if (user.role !== "SUPER_ADMIN") return [];
  const pourLui = (u: { id: string }) => u.id === user.id;
  const refus = json({ statut: "REFUS", raison: "Cet outil a été préparé pour une autre personne." });
  return [
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
      allowed: pourLui,
      label: "Chantier lancé",
      run: async (entree, u) => {
        if (!pourLui(u)) return refus;
        const p = await proposerChantier(user.id, entree, { origine: "assistant-ia:chantier" });
        if (!p.ok) return json({ statut: "PLAN_REFUSE", fautes: p.fautes.slice(0, 10), consigne: "Corrige le plan et rappelle l'outil." });
        const a = await approuverChantier(p.chantierId, user.id);
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
      allowed: pourLui,
      label: "État des chantiers lu",
      run: async (entree, u) => {
        if (!pourLui(u)) return refus;
        const vues = await ouEnEstChantier(user.id, typeof entree.chantierId === "string" ? entree.chantierId : undefined);
        return json({ chantiers: vues.map(resume), consigne: "Réponds avec les FAITS lus (SHA, statuts, liens) ; n'annonce aucune réussite que le rapport ne prouve pas." });
      },
    },
    {
      def: {
        name: "valider_chantier",
        description: "Donne la décision de la Direction sur un geste critique qu'un chantier ATTEND (déployer en production, fusionner sur main, rollback de production). N'appelle cet outil QUE si la Direction vient de dire explicitement « valide », « déploie », « fusionne », « accorde » ou « refuse » — jamais de toi-même.",
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
      allowed: pourLui,
      label: "Décision de la Direction transmise",
      run: async (entree, u) => {
        if (!pourLui(u)) return refus;
        const r = await validerGesteChantier(String(entree.chantierId ?? ""), user.id, {
          decision: entree.decision === "refuse" ? "REFUSEE" : "ACCORDEE",
          canal: entree.canal === "oral" ? "oral" : "ecrit",
          ...(typeof entree.note === "string" ? { note: entree.note } : {}),
        });
        return json(r.ok ? { statut: "TRANSMIS", message: r.message } : { statut: "REFUS", raison: r.erreur });
      },
    },
    {
      def: {
        name: "annuler_chantier",
        description: "Arrête (annule : réservations libérées, rapport « annulé ») ou suspend (pause) un chantier de développement, à la demande de la Direction.",
        input_schema: { type: "object", properties: { chantierId: { type: "string" }, pause: { type: "boolean", description: "Vrai : suspendre seulement." } }, required: ["chantierId"] },
      },
      allowed: pourLui,
      label: "Chantier arrêté",
      run: async (entree, u) => {
        if (!pourLui(u)) return refus;
        const id = String(entree.chantierId ?? "");
        const r = entree.pause === true ? await pauserChantier(id, user.id) : await annulerChantier(id, user.id);
        return json(r.ok ? { statut: "FAIT", message: r.message } : { statut: "REFUS", raison: r.erreur });
      },
    },
  ];
}

/** Le geste de l'écran « Missions » : valider ou refuser la carte d'un chantier (Super Admin, session). */
export const validerDepuisLeTableau = (chantierId: string, userId: string, accorde: boolean) =>
  validerGesteChantier(chantierId, userId, { decision: accorde ? "ACCORDEE" : "REFUSEE", canal: "ecrit" });

/** Administration › IA › Chantiers : les plafonds en vigueur, et MiMo tel que configuré (jamais la clé). */
export async function etatChantiersPourAdministration() {
  return { reglages: await lireReglagesConsole(), mimo: etatMimo() };
}

/** Les réglages saisis à la console, ramenés dans leurs bornes (l'absent prend le défaut). */
export const normaliserReglagesChantiers = (brut: unknown) => lireReglagesChantiers(brut);
