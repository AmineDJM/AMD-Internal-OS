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
let ACTEUR: unknown = null;
vi.mock("@/lib/session", async (original) => ({ ...(await original<typeof import("@/lib/session")>()), requireUser: async () => ACTEUR, getCurrentUser: async () => ACTEUR }));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { putBlob } from "@/lib/drive-storage";
import { remplacerModelesPourTests } from "@/lib/agent/generer";
import { modeleFactice } from "@/lib/agent/testing/modele-factice";
import { effacerJournalDe } from "@/lib/agent/testing/journal";
import { filtrerSaisie, jouerTour, Revelateur } from "@/lib/agent/fil/tour";
import { outilsV1, situationRhSansMasse, type PropositionPreparee } from "@/lib/agent/outils-v1";
import { REFUS_PAIE_AUTRUI } from "@/lib/agent/lectures";
import { accesAssistantIa } from "@/lib/agent/role-config";
import { FAMILLES_IA, refusFamille, resoudreAccesIa, type FamilleIa } from "@/lib/agent/acces-regles";
import { enregistrerAccesAssistantIa } from "@/lib/actions/assistant-ia-consommation-actions";
import { confirmerIntentionAssistantIA } from "@/lib/actions/assistant-actions";
import { consigneFamilles } from "@/lib/agent/acces-regles";
import { GET as telechargerDocumentRh } from "@/app/api/rh/document/[id]/route";
import { NextRequest } from "next/server";
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

describe("les familles réglées par la Direction (pur)", () => {
  const tout = Object.fromEntries(FAMILLES_IA.map((f) => [f, true])) as Record<FamilleIa, boolean>;
  it("le Super Admin a tout, quels que soient les réglages", () => {
    expect(resoudreAccesIa({ superAdmin: true, droits: tout, personne: { ouvertes: [], fermees: [...FAMILLES_IA] } }).ouvertes).toEqual([...FAMILLES_IA]);
  });
  it("défaut : les droits applicatifs, salaires et contrats FERMÉS même pour qui gère les RH", () => {
    const a = resoudreAccesIa({ superAdmin: false, droits: { ...tout, BUDGETS: false } });
    expect(a.ouvertes).not.toContain("SALAIRES");
    expect(a.ouvertes).not.toContain("CONTRATS_RH");
    expect(a.ouvertes).not.toContain("BUDGETS");
    expect(a.ouvertes).toContain("FICHES");
    expect(a.explicites).toEqual([]);
  });
  it("le rôle pose le défaut, la personne prime ; ouvrir explicitement va au-delà des droits", () => {
    const sans = Object.fromEntries(FAMILLES_IA.map((f) => [f, false])) as Record<FamilleIa, boolean>;
    const a = resoudreAccesIa({ superAdmin: false, droits: sans, role: { ouvertes: ["SALAIRES", "BUDGETS"], fermees: [] }, personne: { ouvertes: [], fermees: ["BUDGETS"] } });
    expect(a.ouvertes).toEqual(["SALAIRES"]);
    expect(a.explicites).toEqual(["SALAIRES"]);
  });
});

suite("contre la base, au faux modèle", () => {
  let superAdmin: CurrentUser;
  let kam: CurrentUser;
  let assia: CurrentUser;
  let karim: CurrentUser;
  let assistante: CurrentUser;
  let autreAssistante: CurrentUser;
  let lecteur: CurrentUser;
  let voisin: CurrentUser;
  let employeAssia = "";
  let contratKarim = "";
  let contratAssia = "";

  const session2 = async (u: CurrentUser): Promise<CurrentUser> => {
    const access = await getAccess(u.id, u.role);
    return { ...u, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access } as CurrentUser;
  };
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
    assistante = await session("DIRECTION_ASSISTANT", "Samia");
    autreAssistante = await session("DIRECTION_ASSISTANT", "Nadia");
    // Deux lecteurs SANS Drive ni Documents dans l'application : chaque famille testée est au-delà de leurs droits.
    const sansDrive = async (role: string, nom: string) => {
      const u = await session(role, nom);
      await prisma.userAccess.createMany({ data: ["DRIVE", "DOCUMENTS"].map((module) => ({ userId: u.id, module, canView: false })) });
      return session2(u);
    };
    lecteur = await sansDrive("VIEWER", "Leila");
    voisin = await sansDrive("VIEWER", "Lyes");
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
    const ids = [superAdmin, kam, assia, karim, assistante, autreAssistante, lecteur, voisin].filter(Boolean).map((u) => u.id);
    await prisma.accesDonneeSensible.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.message.deleteMany({ where: { senderId: { in: ids } } }).catch(() => {});
    await prisma.userAccess.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.assistantIaAcces.deleteMany({ where: { userId: { in: ids } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: ids } } }).catch(() => {});
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
    // La famille d'abord : « Salaires & paie » est fermée au KAM — le refus le dit, et qui l'ouvre.
    expect(refuse).toEqual({ statut: "REFUS", raison: refusFamille("SALAIRES") });
    expect(JSON.parse(await outil(kam, "lire_fiche_rh").run({ nom: `Assia ${TAG}Benali` }, kam)).statut).toBe("REFUS");
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
    expect(json(await outil(karim, "documents_rh").run({ nom: `Assia ${TAG}Benali` }, karim))).toEqual({ statut: "REFUS", raison: refusFamille("CONTRATS_RH") });
    expect(json(await outil(karim, "documents_rh", new CoffretDuTour()).run({ documentId: contratAssia, lire: true }, karim)).statut).toBe("REFUS");
    expect(json(await outil(karim, "documents_rh", new CoffretDuTour()).run({ documentId: contratKarim, lire: true }, karim)).lu).toBe(true);
  });

  it("la révélation : le Super Admin voit, Assia voit le sien, un KAM voit « [confidentiel] » ; un repère inconnu aussi", async () => {
    const c = new CoffretDuTour();
    const j = c.jeton({ valeur: "185 000 DZD", nature: "SALAIRE", titulaireUserId: assia.id, origine: { modele: "Employee", id: employeAssia, champ: "baseSalary", brut: "185000" } });
    const phrase = `Salaire de base : ${j}. Autre : ⟦S7⟧.`;
    const r = async (u: CurrentUser) => new Revelateur(c, u, await accesAssistantIa(u)).texte(phrase);
    expect(await r(superAdmin)).toBe(`Salaire de base : ${BORNE_REVELEE}185 000 DZD${BORNE_REVELEE}. Autre : ${MASQUE_CONFIDENTIEL}.`);
    expect(chiffres(await r(assia))).toContain("185000DZD");
    expect(await r(kam)).toBe(`Salaire de base : ${MASQUE_CONFIDENTIEL}. Autre : ${MASQUE_CONFIDENTIEL}.`);
  });

  it("la masse salariale de la situation RH : un repère pour qui gère les RH, absente sinon", async () => {
    const sortie = JSON.stringify({ effectif: 12, masseSalarialeDzd: 2400000, parEntite: [{ entite: "Adventum", masseSalarialeDzd: 1200000 }] });
    const c = new CoffretDuTour();
    expect(situationRhSansMasse(sortie, superAdmin, c, await accesAssistantIa(superAdmin))).not.toMatch(/2400000|1200000/);
    expect(JSON.parse(situationRhSansMasse(sortie, superAdmin, c, await accesAssistantIa(superAdmin))).masseSalarialeDzd).toMatch(/^⟦S\d+⟧$/);
    expect(JSON.parse(situationRhSansMasse(sortie, kam, c, await accesAssistantIa(kam)))).toEqual({ effectif: 12, parEntite: [{ entite: "Adventum" }] });
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
    expect(JSON.stringify(f.promptsRecus)).toContain("Salaires & paie");
    expect(REFUS_PAIE_AUTRUI).toMatch(/gère les RH/);
  });

  it("L'ASSISTANTE DE DIRECTION : refusée sur salaire et contrat par défaut, autorisée après ouverture dans la console — elle seule", async () => {
    const paie = async (u: CurrentUser, c = new CoffretDuTour()) =>
      JSON.parse(await outilsV1(u, [], [], [], c, await accesAssistantIa(u)).find((o) => o.def.name === "lire_paie")!.run({ nom: `Assia ${TAG}Benali` }, u));
    const docs = async (u: CurrentUser) =>
      json(await outilsV1(u, [], [], [], new CoffretDuTour(), await accesAssistantIa(u)).find((o) => o.def.name === "documents_rh")!.run({ nom: `Assia ${TAG}Benali` }, u));

    expect(await paie(assistante)).toEqual({ statut: "REFUS", raison: refusFamille("SALAIRES") });
    expect(await docs(assistante)).toEqual({ statut: "REFUS", raison: refusFamille("CONTRATS_RH") });

    // La Direction ouvre les deux familles à Samia, dans la console (action du Super Admin, journalisée).
    ACTEUR = superAdmin;
    const fd = new FormData();
    fd.set("cible", `user:${assistante.id}`);
    fd.set("ouvertes", "SALAIRES,CONTRATS_RH");
    expect(await enregistrerAccesAssistantIa(fd)).toEqual({ ok: true });
    expect(await prisma.auditLog.count({ where: { actorId: superAdmin.id, field: "Assistant IA — accès", summary: { contains: "Samia" } } })).toBe(1);

    const c = new CoffretDuTour();
    const lu = await paie(assistante, c);
    expect(lu.ficheActuelle.salaireBase).toMatch(/^⟦S\d+⟧$/);
    const vu = await new Revelateur(c, assistante, await accesAssistantIa(assistante)).texte(lu.ficheActuelle.salaireBase);
    expect(chiffres(vu)).toContain("185000DZD");
    expect((await docs(assistante)).documents).toHaveLength(1);

    // Le réglage ne vaut que pour elle : Nadia, même rôle, reste au défaut.
    expect(await paie(autreAssistante)).toEqual({ statut: "REFUS", raison: refusFamille("SALAIRES") });

    // Un non-Super-Admin ne règle rien.
    ACTEUR = assistante;
    expect((await enregistrerAccesAssistantIa(fd)).ok).toBe(false);
  });

  it("le Super Admin voit tout, même si un réglage tentait de le fermer", async () => {
    ACTEUR = superAdmin;
    const fd = new FormData();
    fd.set("cible", `user:${superAdmin.id}`);
    fd.set("fermees", "SALAIRES");
    expect((await enregistrerAccesAssistantIa(fd)).ok).toBe(false);
    expect((await accesAssistantIa(superAdmin)).ouvertes).toEqual([...FAMILLES_IA]);
  });

  it("BUDGETS, DRIVE, RÉGLEMENTAIRE, AD & PRO : fermées par défaut (au-delà des droits) → refus ; ouvertes dans la console → l'outil lit ; seule la personne visée", async () => {
    const CAS: [FamilleIa, string, Record<string, unknown>][] = [
      ["BUDGETS", "read_budget", {}],
      ["DRIVE", "search_everything", { query: "contrat" }],
      ["REGLEMENTAIRE", "regulatory_portfolio", {}],
      ["AD_PRO", "read_workflow", { category: "SPONSORING" }],
    ];
    const lire = async (u: CurrentUser, nom: string, entree: Record<string, unknown>) => {
      const acces = await accesAssistantIa(u);
      const o = outilsV1(u, [], [], [], new CoffretDuTour(), acces).find((t) => t.def.name === nom);
      return o ? await o.run(entree, u) : null;
    };
    const fermee = (r: string | null, f: FamilleIa) => r === null || r.includes(JSON.stringify(refusFamille(f)).slice(1, 40));

    for (const [f, nom, entree] of CAS) {
      expect(fermee(await lire(lecteur, nom, entree), f), `${f} fermée par défaut`).toBe(true);
      expect(consigneFamilles(await accesAssistantIa(lecteur))).toContain(`FERMÉES :`);
    }

    ACTEUR = superAdmin;
    const fd = new FormData();
    fd.set("cible", `user:${lecteur.id}`);
    fd.set("ouvertes", "BUDGETS,DRIVE,REGLEMENTAIRE,AD_PRO");
    expect(await enregistrerAccesAssistantIa(fd)).toEqual({ ok: true });
    expect(await prisma.auditLog.count({ where: { actorId: superAdmin.id, field: "Assistant IA — accès", summary: { contains: "Leila" } } })).toBe(1);

    for (const [f, nom, entree] of CAS) {
      const r = await lire(lecteur, nom, entree);
      expect(r, `${f} ouverte : l'outil est offert`).not.toBeNull();
      expect(fermee(r, f), `${f} ouverte : pas de refus de famille`).toBe(false);
      expect(r!, `${f} ouverte : pas de refus de module`).not.toMatch(/ne vous est pas ouvert/);
      expect(fermee(await lire(voisin, nom, entree), f), `${f} : le voisin reste au défaut`).toBe(true);
    }
  });

  it("UN REPÈRE DANS UNE CARTE — « envoie le salaire d'Assia à Karim » : la carte porte la valeur, le modèle jamais ; refus sans droit ; rejugé à la confirmation ; tracé", async () => {
    // Le Super Admin lit la paie (repères), puis prépare un message qui CITE le repère.
    const c = new CoffretDuTour();
    const props: PropositionPreparee[] = [];
    const outils = outilsV1(superAdmin, props, [], [], c, await accesAssistantIa(superAdmin));
    const paie = JSON.parse(await outils.find((o) => o.def.name === "lire_paie")!.run({ nom: `Assia ${TAG}Benali` }, superAdmin));
    const j = paie.ficheActuelle.salaireBase as string;
    const sortie = await outils.find((o) => o.def.name === "send_message")!.run({ recipientName: `Karim ${TAG}`, body: `Le salaire de base d'Assia est de ${j}.` }, superAdmin);
    expect(chiffres(sortie)).not.toContain("185000");
    expect(sortie).toContain(j);
    expect(props).toHaveLength(1);
    const intent = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: props[0]!.intentId } });
    expect(chiffres(JSON.stringify(intent.payload))).toContain("185000DZD");
    expect((intent.payload as { reperesSubstitues?: unknown[] }).reperesSubstitues).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { actorId: superAdmin.id, summary: { contains: "insérée dans la carte" } } })).toBe(1);

    // La confirmation par la même personne exécute — et trace l'usage à l'exécution.
    ACTEUR = superAdmin;
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r.ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { actorId: superAdmin.id, summary: { contains: "utilisée à l'exécution" } } })).toBe(1);

    // Un KAM, dont « Salaires & paie » est fermée, ne peut pas glisser le même repère dans une carte.
    const props2: PropositionPreparee[] = [];
    const ck = new CoffretDuTour();
    ck.jeton(c.entree(1)!);
    const refuse = JSON.parse(await outilsV1(kam, props2, [], [], ck, await accesAssistantIa(kam)).find((o) => o.def.name === "send_message")!
      .run({ recipientName: `Karim ${TAG}`, body: "Salaire : ⟦S1⟧" }, kam));
    expect(refuse.statut).toBe("REFUS");
    expect(props2).toHaveLength(0);
  });

  it("une carte porteuse d'une valeur dont la famille a été FERMÉE entre-temps ne s'exécute pas", async () => {
    // Samia a « Salaires & paie » ouverte (test précédent) : elle prépare, puis la Direction referme, puis elle confirme.
    const c = new CoffretDuTour();
    const props: PropositionPreparee[] = [];
    const outils = outilsV1(assistante, props, [], [], c, await accesAssistantIa(assistante));
    const paie = JSON.parse(await outils.find((o) => o.def.name === "lire_paie")!.run({ nom: `Assia ${TAG}Benali` }, assistante));
    await outils.find((o) => o.def.name === "create_task")!.run({ title: `Vérifier ${paie.ficheActuelle.salaireBase}`, assigneeName: `Karim ${TAG}` }, assistante);
    expect(props).toHaveLength(1);
    ACTEUR = superAdmin;
    const fd = new FormData();
    fd.set("cible", `user:${assistante.id}`);
    fd.set("fermees", "SALAIRES");
    expect(await enregistrerAccesAssistantIa(fd)).toEqual({ ok: true });
    await prisma.userAccess.create({ data: { userId: assistante.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    ACTEUR = await session2(assistante);
    const r = await confirmerIntentionAssistantIA(props[0]!.intentId);
    expect(r).toMatchObject({ ok: false });
    expect(r.error).toMatch(/plus le droit/);
  });

  it("TOUT EST TRACÉ : une valeur hors colonne du coffre (historique de paie, contrat) écrit une ligne au journal des accès, avec l'outil", async () => {
    const c = new CoffretDuTour();
    const acces = await accesAssistantIa(superAdmin);
    const outils = outilsV1(superAdmin, [], [], [], c, acces);
    const lu = json(await outils.find((o) => o.def.name === "documents_rh")!.run({ documentId: contratAssia, lire: true }, superAdmin));
    const repere = (lu.contenu as string).match(/⟦S\d+⟧/)![0];
    await new Revelateur(c, superAdmin, acces).texte(repere);
    const ligne = await prisma.accesDonneeSensible.findFirst({ where: { userId: superAdmin.id, origineModele: "EmployeeDocument", origineId: contratAssia } });
    expect(ligne).toMatchObject({ nature: "SALAIRE", autorise: true });
    expect(ligne!.geste).toContain("documents_rh");
    // Un refus se journalise aussi.
    await new Revelateur(c, kam, await accesAssistantIa(kam)).texte(repere);
    expect(await prisma.accesDonneeSensible.count({ where: { userId: kam.id, origineId: contratAssia, autorise: false } })).toBe(1);
  });

  it("« Contrats & documents RH » ouverte → la route sert le fichier ; fermée → 403 ; seulement la personne visée", async () => {
    const req = () => new NextRequest(`http://localhost/api/rh/document/${contratAssia}?dl=1`);
    const servir = async (u: CurrentUser) => { ACTEUR = u; return (await telechargerDocumentRh(req(), { params: Promise.resolve({ id: contratAssia }) })).status; };
    expect(await servir(karim)).toBe(403);
    expect(await servir(autreAssistante)).toBe(403);
    ACTEUR = superAdmin;
    const fd = new FormData();
    fd.set("cible", `user:${autreAssistante.id}`);
    fd.set("ouvertes", "CONTRATS_RH");
    expect(await enregistrerAccesAssistantIa(fd)).toEqual({ ok: true });
    expect(await servir(autreAssistante)).toBe(200);
    expect(await servir(karim)).toBe(403);
    expect(await servir(superAdmin)).toBe(200);
  });
});
