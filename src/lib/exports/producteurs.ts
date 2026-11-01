import type { CurrentUser } from "@/lib/session";
import { userCan, peutAnnuaire } from "@/lib/rbac";
import { DOMAINES, DOMAINES_POLE } from "@/lib/budget/domaines";
import { droitsSegmentation } from "@/lib/segmentation/droits";
import { peutPiloterDemandesStocks } from "@/lib/queries/demande-stocks";
import { REGULATORY_CATEGORY, REGULATORY_STATUS, PRODUCT_CHANNEL } from "@/lib/labels";
import { exporterSuiviRegulatory } from "@/lib/exports/regulatory";
import { exporterBudget, exporterBudgetMarketing } from "@/lib/exports/budget";
import { exporterPilotage } from "@/lib/exports/pilotage";
import { exporterAppelDOffres } from "@/lib/exports/appel-d-offres";
import { exporterSegmentation } from "@/lib/exports/segmentation";
import { exporterDemandeStocks } from "@/lib/exports/demande-stocks";
import { exporterSuiviCoaching, exporterFicheCoaching } from "@/lib/exports/coaching";
import { exporterAnnuaire } from "@/lib/exports/annuaire";
import { exporterPlanTourneePdf } from "@/lib/exports/plan-de-tournee";
import { exporterInscritsEvenement } from "./evenement";
import { exporterEtudeDeMarche, exporterPresentationEtude } from "./etude-de-marche";
import { cleParLibelle, date, entier, libellesDe, liste, texte } from "./filtres";
import { refusExport, type ResultatExport } from "./types";

/**
 * LES PRODUCTEURS — pour chaque fiche du catalogue (`catalogue.ts`), l'entrée libre de l'assistant traduite en options
 * de LA fonction d'export que la route appelle aussi (lot K7, décision 0037). Rien n'est décidé ici : la portée, les
 * droits et l'audit sont dans la fonction. Un filtre qui ne désigne rien est refusé en le disant (400), jamais deviné.
 */
type Entree = Readonly<Record<string, unknown>>;
type Producteur = (user: CurrentUser, e: Entree) => Promise<ResultatExport>;

const PRODUCTEURS: Readonly<Record<string, Producteur>> = {
  exporter_suivi_regulatory: async (user, e) => {
    const statuts: string[] = [];
    for (const s of liste(e, "statuts")) {
      const k = cleParLibelle(REGULATORY_STATUS, s);
      if (!k) return refusExport(400, `Statut « ${s} » inconnu — statuts : ${libellesDe(REGULATORY_STATUS)}.`);
      statuts.push(k);
    }
    const lire = (champ: string, table: Parameters<typeof cleParLibelle>[0]) => {
      const t = texte(e, champ);
      return t ? cleParLibelle(table, t) ?? false : null;
    };
    const categorie = lire("categorie", REGULATORY_CATEGORY);
    const canal = lire("gamme", PRODUCT_CHANNEL);
    if (categorie === false) return refusExport(400, `Catégorie inconnue — ${libellesDe(REGULATORY_CATEGORY)}.`);
    if (canal === false) return refusExport(400, `Gamme inconnue — ${libellesDe(PRODUCT_CHANNEL)}.`);
    return exporterSuiviRegulatory(user, {
      statuts, categorie, canal, responsable: texte(e, "responsable") || null, recherche: texte(e, "recherche") || null,
    });
  },
  exporter_budget: (user, e) => exporterBudget(user, { enveloppe: texte(e, "enveloppe") || null, du: date(e, "du"), au: date(e, "au"), portee: texte(e, "portee") || null }),
  exporter_budget_marketing: (user, e) => exporterBudgetMarketing(user, {
    format: texte(e, "format") || "xlsx", enveloppe: texte(e, "enveloppe") || null,
    debut: texte(e, "debut") || null, fin: texte(e, "fin") || null, categorie: texte(e, "categorie") || null, n1: e.n1 === true,
  }),
  exporter_pilotage_force_de_vente: (user, e) => exporterPilotage(user, { annee: entier(e, "annee"), mois: entier(e, "mois"), bu: texte(e, "bu") || null }),
  exporter_appel_d_offres_pch: (user, e) => exporterAppelDOffres(user, texte(e, "appelDOffres")),
  exporter_segmentation: (user, e) => exporterSegmentation(user, texte(e, "strategie")),
  exporter_demande_stocks: (user, e) => exporterDemandeStocks(user, texte(e, "demande")),
  exporter_inscrits_evenement: (user, e) => exporterInscritsEvenement(user, texte(e, "evenement")),
  exporter_etude_de_marche: (user, e) => exporterEtudeDeMarche(user, texte(e, "etude")),
  exporter_presentation_etude: (user, e) => exporterPresentationEtude(user, texte(e, "presentation")),
  exporter_suivi_coaching: (user, e) => exporterSuiviCoaching(user, { collaborateur: texte(e, "collaborateur") || null, statut: texte(e, "statut") || null }),
  exporter_fiche_coaching: (user, e) => exporterFicheCoaching(user, texte(e, "fiche")),
  exporter_annuaire: (user, e) => exporterAnnuaire(user, texte(e, "grade") || null),
  exporter_plan_de_tournee_pdf: (user, e) => exporterPlanTourneePdf(user, { kam: texte(e, "kam") || null, mois: texte(e, "mois") || null }),
};

/**
 * LA PORTE D'ÉCRAN de chaque export — le droit qui ouvre le BOUTON (l'outil n'est offert qu'à qui l'a) ; la fonction
 * d'export rejuge tout (portée, entité, verrou) à chaque appel.
 */
const voit = (u: CurrentUser, ...modules: Parameters<typeof userCan>[1][]) => modules.some((m) => userCan(u, m, "VIEW"));
const OUVERTURES: Readonly<Record<string, (u: CurrentUser) => boolean>> = {
  exporter_suivi_regulatory: (u) => voit(u, "REGULATORY", "REGULATORY_PIPELINE"),
  exporter_budget: (u) => voit(u, "BUDGETS", ...DOMAINES_POLE.map((p) => DOMAINES[p].module)),
  exporter_budget_marketing: (u) => voit(u, DOMAINES.MARKETING.module, "BUDGETS"),
  exporter_pilotage_force_de_vente: (u) => voit(u, "SALES_PLANNING"),
  exporter_appel_d_offres_pch: (u) => voit(u, "PCH"),
  exporter_segmentation: (u) => droitsSegmentation(u).voir,
  exporter_demande_stocks: (u) => voit(u, "STOCKS") && peutPiloterDemandesStocks(u),
  exporter_inscrits_evenement: (u) => voit(u, "EVENTS"),
  exporter_etude_de_marche: (u) => voit(u, "BUSINESS_DEVELOPMENT"),
  exporter_presentation_etude: (u) => voit(u, "BUSINESS_DEVELOPMENT"),
  exporter_suivi_coaching: (u) => voit(u, "MEDICAL"),
  exporter_fiche_coaching: (u) => voit(u, "MEDICAL"),
  exporter_annuaire: (u) => voit(u, "MEDICAL") || peutAnnuaire(u, "MEDECINS", "VIEW") || peutAnnuaire(u, "PHARMACIENS", "VIEW"),
  exporter_plan_de_tournee_pdf: (u) => voit(u, "MEDICAL"),
};

export const exportOuvert = (outil: string, user: CurrentUser): boolean => OUVERTURES[outil]?.(user) ?? false;

/** Produire l'export d'une fiche du catalogue, sous les droits de la personne. */
export function produireExport(outil: string, user: CurrentUser, entree: Entree): Promise<ResultatExport> {
  const p = PRODUCTEURS[outil];
  return p ? p(user, entree ?? {}) : Promise.resolve(refusExport(404, `Export « ${outil} » inconnu.`));
}

/** Les outils qui ont un producteur — le test vérifie qu'ils sont exactement ceux du catalogue. */
export const OUTILS_PRODUITS: readonly string[] = Object.keys(PRODUCTEURS);
export const OUTILS_OUVERTS: readonly string[] = Object.keys(OUVERTURES);

// Ce que lit l'assistant, par UNE porte du socle IA (`platform/ia/exports.ts`) : le catalogue et le nom de fichier sûr.
export { CATALOGUE_EXPORTS, DOSSIER_EXPORTS, type FicheExport } from "./catalogue";
export { nomDeFichierSur } from "./types";
