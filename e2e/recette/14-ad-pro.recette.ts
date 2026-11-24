import { test, expect, attendFusion, graine } from "./banc";
import { db, fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 14 — AD & PRO : la liste (lot adprolist EN ATTENTE), la fiche simplifiée (lot ficheadpro FUSIONNÉ) et le
 * centre de validation Ad & Pro (lot ctradpro EN ATTENTE). Seuil DG : 1 M DZD (gardé) ; l'étape « Direction des
 * opérations » est gardée à tout montant.
 */

const NOM = `${P} Journées de cardiologie — CHU de Blida`;
let id = "";
test.beforeAll(async () => {
  const g = graine();
  const deja = await db().congressNational.findFirst({ where: { name: NOM }, select: { id: true } });
  id = deja?.id ?? (await db().congressNational.create({
    data: { name: NOM, city: "Blida", companyId: g.societeId, businessUnitId: g.buId, requesterId: g.comptes.kam, createdById: g.comptes.kam },
  })).id;
});
test.afterAll(async () => { await fermer(); });

test("Fiche Ad & Pro simplifiée — « À vous », « La demande », « Postes »", async ({ recette: r, page }) => {
  await r.connecter("superAdmin");
  await r.etape("Ouvrir la fiche « Journées de cardiologie — CHU de Blida »", "Titre de la demande ; bloc « La demande » ; « Postes · n » ; carte « À vous » quand un geste attend la personne", async () => {
    await r.aller(`/congress-national/${id}`);
    await expect(page.getByRole("heading", { name: /Journées de cardiologie/ })).toBeVisible();
  });
  await r.controle("Téléphone", "La fiche tient à 390 px", async () => {
    const tel = await r.telephone("kam");
    await r.aller(`/congress-national/${id}`, tel);
    return r.sansDebordement(tel);
  });
  await r.controle("Le délégué (pas le demandeur) ouvre la fiche", "Refus ou lecture seule : aucun geste « À vous »", async () => {
    await r.connecter("delegue");
    await r.aller(`/congress-national/${id}`);
    await expect(page.getByText(/^À vous/)).toHaveCount(0);
  });
});

test("Liste Ad & Pro — un tableau, des pastilles, « À vous » en tête", attendFusion("adprolist"), async ({ recette: r, page }) => {
  await r.connecter("dirMarketing");
  await r.etape("Ouvrir « Ad & Pro »", "En-tête « Ad & Pro » + « Nouvelle demande », sans phrase ; pastilles d'état (« À vous » en tête) ; recherche instantanée ; « Filtres »", async () => {
    await r.aller("/ad-pro");
    await expect(page.getByRole("heading", { name: "Ad & Pro" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Nouvelle demande/ }).or(page.getByRole("link", { name: /Nouvelle demande/ })).first()).toBeVisible();
  });
  await r.controle("Taper « Blida »", "La liste se réduit à la demande ; pastilles recomptées", async () => {
    await page.getByRole("searchbox").or(page.getByPlaceholder(/Rechercher/)).first().fill("Blida");
    await expect(page.getByText(/CHU de Blida/).first()).toBeVisible();
  });
  await r.controle("Téléphone", "Une carte par demande, sans défilement de côté", async () => {
    const tel = await r.telephone("dirMarketing");
    await r.aller("/ad-pro", tel);
    return r.sansDebordement(tel);
  });
});

test("Centre de validation Ad & Pro — valider le total, viser un BC, seuils", attendFusion("ctradpro"), async ({ recette: r, page }) => {
  await r.connecter("dg");
  await r.etape("Ouvrir « Centre de validation Ad & Pro »", "File « À décider · n » à gauche, fiche à droite ; pastilles des sociétés ; menu ⋯ « Déjà décidés · n », « Réglage des seuils »", async () => {
    await r.aller("/centre-ad-pro");
    await expect(page.getByRole("heading", { name: /Centre de validation Ad & Pro/ })).toBeVisible();
  });
  await r.controle("Fiche d'une demande au-dessus de 1 000 000 DZD", "« Valider le total » / « Refuser » (motif en un clic) / « Demander une précision » ; « Déjà validé » montre l'étape Direction des opérations", async () => {
    await expect(page.getByText(/À décider/).first()).toBeVisible();
  });
  await r.controle("Fiche d'un BC (PEC v2)", "« Viser le BC » ; « Devis, accordé, BC » (écart en rouge)", async () => {
    await expect(page.getByText(/Viser le BC|Valider le total|Rien à décider/).first()).toBeVisible();
  });
  await r.controle("⋯ › « Réglage des seuils »", "Demandes : 1 000 000 ; « Enregistrer » ; « Déjà décidés » permet « Réexaminer » un refus", async () => {
    await page.getByRole("button", { name: /Réglage des seuils|⋯|Autres/ }).first().click();
    await expect(page.getByText(/1[\s  ]000[\s  ]000/).first()).toBeVisible();
  });
  await r.controle("Directeur des opérations ouvre le centre Ad & Pro", "Il n'y décide pas (le visa est celui de la Direction générale)", async () => {
    await r.connecter("dirOps");
    await r.aller("/centre-ad-pro");
    await expect(page.getByRole("button", { name: /Valider le total|Viser le BC/ })).toHaveCount(0);
  });
});
