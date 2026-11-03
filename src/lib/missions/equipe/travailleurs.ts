import type { AgentDeveloppeur, ConsigneDev, Resultat, SessionDev } from "@/lib/missions/chantiers/ports-moteur";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PORT « TRAVAILLEUR » (lot O2, décision 0059 § 2) — lancer, envoyer un message à la MÊME session, lire l'état,
 * arrêter ; idempotent par clé (celle des reçus des chantiers).
 *
 * UN SEUL ADAPTATEUR, par décision de la Direction (02/11 et 03/11 : « Abonnement, garde les sessions cloud
 * seulement ») : les sessions cloud Claude Code de l'agent des chantiers — Routines, relais `claude --cloud` /
 * `claude -p --cloud <id>`, commentaire `@claude` (lot C2). Aucune API facturée à l'usage (Managed Agents, Agent SDK) :
 * écartées. Sur l'abonnement, rien ne lit l'état d'une session ni ne l'arrête : c'est DIT, et GitHub fait foi (commits,
 * checks). Ce qui se compte : les sessions lancées (quotas des Routines), leur durée, les tentatives — pas des dollars.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface Travailleur {
  moyen: SessionDev["moyen"];
  lancer(c: ConsigneDev, cle: string): Promise<Resultat<SessionDev>>;
  /** À la MÊME session si on la connaît (relais), sinon le fil de la PR ou une reprise de la branche (travail gardé). */
  envoyer(c: ConsigneDev, session: string | null, texte: string, cle: string): Promise<Resultat<SessionDev>>;
  etat(sessionId: string): Promise<Resultat<{ statut: "travaille" | "attend" | "fini" | "mort" }>>;
  arreter(sessionId: string): Promise<Resultat<{ arretee: boolean }>>;
}

const refus = (erreur: string): Resultat<never> => ({ ok: false, erreur, definitif: true });

/** Les sessions cloud Claude Code, par l'agent des chantiers (C2). */
export function travailleurCloud(agent: AgentDeveloppeur): Travailleur {
  return {
    moyen: "routine",
    lancer: (c, cle) => agent.lancer(c, cle),
    envoyer: (c, session, texte, cle) => agent.relancer({ ...c, probleme: texte, ...(session ? { session, sansNouvelleSession: true } : {}) }, cle),
    etat: async () => refus("sessions cloud : l'état d'une session ne se lit pas sur l'abonnement — GitHub fait foi (commits, checks)"),
    arreter: async () => refus("sessions cloud : aucune API n'arrête une session ; elle peut finir son tour, rien ne sera intégré ni déployé"),
  };
}
