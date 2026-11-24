import { test, expect, graine } from "./banc";
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

