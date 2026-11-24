import { test, expect, attendFusion, graine } from "./banc";
import { db, fermer } from "./donnees";
import { P } from "./comptes";

/**
 * PARCOURS 15 — DÉPART D'UN SALARIÉ, ENTIÈREMENT AUTOMATIQUE (lot rhdepart EN ATTENTE).
 *
 * À la création du salarié, son compte utilisateur est créé automatiquement. La fin de contrat se valide en TRIPLE
 * validation : RH → supérieur hiérarchique → DG ; elle déclenche la LISTE DE SORTIE (véhicule, matériel promotionnel,
 * solde de tout compte, certificat de travail…), affichée et toujours modifiable.
 */

const SALARIE = `${P} Sofiane Départ`;
let salarieId = "";
test.beforeAll(async () => {
  const g = graine();
  const deja = await db().employee.findFirst({ where: { fullName: SALARIE }, select: { id: true } });
  salarieId = deja?.id ?? (await db().employee.create({
    data: { fullName: SALARIE, companyId: g.societeId, departmentId: g.departements.OPERATIONS, position: "Délégué médical", hireDate: new Date("2024-03-01") },
  })).id;
  const superviseurSalarie = await db().employee.findFirst({ where: { userId: g.comptes.superviseur }, select: { id: true } });
  if (superviseurSalarie) await db().employee.update({ where: { id: salarieId }, data: { managerId: superviseurSalarie.id } });
});
test.afterAll(async () => { await fermer(); });

test("RH — créer un salarié : son compte utilisateur naît avec lui", attendFusion("rhdepart"), async ({ recette: r, page }) => {
  await r.connecter("rh");
  await r.etape("RH › Équipe : créer « Nadia Recette » (e-mail, poste, département, N+1)", "La fiche salarié porte une carte « Compte » : compte créé automatiquement (invitation envoyée — sorties coupées en recette)", async () => {
    await r.aller("/rh/equipe");
    await expect(page.getByRole("button", { name: /Nouveau|Ajouter|Créer/ }).first()).toBeVisible();
  });
});

test("Fin de contrat — RH → supérieur → DG, puis la liste de sortie", attendFusion("rhdepart"), async ({ recette: r, page }) => {
  await r.connecter("rh");
  await r.etape(`Fiche de « ${SALARIE} » › fin de contrat`, "Formulaire : « Dernier jour travaillé », « Motif », « Préavis (jours) », « Note pour les valideurs » ; « Enregistrer le brouillon » / « Envoyer en validation » ; rappel « Validation RH → supérieur hiérarchique → DG. »", async () => {
    await r.aller(`/rh/${salarieId}`);
    await expect(page.getByText("Validation RH → supérieur hiérarchique → DG.").first()).toBeVisible();
  });
  await r.etape("Remplir et « Envoyer en validation »", "La RH valide sa propre étape ; le supérieur (superviseur) est prévenu", async () => {
    await page.getByLabel("Dernier jour travaillé").fill(new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10));
    await page.getByRole("button", { name: "Envoyer en validation" }).click();
  });
  await r.connecter("superviseur");
  await r.controle("Le supérieur hiérarchique valide (depuis « Aujourd'hui » ou la fiche)", "Étape 2 validée ; le DG est prévenu", async () => {
    await r.aller("/mon-espace");
    await expect(page.getByText(/Départ|fin de contrat/i).first()).toBeVisible();
  });
  await r.connecter("dg");
  await r.controle("Le DG valide", "Fin de contrat VALIDÉE ; la « Liste de sortie » apparaît sur la fiche", async () => {
    await r.aller(`/rh/${salarieId}`);
    await expect(page.getByText(/Liste de sortie/).first()).toBeVisible();
  });
  await r.connecter("rh");
  await r.controle("Liste de sortie : véhicule, matériel promotionnel, solde de tout compte, certificat de travail", "Chaque ligne modifiable ; « Ajouter » une ligne ; « Enregistrer le solde » (À verser / À retenir) ; « Texte du certificat »", async () => {
    await r.aller(`/rh/${salarieId}`);
    for (const t of ["solde", "certificat"]) await expect(page.getByText(new RegExp(t, "i")).first()).toBeVisible();
  });
  await r.controle("Le délégué ouvre la fiche RH du salarié", "Refus d'accès (RH seulement)", async () => {
    await r.connecter("delegue");
    await r.aller(`/rh/${salarieId}`);
    await expect(page).not.toHaveURL(new RegExp(`/rh/${salarieId}$`));
  });
});
