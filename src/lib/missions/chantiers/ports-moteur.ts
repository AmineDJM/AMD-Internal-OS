/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CONTRAT INTERNE DU MOTEUR DES CHANTIERS (lot C1, décision 0042) — types seuls, zéro import.
 *
 * Ce que les étapes (`etapes.ts`) attendent de Claude Code, de la forge et de l'hébergeur, dans LEURS termes : une
 * branche et ses fichiers par rapport à la base, des checks verts/rouges avec l'extrait utile, un déploiement suivi,
 * une santé. C'est le texte du contrat posé au lancement des lots C1/C2, gardé tel quel (plus la clé d'idempotence
 * des lancements, la session à reprendre, la fusion au SHA attendu, la PR de revert et le drapeau `incertain`).
 *
 * Les connecteurs RÉELS (lot C2, `src/platform/dev/ports.ts`, plus riches) s'y branchent par une couche
 * d'adaptation pure (`adaptateur-c2.ts`) ; les tests par des doubles en mémoire (`faux-test-outils.ts`). Le moteur ne
 * dépend ainsi ni des détails de GitHub ni de ceux de Render : un connecteur qui change ne touche que l'adaptateur.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
export type Resultat<T> =
  | { ok: true; valeur: T }
  /** `incertain` : la demande a PU partir (délai dépassé) — ne jamais la relancer à l'aveugle. */
  | { ok: false; erreur: string; reessayerApresMs?: number; definitif?: boolean; incertain?: boolean };
export interface RefDepot { proprietaire: string; nom: string }
export interface ConsigneDev { depot: RefDepot; branche: string; brancheBase: string; objectif: string; perimetre: string[]; criteres: string[]; commandesVerif: string[]; contexte?: string; chantierId: string; /** O2 (décision 0059) : le travailleur voulu par le plan d'un programme ; absent = Claude Code cloud. */ moyenVoulu?: "managed-agents" }
/** `ordreId` : l'ordre du relais CLI qui porte ce geste (son issue se relit par `ordre`). */
export interface SessionDev { sessionId: string; url: string; lanceeLe: string; moyen: "routine" | "commentaire-pr" | "relais-cli" | "managed-agents"; ordreId?: string }
/**
 * `cle` : la clé d'idempotence du geste (chantier | étape | tour) — la même clé ne lance jamais deux sessions.
 * `relancer(… sansNouvelleSession)` : JOINDRE la session (même session, sinon fil de la PR) sans jamais en ouvrir une
 * neuve — refus `injoignable` sinon (la question « où en es-tu ? » ne doit pas doubler une session qui travaille).
 * `ordre` : l'issue d'un ordre du relais (une session archivée / introuvable est MORTE : on peut relancer).
 */
export interface AgentDeveloppeur {
  disponible(): Promise<{ ok: boolean; raison?: string; moyens: SessionDev["moyen"][] }>;
  lancer(c: ConsigneDev, cle: string): Promise<Resultat<SessionDev>>;
  relancer(c: ConsigneDev & { probleme: string; pr?: number; session?: string; sansNouvelleSession?: boolean }, cle: string): Promise<Resultat<SessionDev>>;
  ordre?(ordreId: string): Promise<Resultat<{ statut: "EN_ATTENTE" | "EN_COURS" | "FAIT" | "ECHEC" | "INCERTAIN"; erreur: string | null }>>;
  /** O2 : arrêter une session (Managed Agents : `user.interrupt`) ; sur l'abonnement, aucune API — refus dit. */
  arreter?(sessionId: string, moyen?: SessionDev["moyen"]): Promise<Resultat<{ arretee: boolean }>>;
}
export interface EtatBranche { existe: boolean; sha: string | null; commits: { sha: string; message: string; le: string }[]; fichiers: string[] }
export interface EtatChecks { statut: "vert" | "rouge" | "en_cours" | "aucun"; echecs: { nom: string; url: string; extrait: string }[] }
export interface ForgeGit { branche(d: RefDepot, b: string, depuisSha?: string): Promise<Resultat<EtatBranche>>; pr(d: RefDepot, b: string): Promise<Resultat<{ numero: number; url: string; titre?: string; mergeable: boolean | null; etat: "ouverte" | "fusionnee" | "fermee" } | null>>; checks(d: RefDepot, sha: string): Promise<Resultat<EtatChecks>>; commenterPr(d: RefDepot, numero: number, texte: string): Promise<Resultat<{ url: string }>>; ouvrirPr(d: RefDepot, b: string, base: string, titre: string, corps: string): Promise<Resultat<{ numero: number; url: string }>>; fusionnerPr(d: RefDepot, numero: number, shaAttendu: string): Promise<Resultat<{ sha: string }>>; proposerRevert(d: RefDepot, numero: number, titre: string, corps: string): Promise<Resultat<{ numero: number; url: string }>>; fichier(d: RefDepot, sha: string, chemin: string): Promise<Resultat<{ octets: Buffer; mime: string }>>; }
export interface DeploiementRender { id: string; statut: string; commit: string | null; le: string }
export interface Hebergeur { services(): Promise<Resultat<{ id: string; nom: string; type: string; url: string | null; branche: string | null; autoDeploy: boolean; healthCheckPath: string | null }[]>>; deployer(serviceId: string, commitSha?: string): Promise<Resultat<DeploiementRender>>; deploiement(serviceId: string, id: string): Promise<Resultat<DeploiementRender>>; deploiements(serviceId: string, n: number): Promise<Resultat<DeploiementRender[]>>; annuler(serviceId: string, id: string): Promise<Resultat<DeploiementRender>>; rollback(serviceId: string, deployId: string): Promise<Resultat<DeploiementRender>>; autoDeploy(serviceId: string, actif: boolean): Promise<Resultat<{ autoDeploy: boolean }>>; logs(serviceId: string, depuis: string, filtre?: { niveau?: string; texte?: string; limite?: number }): Promise<Resultat<{ le: string; niveau: string; message: string }[]>>; variablesNoms(serviceId: string): Promise<Resultat<string[]>>; sante(url: string, chemin: string): Promise<Resultat<{ statut: number; ms: number }>>; }
