import type { WorkspaceAction, WorkspaceBlock } from "@/platform/ia/workspace/protocol";
import type { Observation } from "../observation/contrat";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * UNE MISSION LISIBLE ET CLIQUABLE (lot P1 ter, décision 0066) — Direction, 03/11 : « y'a quoi dedans, elles ne sont pas
 * cliquables » ; Adam : « la lecture ne fournit pas le contenu détaillé de leurs étapes ». Règles PURES.
 *
 *   • LE CONTENU : objectif, étapes (titre, état, résultat court ou erreur lisible, quand), jalons (titre, résultat
 *     constatable, état), livrables, dernière activité, coût, lien — BORNÉ : au plus `ETAPES_MAX` étapes par mission
 *     (les échecs et l'étape en cours d'abord, puis la suite ; le reste est COMPTÉ, jamais tu) ;
 *   • LE BLOC : la mission en carte (`kind: "mission"` du protocole) — posé par le SERVEUR à partir de l'OBSERVATION de
 *     la mission (contrat I1 : identité, état, lien, diagnostic — la même que relit l'historique) et de son contenu lu
 *     (`vueMission`) : étapes, jalons, « Ouvrir » vers le lien observé, gestes utiles selon l'état observé (pause,
 *     reprendre, arrêter — réversibles, par `piloter_mission`). Aucun chemin à part pour l'état d'une mission.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const ETAPES_MAX = 8;
export const JALONS_MAX = 8;
export const LIVRABLES_MAX = 5;
/** Au-delà, les missions sont COMPTÉES (« et 3 autres ») — une réponse n'est pas un tableau de bord complet. */
export const MISSIONS_DETAILLEES_MAX = 6;

export type EtatAffiche = "fait" | "en-cours" | "a-faire" | "echec";

export interface EtapeDetaillee { id: string; label: string; etat: EtatAffiche; detail?: string | null; erreur?: string | null; debut?: string | null; fin?: string | null }
export interface JalonDetaille { ordre: number; titre: string; resultat: string | null; etat: EtatAffiche }
export interface LivrableDetaille { titre: string; fichier: string | null; statut: string; contenu: string | null }

export interface DetailMission {
  etapes: EtapeDetaillee[];
  jalons: JalonDetaille[];
  livrables: LivrableDetaille[];
  derniereActivite: { at: string; texte: string } | null;
}

/** Les gestes valables pour chaque état (le moteur revérifie : un geste hors état est refusé, sans effet). */
export const ETATS_DU_GESTE = {
  pause: ["EN_COURS", "EN_ATTENTE"],
  reprendre: ["EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ARRETE", "ECHEC"],
  arreter: ["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ECHEC"],
  renommer: ["A_APPROUVER", "EN_COURS", "EN_ATTENTE", "EN_PAUSE", "BUDGET_HOLD", "BLOQUE", "ARRETE", "TERMINE", "ECHEC"],
} as const satisfies Record<string, readonly string[]>;

const court = (t: string | null | undefined, n = 160): string | null => {
  const x = (t ?? "").replace(/\s+/g, " ").trim();
  return !x ? null : x.length > n ? `${x.slice(0, n - 1)}…` : x;
};

/**
 * LES ÉTAPES À MONTRER — au plus `max` : celles qui comptent d'abord (échec, en cours), puis les suivantes à faire, puis
 * les dernières faites ; dans l'ORDRE DU PLAN. Le reste est résumé (« 12 faites, 3 à faire non montrées »).
 */
export function etapesBornees(etapes: readonly EtapeDetaillee[], max = ETAPES_MAX): { montrees: EtapeDetaillee[]; resume: string | null } {
  if (etapes.length <= max) return { montrees: [...etapes], resume: null };
  const garder = new Set<number>();
  const prendre = (pred: (e: EtapeDetaillee) => boolean, depuisLaFin = false) => {
    const idx = etapes.map((e, i) => (pred(e) ? i : -1)).filter((i) => i >= 0);
    for (const i of depuisLaFin ? idx.reverse() : idx) { if (garder.size >= max) return; garder.add(i); }
  };
  prendre((e) => e.etat === "echec");
  prendre((e) => e.etat === "en-cours");
  prendre((e) => e.etat === "a-faire");
  prendre((e) => e.etat === "fait", true);
  const montrees = etapes.filter((_, i) => garder.has(i));
  const cachees = etapes.filter((_, i) => !garder.has(i));
  const faites = cachees.filter((e) => e.etat === "fait").length;
  const aFaire = cachees.length - faites;
  const parts = [faites ? `${faites} faite${faites > 1 ? "s" : ""}` : null, aFaire ? `${aFaire} à faire` : null].filter(Boolean);
  return { montrees, resume: `${cachees.length} autre${cachees.length > 1 ? "s" : ""} étape${cachees.length > 1 ? "s" : ""} non montrée${cachees.length > 1 ? "s" : ""} (${parts.join(", ")}) — tout est sur la page de la mission.` };
}

const LIBELLE_ETAT: Record<EtatAffiche, string> = { fait: "faite", "en-cours": "en cours", "a-faire": "à faire", echec: "en échec" };
export const lienMission = (id: string) => `/missions/${encodeURIComponent(id)}`;

/** CE QUE LA MISSION CONTIENT, pour le modèle — borné ; l'état, le lien et le diagnostic sont dans son observation. */
export function contenuDeMission(objectif: string, d: DetailMission | null) {
  if (!d) return { objectif: court(objectif, 280), contenu: "détail illisible pour l'instant (la mission reste ouverte par son lien)" };
  const { montrees, resume } = etapesBornees(d.etapes);
  return {
    objectif: court(objectif, 280),
    etapes: montrees.map((e) => ({
      titre: e.label, etat: LIBELLE_ETAT[e.etat],
      ...(court(e.erreur) ? { erreur: court(e.erreur) } : court(e.detail) ? { resultat: court(e.detail) } : {}),
      ...(e.fin ? { finie_le: e.fin } : e.debut ? { commencee_le: e.debut } : {}),
    })),
    ...(resume ? { etapes_non_montrees: resume } : {}),
    ...(d.jalons.length ? { jalons: d.jalons.slice(0, JALONS_MAX).map((j) => ({ ordre: j.ordre, titre: j.titre, resultat_attendu: court(j.resultat), etat: LIBELLE_ETAT[j.etat] })) } : {}),
    livrables: d.livrables.length
      ? d.livrables.slice(0, LIVRABLES_MAX).map((l) => ({ titre: l.titre, fichier: l.fichier, statut: l.statut, ...(court(l.contenu) ? { contient: court(l.contenu) } : {}) }))
      : "aucun livrable produit pour l'instant",
    ...(d.derniereActivite ? { derniere_action: `${d.derniereActivite.at.slice(0, 16).replace("T", " ")} — ${court(d.derniereActivite.texte, 140)}` } : {}),
  };
}

/** Les gestes de la carte : « Ouvrir » (lien), puis ceux que l'état permet — par la phrase, donc par `piloter_mission`. */
export function gestesDeMission(m: { id: string; titre: string; etat: string; lien?: string | null }): WorkspaceAction[] {
  const nom = `la mission « ${m.titre} » (${m.id})`;
  const a: WorkspaceAction[] = [{ libelle: "Ouvrir", phrase: `Ouvre ${nom}`, href: m.lien ?? lienMission(m.id), icone: "voir" }];
  if ((ETATS_DU_GESTE.pause as readonly string[]).includes(m.etat)) a.push({ libelle: "Pause", phrase: `Mets en pause ${nom}` });
  if ((ETATS_DU_GESTE.reprendre as readonly string[]).includes(m.etat)) a.push({ libelle: "Reprendre", phrase: `Reprends ${nom}`, ton: "primaire" });
  if ((ETATS_DU_GESTE.arreter as readonly string[]).includes(m.etat)) a.push({ libelle: "Arrêter", phrase: `Arrête ${nom} (réversible : « reprendre » la relance)`, ton: "danger" });
  return a;
}

const texte = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);

/**
 * LA CARTE D'UNE MISSION — le bloc `mission` du protocole, posé par le serveur. Son identité, son état, son lien et son
 * diagnostic viennent de l'OBSERVATION (contrat I1) ; ses étapes, jalons et livrables, du contenu lu de la mission.
 */
export function blocDeMission(o: Observation, d: DetailMission | null): Extract<WorkspaceBlock, { kind: "mission" }> {
  const titre = texte(o.projection.titre) ?? o.objet.id;
  const { montrees, resume } = etapesBornees(d?.etapes ?? []);
  const etapes: Extract<WorkspaceBlock, { kind: "mission" }>["etapes"] = montrees.map((e) => ({
    id: e.id, label: e.label, etat: e.etat,
    detail: court(e.detail, 120),
    erreur: court(e.erreur, 160),
  }));
  if (resume) etapes.push({ id: "__resume", label: resume, etat: "ignore" });
  const livrables = (d?.livrables ?? []).slice(0, LIVRABLES_MAX).map((l) => l.fichier ?? l.titre);
  return {
    kind: "mission",
    title: titre,
    subtitle: [texte(o.projection.statut), texte(o.projection.etapes) ? `${o.projection.etapes} étapes` : null, texte(o.projection.diagnostic),
      texte(o.projection.derniereActivite) ? `dernière activité ${o.projection.derniereActivite}` : null,
      livrables.length ? `livrable${livrables.length > 1 ? "s" : ""} : ${livrables.join(", ")}` : null]
      .filter(Boolean).join(" · "),
    etapes,
    ...(d?.jalons.length ? { jalons: d.jalons.slice(0, JALONS_MAX).map((j) => ({ ordre: j.ordre, titre: j.titre, resultat: court(j.resultat), etat: j.etat })) } : {}),
    actions: gestesDeMission({ id: o.objet.id, titre, etat: o.etat, lien: o.objet.lien }),
  };
}
