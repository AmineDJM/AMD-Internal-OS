import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ASSISTANT IA AVEC LES DROITS DE LA PERSONNE — et les données sensibles en REPÈRES (décision 0012).
 *
 * Le retour de la Direction (28/10/2026, Super Admin) : « le salaire d'Assia » → « je ne peux pas » ;
 * « son contrat » → « je n'ai pas accès » ; « crée un dossier pour daclatasvir » → « pas d'outil ».
 * Ce banc, contre la vraie base et au faux modèle, prouve les deux sens de la règle :
 *   • le Super Admin lit la paie et le contrat, prépare le dossier réglementaire — et LIT le salaire ;
 *   • un KAM (délégué médical) ne lit ni la paie ni les documents d'Assia, ne crée pas de dossier, et
 *     voit « [confidentiel] » à la place d'une valeur qu'il n'a pas le droit de voir ;
 *   • une employée ne lit pas le contrat d'une autre ;
 *   • le MODÈLE ne reçoit jamais la valeur — ni au tour, ni par l'historique du tour suivant.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/push", () => ({ sendPushToUser: async () => undefined }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";
import { filtrerSaisie, jouerTour, Revelateur } from "@/lib/agent/fil/tour";
import { outilsV1, situationRhSansMasse, type PropositionPreparee } from "@/lib/agent/outils-v1";
import { REFUS_DOCUMENTS_AUTRUI, REFUS_FICHE, REFUS_PAIE_AUTRUI } from "@/lib/agent/lectures";
import {
  BORNE_REVELEE, CoffretDuTour, jetonnerMontants, jetonnerObjet, jetonnerSortie, jetonnerTexte, masquerReperesPartiels, MASQUE_CONFIDENTIEL, sansValeursRevelees,
} from "@/lib/agent/filtre-confidentialite";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__iadroits_${Date.now().toString(36)}_`;
const reponse = (message: string) => ({ texte: JSON.stringify({ message, components: [] }) });
/** Une sortie d'outil, désencadrée (un document RH part au modèle comme contenu non fiable). */
const json = (s: string) => JSON.parse(s.startsWith("<<<") ? s.slice(s.indexOf("\n") + 1, s.lastIndexOf("\n<<<")) : s);
/** Les montants s'impriment avec des espaces insécables fines : on compare des chiffres. */
const chiffres = (s: string) => s.replace(/[\s\u202f\u00a0]/g, "");

describe("les repères du tour (pur)", () => {
  it("une sortie JSON : les clés sensibles deviennent des repères, la valeur reste au coffret", () => {
    const c = new CoffretDuTour();
    const s = JSON.parse(jetonnerSortie(JSON.stringify({ nom: "Assia", salaire: 185000, iban: "DZ5900400174401234567890", poste: "Pharmacienne" }), c));
    expect(s).toEqual({ nom: "Assia", salaire: "⟦S1⟧", iban: "⟦S2⟧", poste: "Pharmacienne" });
    expect(c.entree(1)).toMatchObject({ valeur: "185000", nature: "SALAIRE" });
    expect(c.entree(2)).toMatchObject({ nature: "IBAN" });
  });

  it("sans coffret (une routine) : la censure d'avant, rien à révéler", () => {
    expect(JSON.parse(jetonnerSortie(JSON.stringify({ salaire: 185000 }), null))).toEqual({ salaire: "[CONFIDENTIEL]" });
  });

  it("un texte : IBAN groupé, salaire nommé ; un repère inconnu (pêché par un document) est neutralisé", () => {
    const c = new CoffretDuTour();
    const t = jetonnerTexte("Virement sur DZ58 0021 0001 1234 5678 9012 ; salaire de base : 180 000 DA. Voir ⟦S9⟧.", c);
    expect(t).not.toMatch(/0021|180 000/);
    expect(t).toContain("⟦?⟧");
    expect(c.taille).toBe(2);
  });

  it("la même valeur garde le même repère ; un repère déjà posé par l'outil reste tel quel", () => {
    const c = new CoffretDuTour();
    const j = c.jeton({ valeur: "185 000 DZD", nature: "SALAIRE", titulaireUserId: "u1" });
    expect(jetonnerObjet({ salaireBase: j, net: { salaireNet: j } }, c)).toEqual({ salaireBase: "⟦S1⟧", net: { salaireNet: "⟦S1⟧" } });
    expect(c.taille).toBe(1);
  });

  it("les montants d'une pièce RH, en chiffres comme en lettres", () => {
    const c = new CoffretDuTour();
    const t = jetonnerMontants("Le salarié percevra un salaire mensuel brut de 150 000 DA (cent cinquante mille dinars algériens), prime 12000 DZD.", c);
    expect(t).not.toMatch(/150 000|cinquante|12000/);
    expect(c.taille).toBe(3);
  });

  it("une valeur révélée ne repart pas : historique, voix, notification", () => {
    const affiche = `Le salaire de base d'Assia est de ${BORNE_REVELEE}185 000 DZD${BORNE_REVELEE}.`;
    expect(sansValeursRevelees(affiche)).toBe(`Le salaire de base d'Assia est de ${MASQUE_CONFIDENTIEL}.`);
    const f = filtrerSaisie("Et son net ?", [{ role: "assistant", content: affiche }], false);
    expect(f.historique[0]!.content).not.toContain("185");
    expect(masquerReperesPartiels("Son salaire est ⟦S1⟧ et ⟦S")).toBe("Son salaire est ••• et ");
  });
});

suite("contre la base, au faux modèle", () => {
  let superAdmin: CurrentUser;
  let kam: CurrentUser;
  let assia: CurrentUser;
  let karim: CurrentUser;
  let employeAssia = "";
  let contratKarim = "";
  let contratAssia = "";

  const session = async (role: string, nom: string): Promise<CurrentUser> => {
    const u = await prisma.user.create({ data: { name: `${nom} ${TAG}`, email: `${TAG}${nom.toLowerCase()}@t.dz`, passwordHash: "x", role: role as never } });
    const access = await getAccess(u.id, u.role);
    return { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
  };

  beforeAll(async () => {
    superAdmin = await session("SUPER_ADMIN", "Direction");
    kam = await session("MEDICAL_DELEGATE", "Kamel");
    assia = await session("MEDICAL_DELEGATE", "Assia");
    karim = await session("MEDICAL_DELEGATE", "Karim");
    const ea = await prisma.employee.create({
      data: { fullName: `Assia ${TAG}Benali`, userId: assia.id, position: "Pharmacienne", baseSalary: 185000, netToPay: 152340, iban: "DZ5900400174401234567890" },
    });
    employeAssia = ea.id;
    const ek = await prisma.employee.create({ data: { fullName: `Karim ${TAG}Haddad`, userId: karim.id, position: "Délégué", baseSalary: 120000 } });
    const blob = await putBlob(Buffer.from("CONTRAT DE TRAVAIL\nArticle 5 — Rémunération : le salarié percevra un salaire mensuel brut de 185 000 DA (cent quatre-vingt-cinq mille dinars).\n", "utf8"));
    contratAssia = (await prisma.employeeDocument.create({ data: { employeeId: ea.id, category: "CONTRACT", name: "Contrat Assia.txt", blobId: blob.blobId, mime: "text/plain", size: 120 } })).id;
    contratKarim = (await prisma.employeeDocument.create({ data: { employeeId: ek.id, category: "CONTRACT", name: "Contrat Karim.txt", blobId: blob.blobId, mime: "text/plain", size: 120 } })).id;
  });
  afterEach(() => { remplacerModelesPourTests(null); });
  afterAll(async () => {
    const ids = [superAdmin, kam, assia, karim].filter(Boolean).map((u) => u.id);
    await effacerJournalDe(ids);
    await prisma.employeeDocument.deleteMany({ where: { employee: { fullName: { contains: TAG } } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { contains: TAG } } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  const outil = (u: CurrentUser, nom: string, coffret?: CoffretDuTour, props: PropositionPreparee[] = []) => {
    const o = outilsV1(u, props, [], [], coffret).find((t) => t.def.name === nom);
    if (!o) throw new Error(`outil ${nom} absent pour ${u.role}`);
    return o;
  };

  it("le Super Admin a les lectures RH, la paie, les documents, et les écritures métier (dossier réglementaire, RH…)", () => {
    const noms = outilsV1(superAdmin, []).map((o) => o.def.name);
    for (const n of ["lire_fiche_rh", "lire_paie", "documents_rh", "read_hr_overview", "search_everything", "regulatory_operation", "hr_operation", "create_hr_request", "create_task"]) {
      expect(noms, n).toContain(n);
    }
    expect(noms).not.toContain("read_payroll");
    expect(noms).not.toContain("read_employee");
    expect(new Set(noms).size).toBe(noms.length);
  });

  it("un KAM n'a pas l'outil de création de dossier réglementaire (aucune op ne lui est ouverte)", () => {
    const noms = outilsV1(kam, []).map((o) => o.def.name);
    expect(noms).not.toContain("regulatory_operation");
    expect(noms).toContain("lire_paie"); // offert pour SA paie ; la paie d'autrui est refusée à l'exécution
  });

  it("« crée un nouveau dossier pour daclatasvir » : le Super Admin obtient une CARTE, rien n'est créé", async () => {
    const props: PropositionPreparee[] = [];
    const avant = await prisma.regulatoryProduct.count();
    const s = await outil(superAdmin, "regulatory_operation", undefined, props).run({ op: "create_product", dci: "Daclatasvir", entity: "Adventum" }, superAdmin);
    expect(await prisma.regulatoryProduct.count()).toBe(avant);
    // Selon la base semée, l'entité peut manquer : la proposition le dit ; sinon la carte est préparée.
    const o = JSON.parse(s);
    expect(["EN_ATTENTE_DE_CONFIRMATION", "REFUS"]).toContain(o.statut);
    if (o.statut === "EN_ATTENTE_DE_CONFIRMATION") expect(props).toHaveLength(1);
    else expect(o.raison).not.toMatch(/droit/i);
  });

  it("la paie d'Assia : le Super Admin reçoit des REPÈRES (jamais la valeur) ; un KAM est refusé", async () => {
    const c = new CoffretDuTour();
    const s = await outil(superAdmin, "lire_paie", c).run({ nom: `Assia ${TAG}Benali` }, superAdmin);
    expect(s).not.toMatch(/185|152/);
    expect(JSON.parse(s).ficheActuelle.salaireBase).toMatch(/^⟦S\d+⟧$/);
    const refuse = JSON.parse(await outil(kam, "lire_paie", new CoffretDuTour()).run({ nom: `Assia ${TAG}Benali` }, kam));
    expect(refuse).toEqual({ statut: "REFUS", raison: REFUS_PAIE_AUTRUI });
    expect(JSON.parse(await outil(kam, "lire_fiche_rh").run({ nom: `Assia ${TAG}Benali` }, kam))).toEqual({ statut: "REFUS", raison: REFUS_FICHE });
  });

  it("la règle revérifiée À L'EXÉCUTION : l'outil du Super Admin, appelé sous un KAM, refuse", async () => {
    const r = JSON.parse(await outil(superAdmin, "lire_paie", new CoffretDuTour()).run({ nom: `Assia ${TAG}Benali` }, kam));
    expect(r.statut).toBe("REFUS");
  });

  it("le contrat : le Super Admin a le lien et la lecture (montants en repères) ; Assia le sien ; Karim pas celui d'Assia", async () => {
    const liste = json(await outil(superAdmin, "documents_rh").run({ nom: `Assia ${TAG}Benali`, nature: "contrat" }, superAdmin));
    expect(liste.documents).toEqual([expect.objectContaining({ documentId: contratAssia, lien: `/api/rh/document/${contratAssia}?dl=1`, nature: "Contrat de travail" })]);
    const c = new CoffretDuTour();
    const lu = json(await outil(superAdmin, "documents_rh", c).run({ documentId: contratAssia, lire: true }, superAdmin));
    expect(lu.lu).toBe(true);
    expect(lu.contenu).toMatch(/Article 5/);
    expect(lu.contenu).not.toMatch(/185 000|quatre-vingt/);
    expect(json(await outil(assia, "documents_rh").run({ nom: "moi" }, assia)).documents).toHaveLength(1);
    expect(json(await outil(karim, "documents_rh").run({ nom: `Assia ${TAG}Benali` }, karim))).toEqual({ statut: "REFUS", raison: REFUS_DOCUMENTS_AUTRUI });
    expect(json(await outil(karim, "documents_rh", new CoffretDuTour()).run({ documentId: contratAssia, lire: true }, karim)).statut).toBe("REFUS");
    expect(json(await outil(karim, "documents_rh", new CoffretDuTour()).run({ documentId: contratKarim, lire: true }, karim)).lu).toBe(true);
  });

  it("la révélation : le Super Admin voit, Assia voit le sien, un KAM voit « [confidentiel] » ; un repère inconnu aussi", async () => {
    const c = new CoffretDuTour();
    const j = c.jeton({ valeur: "185 000 DZD", nature: "SALAIRE", titulaireUserId: assia.id, origine: { modele: "Employee", id: employeAssia, champ: "baseSalary", brut: "185000" } });
    const phrase = `Salaire de base : ${j}. Autre : ⟦S7⟧.`;
    expect(await new Revelateur(c, superAdmin).texte(phrase)).toBe(`Salaire de base : ${BORNE_REVELEE}185 000 DZD${BORNE_REVELEE}. Autre : ${MASQUE_CONFIDENTIEL}.`);
    expect(chiffres(await new Revelateur(c, assia).texte(phrase))).toContain("185000DZD");
    expect(await new Revelateur(c, kam).texte(phrase)).toBe(`Salaire de base : ${MASQUE_CONFIDENTIEL}. Autre : ${MASQUE_CONFIDENTIEL}.`);
  });

  it("la masse salariale de la situation RH : un repère pour qui gère les RH, absente sinon", () => {
    const sortie = JSON.stringify({ effectif: 12, masseSalarialeDzd: 2400000, parEntite: [{ entite: "Adventum", masseSalarialeDzd: 1200000 }] });
    const c = new CoffretDuTour();
    expect(situationRhSansMasse(sortie, superAdmin, c)).not.toMatch(/2400000|1200000/);
    expect(JSON.parse(situationRhSansMasse(sortie, superAdmin, c)).masseSalarialeDzd).toMatch(/^⟦S\d+⟧$/);
    expect(JSON.parse(situationRhSansMasse(sortie, kam, c))).toEqual({ effectif: 12, parEntite: [{ entite: "Adventum" }] });
  });

  it("UN TOUR ENTIER — « c'est quoi le salaire d'Assia ? » : le modèle ne reçoit jamais la valeur, le Super Admin la lit", async () => {
    const scenario = [
      { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } },
      reponse("Le salaire de base d'Assia est de ⟦S1⟧, son net à payer ⟦S2⟧."),
    ];
    const f = modeleFactice(scenario);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(superAdmin, { texte: `C'est quoi le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(chiffres(r.content)).toContain("185000DZD");
    expect(chiffres(r.content)).toContain("152340DZD");
    const recu = JSON.stringify(f.promptsRecus);
    expect(recu).not.toMatch(/185[\s  .]?000|152[\s  .]?340|185000|152340/);
    expect(recu).toContain("⟦S1⟧");

    // Le tour suivant : la réponse affichée revient dans l'historique — la valeur, elle, ne repart pas.
    const g = modeleFactice([reponse("C'est noté.")]);
    remplacerModelesPourTests([g.modele as never]);
    await jouerTour(superAdmin, { texte: "Merci.", pieces: [], historique: [{ role: "user", content: "Le salaire d'Assia ?" }, { role: "assistant", content: r.content }] });
    expect(JSON.stringify(g.promptsRecus)).not.toMatch(/185[\s  .]?000|152[\s  .]?340/);
  });

  it("UN TOUR ENTIER — le même scénario sous un KAM : la paie est refusée, le repère s'affiche « [confidentiel] »", async () => {
    const f = modeleFactice([
      { appel: { outil: "lire_paie", entree: { nom: `Assia ${TAG}Benali` } } },
      reponse("Réponse : ⟦S1⟧."),
    ]);
    remplacerModelesPourTests([f.modele as never]);
    const r = await jouerTour(kam, { texte: `C'est quoi le salaire d'Assia ${TAG}Benali ?`, pieces: [], historique: [] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toBe(`Réponse : ${MASQUE_CONFIDENTIEL}.`);
    expect(JSON.stringify(f.promptsRecus)).toContain(REFUS_PAIE_AUTRUI.slice(0, 40));
  });
});
