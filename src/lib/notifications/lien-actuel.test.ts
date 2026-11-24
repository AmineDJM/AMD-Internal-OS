import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { reécriteLienNotification } from "./lien-actuel";
import { lienTache, lienCalendrier, lienBilanKpi, lienKpiEquipe, lienConversation, LIEN_MISSIONS_A_VALIDER, CHEMIN_TACHES, vueTachePour } from "@/lib/chemins/espace";
import {
  LIEN_MES_CONGES, LIEN_CONGES_A_SIGNER, LIEN_CONGES_A_TRANCHER_RH, LIEN_INTERIMAIRES_A_VALIDER, LIEN_MES_AVANCES,
  CHEMIN_PAIE_RH, lienMaDemandeRh, lienDemandeRhATraiter,
} from "@/lib/chemins/rh";
import { lienEtapeAValider, lienDemandeDeValidation } from "@/lib/chemins/validations";
import { lienOrdreAPayer, lienCentreDePaiement } from "@/lib/chemins/finances";
import { lienDemandeAdPro, lienPosteAdPro } from "@/lib/chemins/ad-pro";

/**
 * LES ANCIENS LIENS DE NOTIFICATIONS — chaque route supprimée ou devenue page d'escale (historique du
 * dépôt) est réécrite vers l'écran actuel, paramètres et ancre conservés quand ils ont encore un sens.
 */
const TABLE: [string, string][] = [
  // Espace personnel
  ["/missions", "/mon-espace/missions"],
  ["/missions#a-valider", "/mon-espace/missions#a-valider"],
  ["/mon-travail", "/mon-espace"],
  ["/dashboard", "/mon-espace"],
  ["/courrier", "/mon-espace"],
  ["/moyens-generaux/annuaire", "/mon-espace/annuaire"],
  ["/assistant?mission=m42", "/missions/m42"],
  // Finances
  ["/finances", "/finances/paiements-a-faire"],
  ["/comptabilite", "/finances/paiements-a-faire"],
  ["/finances/ordres-de-depense", "/finances/paiements-a-faire"],
  ["/finances/ordres-de-depense?focus=o1", "/finances/paiements-a-faire?focus=o1#ord-o1"],
  ["/finances/centre-de-paiement", "/centre-de-paiement"],
  // Plus de sections au centre (24/11/2026) : un ancien lien de notification ouvre la file unique de son entité.
  ["/centre-de-paiement?entite=c1&section=regulatory", "/centre-de-paiement?entite=c1"],
  ["/centre-de-paiement?section=sales-marketing", "/centre-de-paiement"],
  ["/finances/centre-de-paiement?entite=c1&section=autres", "/centre-de-paiement?entite=c1"],
  ["/finances/factures", "/legal?nature=INVOICE"],
  ["/legal/factures", "/legal?nature=INVOICE"],
  ["/finances/paiements", "/validations/paiements"],
  ["/finances/paiements/p9", "/validations/paiements/p9"],
  ["/finances/bons-de-commande", "/bons-de-commande"],
  ["/finances/paie", "/rh/paie"],
  // Validations : le centre n'a plus qu'un écran (24/11/2026), l'étape visée reste désignée
  ["/centre-de-validations", "/validations"],
  ["/centre-de-validations?focus=s1#val-s1", "/validations?focus=s1#val-s1"],
  // RH
  ["/admin/departments", "/rh/departements"],
  ["/rh/demandes?id=req123", "/rh/demandes?demande=req123"],
  // Force de vente, Business Units, Marketing
  ["/planning/catalogue", "/business-units"],
  ["/planning/equipes", "/business-units"],
  ["/planning/business-units", "/business-units"],
  ["/planning/business-units?etape=secteurs&bu=b1", "/business-units/secteurs?bu=b1"],
  ["/planning/parametres", "/business-units/parametres"],
  ["/planning/pilotage?y=2026&m=9", "/planning?y=2026&m=9"],
  ["/planning/affectations", "/planning/produits"],
  ["/planning/messages", "/marketing-cockpit?vue=messages"],
  ["/marketing-cockpit/messages?produit=p1", "/marketing-cockpit?produit=p1&vue=messages"],
  ["/planning/specialites", "/annuaires/specialites"],
  ["/marketing-cockpit/specialites", "/annuaires/specialites"],
  ["/medical/etablissements", "/annuaires/etablissements"],
  ["/field-reports", "/medical/rapports"],
  ["/field-reports/r1", "/medical/rapports/r1"],
  ["/field-reports/overview", "/medical/rapports/overview"],
  ["/field-reports/pharmacovigilance/c1", "/medical/rapports/pharmacovigilance/c1"],
  // Produits, Regulatory, Business development
  ["/regulatory/catalogue", "/produits"],
  ["/regulatory/catalogue/x1", "/produits/x1?onglet=reglementaire"],
  ["/regulatory/requests", "/regulatory"],
  ["/regulatory/requests/r1?onglet=2", "/regulatory"],
  ["/business-development/pipeline", "/regulatory/pipeline"],
  ["/business-development/marche/produits", "/explorateur-produits"],
  // Stock promotionnel
  ["/promo-material/catalogue", "/stock-promotionnel/catalogue"],
  ["/promo-material/stock", "/stock-promotionnel"],
  ["/promo-material/stock?vue=magasin", "/stock-promotionnel?vue=magasin"],
  ["/promo-material/stock?vue=inconnue", "/stock-promotionnel"],
  // Registres : un courrier s'ouvre dans le panneau du registre (24/11/2026)
  ["/courriers/c1", "/courriers?courrier=c1"],
  ["/courriers/c1#journal", "/courriers?courrier=c1#journal"],
  // Modules retirés, divers
  ["/retours-reclamations?reclamation=r1", "/mon-espace"],
  ["/office", "/drive"],
  ["/process-intelligence/people", "/process-intelligence?vue=personnes"],
  ["/admin/organigramme", "/organigramme"],
  ["/annuaires/autres", "/annuaires/fournisseurs"],
  // Bureau du secrétariat : un seul tableau, une page par fiche ; courses, coursier et « Bureau de Donna » supprimés (24/11/2026)
  ["/demandes?onglet=adpro&fiche=dr42", "/demandes/fiches/dr42"],
  ["/demandes?onglet=adpro", "/demandes"],
  ["/demandes/courses", "/demandes"],
  ["/demandes/driver?mission=m1", "/demandes"],
  ["/demandes/assistant", "/demandes"],
];

/** L'inventaire des pages — le même que le banc des liens morts. */
function routesConnues(): RegExp[] {
  const app = path.join(process.cwd(), "src", "app");
  const pages: string[] = [];
  const marcher = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) marcher(p);
      else if (e.name === "page.tsx") pages.push(p);
    }
  };
  marcher(app);
  return pages
    .map((f) => path.dirname(path.relative(app, f)).split(path.sep).filter((s) => s && s !== "." && !/^\(.*\)$/.test(s)))
    .map((segs) => new RegExp(`^/${segs.map((s) => (/^\[.+\]$/.test(s) ? "[^/]+" : s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("/")}/?$`));
}
const existe = (routes: RegExp[], lien: string) => routes.some((r) => r.test(lien.split(/[?#]/)[0] || "/"));

describe("reécriteLienNotification — les anciennes routes", () => {
  it.each(TABLE)("%s → %s", (ancien, actuel) => {
    expect(reécriteLienNotification(ancien)).toBe(actuel);
  });

  it("chaque destination de la table est une page qui existe aujourd'hui", () => {
    const routes = routesConnues();
    const morts = TABLE.map(([, actuel]) => actuel).filter((l) => !existe(routes, l));
    expect(morts, `DESTINATIONS SANS PAGE :\n${morts.join("\n")}`).toEqual([]);
  });

  it("une réécriture est stable : réécrire un lien déjà actuel ne le change pas", () => {
    for (const [, actuel] of TABLE) expect(reécriteLienNotification(actuel)).toBe(actuel);
  });
});

describe("reécriteLienNotification — les liens actuels passent tels quels", () => {
  it("routes, identifiants, paramètres et ancres", () => {
    for (const l of [
      "/rh", "/mon-dossier", "/medical", "/rh/xyz123", "/demandes/abc456", "/missions/m1",
      "/mon-equipe?vue=kpi", "/mon-espace#conges-a-signer", "/legal?echeances=1",
      "/mon-espace/taches?vue=demandees&tache=t1", "/validations?focus=s1#val-s1", "/rh?id=emp123", "/messages?id=msg456", "/centre-de-paiement?entite=c1",
    ]) expect(reécriteLienNotification(l)).toBe(l);
  });

  it("vide, absent, externe", () => {
    expect(reécriteLienNotification(null)).toBeNull();
    expect(reécriteLienNotification(undefined)).toBeNull();
    expect(reécriteLienNotification("")).toBeNull();
    expect(reécriteLienNotification("https://exemple.dz/x")).toBe("https://exemple.dz/x");
    expect(reécriteLienNotification("//exemple.dz/x")).toBe("//exemple.dz/x");
  });
});

describe("les liens écrits par les notifications d'aujourd'hui mènent à une page qui existe", () => {
  const LIENS = [
    lienTache("t1"), lienTache("t1", "demandees"), CHEMIN_TACHES, LIEN_MISSIONS_A_VALIDER,
    lienCalendrier(new Date("2026-11-03T10:00:00Z")), lienBilanKpi("2026-10"), lienKpiEquipe("2026-T4"), lienConversation("c1"),
    LIEN_MES_CONGES, LIEN_CONGES_A_SIGNER, LIEN_CONGES_A_TRANCHER_RH, LIEN_INTERIMAIRES_A_VALIDER, LIEN_MES_AVANCES, CHEMIN_PAIE_RH,
    lienMaDemandeRh("d1"), lienMaDemandeRh(null), lienDemandeRhATraiter("d1"),
    lienEtapeAValider("s1"), lienDemandeDeValidation("v1"),
    lienOrdreAPayer("o1"), lienOrdreAPayer(null), lienCentreDePaiement("c1"), lienCentreDePaiement(),
    lienDemandeAdPro("SPONSORING", "x"), lienDemandeAdPro("EVENT", "x"), lienPosteAdPro("CONGRESS_NATIONAL", "x", "i1"),
  ];
  it.each(LIENS)("%s", (lien) => {
    expect(existe(routesConnues(), lien)).toBe(true);
  });

  it("les formes exactes que les pages lisent", () => {
    expect(lienTache("t1")).toBe("/mon-espace/taches?tache=t1");
    expect(lienTache("t1", "partagees")).toBe("/mon-espace/taches?vue=partagees&tache=t1");
    expect(lienCalendrier(new Date("2026-11-30T23:30:00Z"))).toBe("/calendar?y=2026&m=12"); // minuit passé à Alger
    expect(lienMaDemandeRh("d1")).toBe("/mon-dossier#demande-rh-d1");
    expect(lienDemandeRhATraiter("d1")).toBe("/rh/demandes?demande=d1");
    expect(lienEtapeAValider("s1")).toBe("/validations?focus=s1#val-s1");
    expect(lienOrdreAPayer("o1")).toBe("/finances/paiements-a-faire?focus=o1#ord-o1");
    expect(lienPosteAdPro("SPONSORING", "s9", "i1")).toBe("/sponsoring/s9#poste-i1");
    expect(lienCentreDePaiement("c1")).toBe("/centre-de-paiement?entite=c1");
  });

  it("la vue d'une tâche suit le rôle du destinataire", () => {
    const t = { assignedToId: "a", createdById: "c" };
    expect(vueTachePour("a", t)).toBeUndefined();
    expect(vueTachePour("c", t)).toBe("demandees");
    expect(vueTachePour("p", t)).toBe("partagees");
  });
});
