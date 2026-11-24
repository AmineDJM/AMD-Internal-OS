/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « OÙ EN EST LA DEMANDE » — la barre de cinq étapes au plus en tête d'une fiche Ad & Pro (maquette « Fiche Ad & Pro »
 * validée par le Super Admin, 24/11/2026).
 *
 *   Demande · Prévalidation (ou Validation) · Postes · Validation finale (sponsoring) · Déclaration
 *
 * Elle ne décide de rien : elle RÉSUME ce que la fiche lit déjà — la frise du circuit (`friseDuCircuit`), la suite du
 * sponsoring (postes, validation finale), l'étape de déclaration (`etapeDeclaration`). Le circuit, quelle que soit la
 * longueur de son parcours (superviseur, Directeur des opérations, Direction Marketing…), tient en UNE case ; le détail
 * reste dans « Plus d'informations ». L'étape en cours dit chez qui — « chez vous » quand c'est à la personne qui regarde.
 *
 * Fonction PURE — testée (`barre-etapes.test.ts`).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

type EtatBarre = "fait" | "en_cours" | "a_venir" | "refuse";
type CleBarre = "demande" | "circuit" | "postes" | "validation_finale" | "declaration";

export interface EtapeBarre {
  cle: CleBarre;
  titre: string;
  etat: EtatBarre;
  /** Sous le titre : la date et la personne d'une étape faite ; chez qui en est l'étape en cours. */
  sousTitre: string | null;
  /** Au survol : ce qu'on sait de plus (une étape à venir dit quand elle s'ouvrira). */
  aide: string | null;
}

/** L'état tel que le circuit et l'étape de déclaration l'écrivent. */
type EtatLu = "done" | "current" | "todo" | "rejected";

/** Une case de la frise du circuit (`EtapeDeFrise`), recopiée en type pour rester pur. */
export interface EtapeLue {
  cle: string;
  titre: string;
  etat: EtatLu;
  detail?: string | null;
}

type NatureFiche = "SPONSORING" | "EVENT" | "AD_PRO_OTHER" | "CONGRESS_NATIONAL" | "CONGRESS_INTERNATIONAL";

export interface EntreeBarre {
  nature: NatureFiche;
  /**
   * Le circuit : son statut (`WorkflowView.status`), sa frise SANS la suite de la page (« Demande » puis les étapes de son
   * parcours), et si la personne qui regarde y a un geste (décider, resoumettre). `null` : pas de circuit (un événement
   * non soumis à la prise en charge).
   */
  circuit: { statut: string; frise: EtapeLue[]; aVous: boolean } | null;
  /** La demande, quand la frise du circuit ne la date pas : `detail` (« 12 nov. · Y. Habes »), ou encore à soumettre. */
  deposee: { detail: string | null; aSoumettre?: boolean; aVous?: boolean };
  /** Les postes — `null` quand la demande n'en a pas (un ancien accord à montant global). */
  postes: { ouverts: boolean; termines: boolean; aVous: boolean; n: number; chez?: string | null } | null;
  /** La validation finale — le sponsoring seul. */
  validationFinale: { etat: EtatLu; detail?: string | null; aVous: boolean } | null;
  /** La déclaration (information scientifique) — `null` pour ce qui ne se déclare pas (« autres »). */
  declaration: { etat: EtatLu; detail?: string | null; aVous: boolean } | null;
}

const ETAT: Record<EtatLu, EtatBarre> = { done: "fait", current: "en_cours", todo: "a_venir", rejected: "refuse" };

/** Le circuit s'appelle « Prévalidation » là où les postes viennent après lui, « Validation » sur les prises en charge et événements. */
export function titreDuCircuit(nature: NatureFiche): string {
  return nature === "SPONSORING" || nature === "AD_PRO_OTHER" ? "Prévalidation" : "Validation";
}

const nPostes = (n: number) => (n === 0 ? "aucun poste" : `${n} poste${n > 1 ? "s" : ""}`);

function etapeCircuit(e: EntreeBarre): EtapeBarre {
  const titre = titreDuCircuit(e.nature);
  const base = { cle: "circuit" as const, titre, aide: null };
  const c = e.circuit;
  if (!c) return { ...base, etat: "a_venir", sousTitre: null };
  const etapes = c.frise.filter((x) => x.cle !== "__demande__");
  const refusee = etapes.find((x) => x.etat === "rejected");
  if (c.statut === "REJECTED" || refusee) return { ...base, etat: "refuse", sousTitre: refusee?.detail ? `refusée · ${refusee.detail}` : "refusée" };
  if (c.statut === "CANCELLED") return { ...base, etat: "refuse", sousTitre: "retirée" };
  if (c.statut === "APPROVED" || (etapes.length > 0 && etapes.every((x) => x.etat === "done"))) {
    const derniere = [...etapes].reverse().find((x) => x.etat === "done");
    return { ...base, etat: "fait", sousTitre: derniere?.detail ?? null };
  }
  if (c.statut === "RETURNED") return { ...base, etat: "en_cours", sousTitre: `à corriger — chez ${c.aVous ? "vous" : "le demandeur"}` };
  const courante = etapes.find((x) => x.etat === "current");
  if (!courante) return { ...base, etat: "en_cours", sousTitre: null };
  const qui = c.aVous ? "vous" : courante.detail || null;
  // Un parcours à plusieurs étapes nomme celle où il en est ; à une seule, le titre de la case suffit.
  const ou = etapes.length > 1 ? `${courante.titre} — ` : "";
  return { ...base, etat: "en_cours", sousTitre: qui ? `${ou}chez ${qui}` : courante.titre, aide: courante.titre };
}

/** LA BARRE — de deux à cinq étapes, dans l'ordre de la procédure. */
export function barreDesEtapes(e: EntreeBarre): EtapeBarre[] {
  const creation = e.circuit?.frise.find((x) => x.cle === "__demande__") ?? null;
  const demande: EtapeBarre = e.deposee.aSoumettre && !e.circuit
    ? { cle: "demande", titre: "Demande", etat: "en_cours", sousTitre: e.deposee.aVous ? "à soumettre — chez vous" : "non soumise", aide: null }
    : { cle: "demande", titre: "Demande", etat: "fait", sousTitre: creation?.detail ?? e.deposee.detail, aide: null };

  const barre: EtapeBarre[] = [demande, etapeCircuit(e)];

  if (e.postes) {
    const p = e.postes;
    barre.push(p.termines
      ? { cle: "postes", titre: "Postes", etat: "fait", sousTitre: nPostes(p.n), aide: null }
      : p.ouverts
        ? { cle: "postes", titre: "Postes", etat: "en_cours", sousTitre: p.aVous ? "chez vous" : p.chez ? `chez ${p.chez}` : nPostes(p.n), aide: nPostes(p.n) }
        : { cle: "postes", titre: "Postes", etat: "a_venir", sousTitre: null, aide: `après la ${titreDuCircuit(e.nature).toLowerCase()}` });
  }

  if (e.validationFinale) {
    const v = e.validationFinale;
    const etat = ETAT[v.etat];
    barre.push({
      cle: "validation_finale", titre: "Validation finale", etat,
      sousTitre: etat === "a_venir" ? null : etat === "en_cours" && v.aVous ? "chez vous" : v.detail ?? null,
      aide: etat === "a_venir" ? v.detail ?? null : null,
    });
  }

  // LA DÉCLARATION, GRISÉE TANT QUE CE N'EST PAS SON MOMENT : la case dit seulement qu'elle viendra ; ce qu'elle attend se lit
  // au survol. Sa section n'apparaît sur la fiche qu'à son étape.
  if (e.declaration) {
    const d = e.declaration;
    const etat = ETAT[d.etat];
    barre.push({
      cle: "declaration", titre: "Déclaration", etat,
      sousTitre: etat === "a_venir" ? null : etat === "en_cours" && d.aVous ? "chez vous" : d.detail ?? null,
      aide: d.detail ?? null,
    });
  }
  return barre;
}
