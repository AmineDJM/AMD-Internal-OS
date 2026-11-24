/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA FILE D'ACTIONS DU SUPERVISEUR — « Mon équipe terrain » (Force de vente › Pilotage, Visite médicale 11/2026).
 *
 * UNE LIGNE = UN FAIT = UN BOUTON. Les faits viennent tous de lectures qui existent déjà (le pilotage, la tournée, le
 * diagnostic d'un panel vide, le coaching, la pharmacovigilance) : ce module ne calcule rien de neuf, il les ORDONNE et
 * les dit en une phrase. En tête, les rapports à relire, les possibles cas de pharmacovigilance d'abord (l'ordre vient
 * de `trierARelire`, appliqué par l'appelant) ; puis ce qui attend une décision, puis ce qui se corrige.
 *
 * Module PUR (un import de type seulement) : les adresses arrivent en fonctions, la date du jour en paramètre.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import type { CausePanelVide } from "@/lib/sfe/panel-diagnostic";

/**
 * LE DIAGNOSTIC D'UN PANEL VIDE, DIT AU SUPERVISEUR — la cause que `diagnosticPanelVide` a trouvée, à la troisième
 * personne et en quelques mots (la phrase complète est écrite pour le délégué : « Votre territoire… »).
 */
export const CAUSE_PANEL_POUR_SUPERVISEUR: Record<CausePanelVide, string> = {
  SANS_BU: "rattaché(e) à aucune Business Unit",
  SECTEUR_AUTRE_BU: "son territoire est dans une autre BU que la sienne",
  SECTEUR_INACTIF: "son secteur est désactivé",
  SANS_SECTEUR: "aucun territoire choisi dans sa BU",
  SECTEUR_SANS_ETABLISSEMENT: "son territoire ne contient aucun établissement",
  PRATICIENS_NON_RATTACHES: "les fiches des médecins de son territoire ne sont pas rattachées à leur établissement (annuaire)",
  SERVICES_SANS_PRATICIEN: "aucun médecin dans les services retenus sur son territoire",
  AUCUN_PRATICIEN: "aucun médecin de l'annuaire dans les établissements de son territoire",
};

export type TonAction = "ko" | "w" | "i";

export interface ActionEquipe {
  cle: string;
  ton: TonAction;
  titre: string;
  sous: string | null;
  /** La citation exacte du compte rendu qu'a relevée l'IA (rapport à relire), affichée en italique. */
  citation?: string | null;
  bouton: { libelle: string; href: string } | null;
}

export interface RapportARelireFile {
  visitId: string;
  date: Date;
  delegue: string;
  praticien: string | null;
  /** AUCUN | POSSIBLE | PROBABLE, ou null (pas encore lu par l'IA). */
  pvIa: string | null;
  raison: string | null;
  extrait: string | null;
}

export interface EntreeFile {
  maintenant: Date;
  aRelire: { total: number; lignes: readonly RapportARelireFile[] };
  plansSoumis: readonly { repId: string; nom: string; planId: string | null; soumisLe: Date | null }[];
  retards: readonly { repId: string; nom: string; rapportsEnRetard: number }[];
  panelsVides: readonly { repId: string; nom: string; buId: string | null; cause: CausePanelVide }[];
  coachings: readonly { repId: string; nom: string; dernier: Date | null }[];
  casPv: { total: number; premierId: string | null };
  /** Ce que « À traiter » du pilotage disait déjà, et qui reste : les cibles H/A oubliées, les secteurs sans délégué. */
  ciblesNonVues?: { total: number; decideurs: number };
  secteursVacants?: readonly { id: string; nom: string; buId: string; cibles: number; enA: number }[];
  liens: {
    relire: (visitId: string) => string;
    plan: (planId: string | null) => string;
    /** null : la personne ne lit pas la liste des rapports d'un autre — le bouton mène alors à son plan. */
    rapports: ((repId: string) => string) | null;
    /** null : la personne ne corrige pas les territoires (Business Units). */
    territoire: ((buId: string | null) => string) | null;
    /** null : la personne ne coache pas. */
    coaching: ((repId: string) => string) | null;
    casPv: (premierId: string | null, total: number) => string;
    nonVues?: string;
  };
}

const JOUR_MS = 86_400_000;
const pluriel = (n: number, mot: string, pl = `${mot}s`) => (n > 1 ? pl : mot);

/** « aujourd'hui », « hier », « il y a 3 j ». */
export function depuis(d: Date | null, maintenant: Date): string {
  if (!d) return "date inconnue";
  const j = Math.floor((maintenant.getTime() - d.getTime()) / JOUR_MS);
  return j <= 0 ? "aujourd'hui" : j === 1 ? "hier" : `il y a ${j} j`;
}

const jourCourt = (d: Date) => `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;

/** Les rapports à relire — une ligne chacun, déjà triés par l'appelant (`trierARelire`). */
export function lignesARelire(e: Pick<EntreeFile, "aRelire" | "liens">): ActionEquipe[] {
  return e.aRelire.lignes.map((r) => {
    const pv = r.pvIa === "PROBABLE" || r.pvIa === "POSSIBLE";
    return {
      cle: `relire:${r.visitId}`,
      ton: pv ? "ko" : "i",
      titre: `${r.delegue} — ${r.praticien ?? "praticien non précisé"}, ${jourCourt(r.date)}`,
      sous: pv ? `${r.pvIa === "PROBABLE" ? "Probable" : "Possible"} cas de pharmacovigilance${r.raison ? ` : ${r.raison}` : ""}` : r.raison,
      citation: pv ? r.extrait : null,
      bouton: { libelle: "Relire", href: e.liens.relire(r.visitId) },
    };
  });
}

/** Tout ce qui n'est pas un rapport à relire : décider, voir, corriger, coacher, ouvrir — dans cet ordre. */
export function autresActions(e: EntreeFile): ActionEquipe[] {
  const out: ActionEquipe[] = [];
  for (const p of e.plansSoumis) {
    out.push({
      cle: `plan:${p.repId}`, ton: "w",
      titre: `Plan de tournée de ${p.nom} — soumis ${depuis(p.soumisLe, e.maintenant)}`,
      sous: null,
      bouton: { libelle: "Décider", href: e.liens.plan(p.planId) },
    });
  }
  for (const r of e.retards) {
    if (r.rapportsEnRetard <= 0) continue;
    out.push({
      cle: `retard:${r.repId}`, ton: "w",
      titre: `${r.rapportsEnRetard} ${pluriel(r.rapportsEnRetard, "rapport")} non ${pluriel(r.rapportsEnRetard, "fait")} — ${r.nom}`,
      sous: "Fenêtre de 48 h fermée sans compte rendu.",
      bouton: e.liens.rapports ? { libelle: "Voir ses rapports", href: e.liens.rapports(r.repId) } : null,
    });
  }
  for (const p of e.panelsVides) {
    out.push({
      cle: `panel:${p.repId}`, ton: "ko",
      titre: `Panel vide — ${p.nom} : ${CAUSE_PANEL_POUR_SUPERVISEUR[p.cause]}`,
      sous: null,
      bouton: e.liens.territoire ? { libelle: "Corriger le territoire", href: e.liens.territoire(p.buId) } : null,
    });
  }
  for (const c of e.coachings) {
    out.push({
      cle: `coaching:${c.repId}`, ton: "i",
      titre: `Pas de coaching depuis 60 j — ${c.nom}`,
      sous: c.dernier ? `Dernier ${depuis(c.dernier, e.maintenant)}.` : "Aucune fiche de coaching.",
      bouton: e.liens.coaching ? { libelle: "Nouvelle fiche", href: e.liens.coaching(c.repId) } : null,
    });
  }
  const nv = e.ciblesNonVues;
  if (nv && nv.total > 0) {
    out.push({
      cle: "non-vues", ton: "w",
      titre: `${nv.total} ${pluriel(nv.total, "cible")} H/A non ${pluriel(nv.total, "vue")} depuis 2 cycles`,
      sous: nv.decideurs ? `dont ${nv.decideurs} ${pluriel(nv.decideurs, "décideur")}` : null,
      bouton: e.liens.nonVues ? { libelle: "Voir", href: e.liens.nonVues } : null,
    });
  }
  for (const s of e.secteursVacants ?? []) {
    out.push({
      cle: `secteur:${s.id}`, ton: "i",
      titre: `Secteur ${s.nom} sans délégué`,
      sous: `${s.cibles} ${pluriel(s.cibles, "praticien")} ${pluriel(s.cibles, "ciblé")}, ${s.enA} en A`,
      bouton: e.liens.territoire ? { libelle: "Affecter", href: e.liens.territoire(s.buId) } : null,
    });
  }
  if (e.casPv.total > 0) {
    out.push({
      cle: "pv", ton: "ko",
      titre: `${e.casPv.total} ${pluriel(e.casPv.total, "signalement")} de pharmacovigilance de l'équipe en cours`,
      sous: "Suivis par Regulatory — l'échange se lit sur la fiche du cas.",
      bouton: { libelle: "Ouvrir", href: e.liens.casPv(e.casPv.premierId, e.casPv.total) },
    });
  }
  return out;
}
