import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { CONTRATS_ACTIONS } from "@/lib/actions/contrat.genere";
import { PORTES_DU_GESTE } from "./portes";
import { contratVuParLAssistantIa, GESTES_DE_FICHE, interdictionDeLAssistantIa, interdictionGenerique } from "@/lib/actions/generique";
import { classerGeste } from "@/lib/annulation/reversibilite";
import { MODULE_LABELS } from "@/lib/labels";
import { ACTIONS_GESTE } from "@/platform/ia/artifact/atelier/gestes";
import { deriverRegistre, ficheDeLOutil, nomOutilDe, schemaDe, zodDe } from "./registre";
import { CHEMIN_CLICHE, clicheDuRegistre, type LigneCliche } from "./cliche";
import { ANNULATIONS, RISQUES, SIMULABLES } from "./types";
import { FAMILLES_IA } from "./familles";
import { libelleDeFonction } from "./lexique";

/**
 * LE REGISTRE DES CAPACITÉS (lot J6, décision 0020) — 100 % des actions du contrat classées, et rien d'appelable qui
 * ne doive pas l'être. Le cliché (`classement.genere.json`) est la revue : une action nouvelle du contrat qui n'y est
 * pas fait échouer ce test (`npm run capacites:classement`, puis relire le diff).
 */
const registre = deriverRegistre(CONTRATS_ACTIONS.map(contratVuParLAssistantIa), { interdiction: interdictionDeLAssistantIa, classerGeste, modules: MODULE_LABELS });
const actions = registre.capacites.filter((c) => c.source === "action");
const de = (id: string) => registre.parId.get(id)!;

describe("registre des capacités — chaque action du contrat a sa fiche, classée", () => {
  it("une fiche par action du contrat, et seulement elles", () => {
    expect(actions.map((c) => c.id).sort()).toEqual(CONTRATS_ACTIONS.map((c) => c.id).sort());
  });

  it("100 % classées : risque, familles, simulable, annulation — des valeurs connues, jamais vides", () => {
    for (const c of actions) {
      expect(RISQUES, c.id).toContain(c.risque);
      expect(SIMULABLES, c.id).toContain(c.simulable);
      expect(ANNULATIONS, c.id).toContain(c.annulation);
      for (const f of c.familles) expect(FAMILLES_IA, c.id).toContain(f);
      expect(c.raisonRisque.length, c.id).toBeGreaterThan(5);
      expect(c.libelle.length, c.id).toBeGreaterThan(2);
      // Un geste exige « Écritures métier » ; une lecture ne l'exige pas.
      expect(c.familles.includes("ECRITURES"), c.id).toBe(c.risque !== "R0");
    }
  });

  it("LE CLICHÉ RELU recouvre exactement la dérivation — une action nouvelle non classée fait échouer", () => {
    const relu = JSON.parse(fs.readFileSync(CHEMIN_CLICHE, "utf8")) as Record<string, LigneCliche>;
    const derive = clicheDuRegistre(registre);
    const nonClassees = Object.keys(derive).filter((id) => !(id in relu));
    expect(nonClassees, "actions du contrat absentes du cliché : `npm run capacites:classement`, puis relire leur classement").toEqual([]);
    const disparues = Object.keys(relu).filter((id) => !(id in derive));
    expect(disparues, "actions du cliché disparues du contrat : `npm run capacites:classement`").toEqual([]);
    const changees = Object.keys(derive).filter((id) => JSON.stringify(derive[id]) !== JSON.stringify(relu[id]));
    expect(changees, "classement changé sans revue : `npm run capacites:classement`, puis relire le diff").toEqual([]);
  });
});

describe("jamais appelable génériquement", () => {
  it("une action `illisible` ne l'est jamais", () => {
    const illisibles = CONTRATS_ACTIONS.filter((c) => c.illisible);
    expect(illisibles.length).toBeGreaterThan(0);
    for (const c of illisibles) expect(de(c.id).appelable, c.id).toBe(false);
  });

  it("le refus d'auto-escalade et des attestations (generique.ts) est repris tel quel — sauf les gestes de fiche, sans leur champ de compte", () => {
    for (const c of CONTRATS_ACTIONS) if (interdictionGenerique(c) && !Object.hasOwn(GESTES_DE_FICHE, c.id)) expect(de(c.id).appelable, c.id).toBe(false);
    expect(Object.keys(GESTES_DE_FICHE).sort()).toEqual(["hr-actions:createEmployee", "hr-actions:setEmployeeActive", "hr-actions:updateEmployee"]);
    for (const id of Object.keys(GESTES_DE_FICHE)) {
      expect(de(id).appelable, id).toBe(true);
      expect(de(id).champs.map((ch) => ch.nom), id).not.toContain("userId");
    }
    expect(de("bc-signature-actions:signerBonDeCommande").appelable).toBe(false);
    expect(de("access-actions:adminResetPassword").appelable).toBe(false);
  });

  it("l'Assistant IA ne confirme pas ses propres cartes, ne touche ni Adam ni la connexion ni la « Vue exacte »", () => {
    for (const id of ["assistant-ia-actions:confirmerIntentionAssistantIA", "assistant-ia-actions:approuverMonTravail", "impersonation-actions:startImpersonation", "auth-actions:authenticate"]) {
      expect(de(id).appelable, id).toBe(false);
    }
    for (const c of actions.filter((x) => /^(assistant-|adam-|auth-|impersonation-)/.test(x.id))) expect(c.appelable, c.id).toBe(false);
  });

  it("une action qui exige un FICHIER binaire se fait à l'écran ; un fichier facultatif n'empêche pas l'appel", () => {
    // Le fichier qui EST l'objet du geste (déposer, importer, lire…) : sans octets, l'action n'a rien à faire.
    const fichier = actions.filter((c) => /^(upload|import|scan|parse|extract|analy)/.test(c.id.split(":")[1]!)
      && CONTRATS_ACTIONS.find((x) => x.id === c.id)!.champs.some((ch) => /^(file|fichier|scan|attachment)$/.test(ch.nom)));
    expect(fichier.length).toBeGreaterThan(5);
    for (const c of fichier) expect(c.appelable, c.id).toBe(false);
    expect(de("document-actions:uploadDocument").appelable).toBe(false);
    // La demande de BV : la pièce est facultative — Adam l'appelait sans elle, l'Assistant IA aussi.
    expect(de("regulatory-actions:requestBV").appelable).toBe(true);
    expect(de("regulatory-actions:requestBV").champs.map((ch) => ch.nom)).not.toContain("file");
  });
});

describe("les portes nommées geste par geste (`PORTES_DU_GESTE`, décision 0020 § 8)", () => {
  it("chaque geste nommé existe au contrat, reste appelable et prend la porte de l'espace où il se fait", () => {
    for (const [id, porte] of Object.entries(PORTES_DU_GESTE)) {
      const c = de(id);
      expect(c, id).toBeTruthy();
      expect(c.appelable, `${id} : ${c.refus}`).toBe(true);
      expect(c.modules, id).toEqual(porte.modules);
      expect(c.superAdminSeul, id).toBe(false);
    }
    // Le reste de la corbeille d'administration reste fermé.
    expect(de("admin-delete-actions:superAdminDelete").appelable).toBe(false);
    expect(de("admin-delete-actions:destroyDeletedRecord").appelable).toBe(false);
  });
});

describe("le niveau de risque se lit sur les faits du contrat", () => {
  it("lecture, écriture, notification, effet externe, argent, décision, suppression", () => {
    expect(de("regulatory-actions:checkDciDuplicate").risque).toBe("R0");
    expect(de("task-actions:startTask").risque).toBe("R1");
    expect(de("task-actions:createTask").risque).toBe("R2");
    expect(de("messaging-actions:sendMessage").risque).toBe("R2");
    expect(de("microsoft-mail-actions:saveDraft").risque).toBe("R3");
    expect(de("task-actions:deleteTask").risque).toBe("R4");
    expect(de("expense-actions:purgeSettledExpenseOrders").risque).toBe("R4");
    expect(de("directive-actions:publishDirective").risque).toBe("R3");
  });

  it("une lecture est simulable et sans annulation ; un effet hors base et hors ports ne se simule pas (J7)", () => {
    expect(de("regulatory-actions:checkDciDuplicate")).toMatchObject({ simulable: "oui", annulation: "aucune" });
    // La boîte IMAP s'écrit hors de la base et hors des ports : non. Un brouillon Graph sans écriture lue : non prouvé.
    expect(de("mail-folder-actions:moveMailEntries").simulable).toBe("non");
    expect(de("microsoft-mail-actions:saveDraft").simulable).toBe("inconnu");
    // Une notification (sa poussée passe par un port) et une écriture en base : simulables.
    expect(de("task-actions:createTask").simulable).toBe("oui");
    expect(de("task-actions:updateTaskStatus").annulation).toBe("retour");
    expect(de("task-actions:deleteTask").annulation).toBe("compensation");
  });

  it("les familles de la console suivent le métier de l'action", () => {
    expect(de("regulatory-actions:checkDciDuplicate").familles).toEqual(["REGLEMENTAIRE"]);
    expect(de("payroll-hr-actions:deletePayrollEntry")?.familles ?? ["SALAIRES", "ECRITURES"]).toContain("SALAIRES");
    expect(de("drive-actions:moveNodes").familles).toEqual(["DRIVE", "ECRITURES"]);
    expect(de("task-actions:createTask").familles).toEqual(["ECRITURES"]);
  });
});

describe("la fiche est lisible et appelable", () => {
  it("un nom d'outil valide (≤ 64, `[a-zA-Z0-9_-]`), unique", () => {
    const noms = actions.map((c) => c.outil);
    for (const n of noms) expect(n, n).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    expect(new Set(noms).size).toBe(noms.length);
    expect(nomOutilDe("task-actions:createTask")).toBe("task__createTask");
  });

  it("un libellé en français, tiré du nom", () => {
    expect(libelleDeFonction("createTask")).toBe("Créer tâche");
    expect(libelleDeFonction("updateRegulatoryProduct")).toBe("Modifier produit réglementaire");
    expect(libelleDeFonction("enregistrerDevisPromo")).toBe("Enregistrer devis promotionnel");
  });

  it("le schéma d'entrée vient des champs du contrat — obligatoires compris — et zod le tient", () => {
    const cap = de("task-actions:createTask");
    const contrat = CONTRATS_ACTIONS.find((c) => c.id === cap.id)!;
    const s = schemaDe(cap);
    expect(Object.keys(s.properties ?? {}).sort()).toEqual(contrat.champs.map((c) => c.nom).filter((n) => !/^(file|files)$/.test(n)).sort());
    expect(s.required).toEqual(contrat.champs.filter((c) => c.obligatoire).map((c) => c.nom));
    const z = zodDe(cap);
    expect(z.safeParse({}).success).toBe(contrat.champs.every((c) => !c.obligatoire));
    expect(z.safeParse({ inconnu: 1, ...Object.fromEntries(contrat.champs.filter((c) => c.obligatoire).map((c) => [c.nom, "x"])) }).success).toBe(false);
  });

  it("les commandes de l'Atelier sont au registre, exécutées par `modifier_document`", () => {
    const atelier = registre.capacites.filter((c) => c.source === "atelier");
    expect(atelier.map((c) => c.id.replace("atelier:", "")).sort()).toEqual([...ACTIONS_GESTE].sort());
    for (const c of atelier) expect(c).toMatchObject({ executeePar: "modifier_document", annulation: "delegation", familles: ["DRIVE"] });
  });

  it("un outil de l'Assistant IA y entre avec son nom et son risque (lecture R0, geste R1/R2)", () => {
    expect(ficheDeLOutil({ nom: "lire_paie", libelle: "Paie consultée", description: "…", ecriture: false, familles: ["SALAIRES"] })).toMatchObject({ risque: "R0", familles: ["SALAIRES"], outil: "lire_paie" });
    expect(ficheDeLOutil({ nom: "preparer_relance", libelle: "Relance", description: "…", ecriture: true, familles: [] })).toMatchObject({ risque: "R2", familles: ["ECRITURES"] });
  });
});

describe("J7 (décision 0029) — la simulation couvre l'essentiel des écritures internes", () => {
  it("≥ 80 % des capacités R1–R2 sont simulables (mesure sur le classement) ; les autres le disent", () => {
    const cliche = JSON.parse(fs.readFileSync(CHEMIN_CLICHE, "utf8")) as Record<string, LigneCliche>;
    const internes = Object.values(cliche).filter((l) => l.risque === "R1" || l.risque === "R2");
    const simulables = internes.filter((l) => l.simulable === "oui").length;
    const part = simulables / internes.length;
    console.info(`[J7] capacités R1–R2 simulables : ${simulables}/${internes.length} (${(part * 100).toFixed(1)} %)`);
    expect(internes.length).toBeGreaterThan(500);
    expect(part).toBeGreaterThanOrEqual(0.8);
  });
});
