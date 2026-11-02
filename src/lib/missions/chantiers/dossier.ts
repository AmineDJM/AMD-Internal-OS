import type { PlanChantier } from "@/lib/missions/chantiers/plan";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE DOSSIER D'UN CHANTIER (lot C1, décision 0042) — pur. Il vit dans `Mission.carnet` (`{ chantier: … }`) : le
 * plan approuvé, les sessions Claude Code lancées, la PR, les signatures d'échec, les compteurs, les validations de
 * la Direction et les PREUVES. Chaque étape le relit au lieu de l'historique ; le tableau « Missions » l'affiche.
 *
 * LA RÈGLE DE FIN : aucune réussite n'est annoncée sans sa preuve. `jugerPreuves` est le juge du moteur (`conclure`) :
 * checks VERTS sur le SHA exact livré, chaque déploiement prévu LIVE sur ce SHA et SAIN (ou un rollback dit), coût
 * connu. Il refuse — et le chantier finit BLOQUÉ, pas TERMINÉ — dès qu'une preuve manque.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface SessionLancee { sessionId: string; url: string; le: string; moyen: string; motif: "lancement" | "correction" | "reprise" }

export interface PreuveDeploiement {
  service: string;
  nom: string;
  deployId: string;
  commit: string | null;
  statut: string;
  le: string;
  sante?: { statut: number; ms: number; le: string } | null;
  sain?: boolean;
  rollback?: { deployId: string; statut: string; le: string } | null;
}

export interface ValidationDirection { decision: "ACCORDEE" | "REFUSEE"; par: string; le: string; canal: "ecrit" | "oral"; note?: string }

export interface DossierChantier {
  plan: PlanChantier;
  sessions: SessionLancee[];
  pr: { numero: number; url: string } | null;
  /** Le SHA de tête vu au dernier contrôle, et le dernier SHA VERT (checks verts sur ce SHA exact). */
  shaVu: string | null;
  vert: { sha: string; le: string } | null;
  signatures: string[];
  solPour: string[];
  compteurs: { lancements: number; deploiements: number; appelsModeles: Record<string, number> };
  validations: Record<string, ValidationDirection>;
  deploiements: PreuveDeploiement[];
  reservations: string[];
  blocage: string | null;
  /** La fusion VALIDÉE de la PR dans la base : le commit de fusion, vérifié vert (CI de la base). */
  fusion: { sha: string; pr: number; base: string; le: string } | null;
  /** La compensation d'une fusion : demandée (annulation J7, outil, écran), puis la PR de revert proposée. */
  revertDemande: { par: string; le: string } | null;
  revert: { numero: number; url: string; le: string } | null;
  rapport: { le: string; texte: string; issue: "LIVRE" | "BLOQUE" | "ANNULE" | "PARTIEL"; document?: { nodeId: string; nom: string; lien: string } | null } | null;
}

export function dossierInitial(plan: PlanChantier): DossierChantier {
  return {
    plan, sessions: [], pr: null, shaVu: null, vert: null, signatures: [], solPour: [],
    compteurs: { lancements: 0, deploiements: 0, appelsModeles: {} }, validations: {}, deploiements: [], reservations: [],
    blocage: null, fusion: null, revertDemande: null, revert: null, rapport: null,
  };
}

/**
 * LA VRAIE SESSION D'UN ORDRE DU RELAIS (C2, décision 0043 § 3 bis) : à l'enfilement, le dossier ne connaît que
 * `ordre-<id>` ; le fait `DEV_SESSION` apporte l'identifiant `session_…` et son lien. Rend VRAI si le dossier a changé.
 * Idempotent (un second passage du même fait ne change rien), pur.
 */
export function adopterSessionDuRelais(d: DossierChantier, ordreId: string, sessionId: string, url: string | null): boolean {
  const i = d.sessions.findIndex((x) => x.sessionId === `ordre-${ordreId}`);
  if (i < 0 || !/^(session|cse)_[A-Za-z0-9]+$/.test(sessionId)) return false;
  d.sessions[i] = { ...d.sessions[i]!, sessionId, url: url || d.sessions[i]!.url };
  return true;
}

/** Le dossier lu d'un carnet — `null` si ce n'est pas celui d'un chantier. Tolérant : un champ absent prend son défaut. */
export function lireDossier(carnet: unknown): DossierChantier | null {
  const c = carnet && typeof carnet === "object" ? (carnet as { chantier?: unknown }).chantier : null;
  if (!c || typeof c !== "object" || !(c as DossierChantier).plan) return null;
  const d = c as Partial<DossierChantier> & { plan: PlanChantier };
  const base = dossierInitial(d.plan);
  return { ...base, ...d, compteurs: { ...base.compteurs, ...(d.compteurs ?? {}) } };
}

export interface VerdictPreuves { satisfait: boolean; raison: string; manquantes: string[] }

/** LE JUGE DES PREUVES — déterministe : il ne lit que ce que GitHub et Render ont RENDU. */
export function jugerPreuves(d: DossierChantier, coutUsd: number | null): VerdictPreuves {
  const manquantes: string[] = [];
  if (!d.vert) manquantes.push("aucun SHA aux checks verts");
  else if (d.shaVu && d.shaVu !== d.vert.sha) manquantes.push(`le SHA de tête (${court(d.shaVu)}) n'est pas celui vérifié (${court(d.vert.sha)})`);
  if (d.plan.etapes.some((e) => e.type === "DEV_FUSIONNER") && !d.fusion) manquantes.push("la PR n'est pas fusionnée dans la base (validation refusée ou en attente)");
  const prevus = d.plan.etapes.filter((e) => e.type === "RENDER_DEPLOYER").map((e) => e.service!);
  for (const id of prevus) {
    const p = [...d.deploiements].reverse().find((x) => x.service === id);
    if (!p) { manquantes.push(`${id} : aucun déploiement`); continue; }
    if (p.rollback) { manquantes.push(`${p.nom} : déploiement malsain, rollback ${p.rollback.statut}`); continue; }
    if (p.statut !== "live") manquantes.push(`${p.nom} : déploiement ${p.statut}, pas live`);
    // Après une fusion, le SHA vert est celui de la branche d'intégration, REVÉRIFIÉ (chantiers fusionnés ensemble).
    if (d.vert && p.commit && p.commit !== d.vert.sha) {
      manquantes.push(`${p.nom} : déployé ${court(p.commit)}, vérifié ${court(d.vert.sha)}`);
    }
    if (!p.sain) manquantes.push(`${p.nom} : santé non démontrée`);
  }
  if (coutUsd === null) manquantes.push("coût réel inconnu");
  if (d.blocage) manquantes.push(`blocage : ${d.blocage}`);
  return manquantes.length === 0
    ? { satisfait: true, manquantes, raison: `Preuves réunies : checks verts sur ${court(d.vert!.sha)}${prevus.length ? `, ${prevus.length} déploiement(s) live et sain(s)` : ""}.` }
    : { satisfait: false, manquantes, raison: `Conclusion refusée faute de preuves : ${manquantes.join(" ; ")}.` };
}

export const court = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : "—");

/** CE QUE L'ÉCRAN ET LA CONVERSATION MONTRENT d'un dossier — une seule forme, pour le tableau « Missions » et « où en est ». */
export interface VueDossier {
  depot: string;
  branche: string;
  reservations: string[];
  sessions: { url: string; motif: string }[];
  pr: { numero: number; url: string } | null;
  vert: string | null;
  deploiements: { nom: string; statut: string; commit: string; sain: boolean | null; rollback: boolean }[];
}

export function vueDossier(d: DossierChantier, reservations: readonly string[]): VueDossier {
  return {
    depot: `${d.plan.depot.proprietaire}/${d.plan.depot.nom}`, branche: d.plan.branche, reservations: [...reservations],
    sessions: d.sessions.map((s) => ({ url: s.url, motif: s.motif })), pr: d.pr, vert: d.vert ? court(d.vert.sha) : null,
    deploiements: d.deploiements.map((x) => ({ nom: x.nom, statut: x.statut, commit: court(x.commit), sain: x.sain ?? null, rollback: !!x.rollback })),
  };
}

const fmtUsd = (n: number) => `${n.toFixed(4).replace(".", ",")} $`;

/** LE RAPPORT FINAL — composé par le CODE depuis le dossier (pas de modèle) : SHA, checks, live, santé, coût, liens. */
export function composerRapport(d: DossierChantier, coutUsd: number, issue: NonNullable<DossierChantier["rapport"]>["issue"]): string {
  const p = d.plan;
  const lignes = [
    `Chantier « ${p.titre} » — ${issue === "LIVRE" ? "livré et vérifié" : issue === "ANNULE" ? "annulé" : issue === "PARTIEL" ? "terminé en partie" : "bloqué"}.`,
    `Dépôt ${p.depot.proprietaire}/${p.depot.nom}, branche ${p.branche} (base ${p.brancheBase}).`,
    d.vert ? `Checks verts sur ${d.vert.sha} (${d.vert.le}).` : "Aucun SHA aux checks verts.",
    d.pr ? `PR #${d.pr.numero} : ${d.pr.url}` : "Pas de PR.",
    ...(d.fusion ? [`Fusionnée dans ${d.fusion.base} : ${d.fusion.sha} (CI de la base verte).`] : []),
    ...(d.revert ? [`Fusion compensée : PR de revert #${d.revert.numero} proposée (${d.revert.url}).`] : []),
    ...d.sessions.map((s) => `Session Claude Code (${s.motif}) : ${s.url}`),
    ...d.deploiements.map((x) =>
      `${x.nom} : déploiement ${x.deployId} ${x.statut} sur ${court(x.commit)}${x.sante ? `, santé HTTP ${x.sante.statut} en ${x.sante.ms} ms` : ""}${x.rollback ? `, rollback ${x.rollback.deployId} ${x.rollback.statut}` : ""}.`),
    `Coût réel des modèles : ${fmtUsd(coutUsd)} ; ${d.compteurs.lancements} lancement(s) Claude Code, ${d.compteurs.deploiements} déploiement(s).`,
    ...(d.blocage ? [`Blocage : ${d.blocage}`] : []),
  ];
  return lignes.join("\n");
}
