import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess, type SessionUser } from "@/lib/rbac";
import { createEvent, updateEvent } from "./actions-evenements";
import { CHAMPS_MEDECINS, CHAMPS_PRODUITS, MULTI_SEP } from "./domaine/pickers";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__evtoblig__";

async function actorFor(id: string, role: SessionUser["role"]): Promise<CurrentUser> {
  const access = await getAccess(id, role);
  const u = await prisma.user.findUniqueOrThrow({ where: { id } });
  return { id, name: u.name, email: u.email, role, access, mustChangePassword: false };
}

/** Un formulaire COMPLET — chaque cas en retire UNE chose et vérifie le refus. */
function complet(over: Record<string, string | string[]> = {}): FormData {
  const fd = new FormData();
  const base: Record<string, string> = {
    name: `${TAG}Symposium`, type: "CONGRESS", scope: "NATIONAL", format: "PRESENTIAL",
    startDate: "2027-03-01", endDate: "2027-03-02", location: "Hôtel Sheraton",
    city: "Alger", country: "Algérie", specialty: "Cardiologie",
    estimatedBudget: "450000", description: "Symposium annuel de cardiologie.",
  };
  for (const [k, v] of Object.entries(base)) if (!(k in over)) fd.set(k, v);
  for (const [k, v] of Object.entries(over)) {
    if (Array.isArray(v)) { for (const x of v) fd.append(k, x); }
    else if (v !== "") fd.set(k, v);
  }
  return fd;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « QUASI TOUT OBLIGATOIRE COMME SPONSORING » — tenu au SERVEUR, par la vraie action.
 *
 * Le formulaire marque `required`, et ce n'est PAS la garde : un champ de formulaire se forge, et
 * l'écran n'est pas la seule porte (le chemin générique d'Adam poste la même action). On appelle
 * donc `createEvent` et `updateEvent`, exactement ce que déclenche le bouton (§118.14).
 *
 * LE BUDGET EST LE CAS QUI COMPTE, et il ferme une SECONDE plainte : sans lui, le moteur lit un
 * montant de ZÉRO, refuse de franchir une porte de contrôle sur un montant inconnu (à juste
 * titre) et la porte du Directeur Général reste ouverte sous le seuil (§118.132, §118.142).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Un événement Ad & Pro — les champs que la Direction a rendus obligatoires", () => {
  let demandeurId = "", responsableId = "", gammeId = "";

  beforeAll(async () => {
    const [dem, resp] = await Promise.all([
      prisma.user.create({ data: { name: `${TAG}dem`, email: `${TAG}dem@t.dz`, role: "MEDICAL_DELEGATE", passwordHash: "x" } }),
      prisma.user.create({ data: { name: `${TAG}resp`, email: `${TAG}resp@t.dz`, role: "SALES_USER", passwordHash: "x" } }),
    ]);
    demandeurId = dem.id; responsableId = resp.id;
    const bu = await prisma.businessUnit.create({ data: { name: `${TAG}Onco`, isActive: true } });
    gammeId = bu.id;
    ACTOR = await actorFor(demandeurId, "SUPER_ADMIN");
  });

  afterAll(async () => {
    await prisma.event.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.businessUnit.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actorId: { in: [demandeurId, responsableId] } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    ACTOR = null;
  });

  it("une demande COMPLÈTE passe — sans quoi aucun des refus ci-dessous ne prouverait rien", () => {
    // LA PRÉMISSE. Si le décor complet était lui-même refusé, chaque cas suivant serait vrai pour
    // la mauvaise raison et la suite entière ne mesurerait plus rien (§118.104).
    return createEvent(complet({ responsibleId: responsableId, businessUnitId: gammeId, doctorIds: ["Dr Benali"], productIds: ["Nivolex (nivolumab)"] }))
      .then(async (r) => {
        expect(r.ok, r.ok === false ? r.error : "").toBe(true);
        const ev = await prisma.event.findFirstOrThrow({ where: { name: { startsWith: TAG } } });
        expect(Number(ev.estimatedBudget)).toBe(450000);
        expect(ev.doctor).toBe("Dr Benali");
        expect(ev.businessUnitId).toBe(gammeId);
      });
  });

  it("LE BUDGET est obligatoire — et zéro n'est pas un budget renseigné", async () => {
    // Ce qui le ferait tomber : accepter un budget absent ou nul. Le moteur lirait ZÉRO, la porte
    // du DG resterait ouverte sur un événement très en dessous du seuil, et personne ne saurait
    // pourquoi le Directeur Général a un dossier de 80 000 DZD sur son écran.
    for (const budget of ["", "0"]) {
      const r = await createEvent(complet({ estimatedBudget: budget, responsibleId: responsableId, doctorIds: ["Dr Benali"], productIds: ["Nivolex"] }));
      expect(r.ok, `budget « ${budget} »`).toBe(false);
      expect(r.ok === false ? r.error : "").toContain("budget estimé");
    }
  });

  it("MÉDECINS et PRODUITS sont obligatoires — en référentiel comme en saisie libre", async () => {
    const sansMedecin = await createEvent(complet({ responsibleId: responsableId, productIds: ["Nivolex"] }));
    expect(sansMedecin.ok).toBe(false);
    expect(sansMedecin.ok === false ? sansMedecin.error : "").toContain("médecins");
    const sansProduit = await createEvent(complet({ responsibleId: responsableId, doctorIds: ["Dr Benali"] }));
    expect(sansProduit.ok).toBe(false);
    expect(sansProduit.ok === false ? sansProduit.error : "").toContain("produits");
    // LE REPLI EN SAISIE LIBRE COMPTE AUTANT : un référentiel vide ne dispense pas de nommer le
    // praticien, il change seulement la façon de le nommer.
    // LES NOMS DE CHAMP VIENNENT DU MODULE, pas d'un littéral recopié : le repli du produit
    // s'appelait `products` (le nom de la COLONNE) et s'appelle désormais `product` partout, et
    // un juge qui redérive la forme de ce qu'il vérifie divergerait de sa source (§118.120).
    const libre = await createEvent(complet({
      name: `${TAG}Libre`, responsibleId: responsableId,
      [CHAMPS_MEDECINS.libre]: "Dr Hors Annuaire", [CHAMPS_PRODUITS.libre]: "Produit hors catalogue",
    }));
    expect(libre.ok, libre.ok === false ? libre.error : "").toBe(true);
  });

  it("PLUSIEURS médecins et PLUSIEURS produits, joints par le lecteur CANONIQUE", async () => {
    // Ce qui le ferait tomber : recopier ici une jointure à la main. Deux découpes finiraient par
    // diverger sur le séparateur, et « Dr A · Dr B » se relirait en un seul praticien (§118.116).
    const r = await createEvent(complet({
      name: `${TAG}Multi`, responsibleId: responsableId,
      doctorIds: ["Dr Benali", "Dr Cherif"], productIds: ["Nivolex", "Trastuzex"],
    }));
    expect(r.ok, r.ok === false ? r.error : "").toBe(true);
    const ev = await prisma.event.findFirstOrThrow({ where: { name: `${TAG}Multi` } });
    expect(ev.doctor).toBe(`Dr Benali${MULTI_SEP}Dr Cherif`);
    expect(ev.products).toBe(`Nivolex${MULTI_SEP}Trastuzex`);
  });

  it("le refus NOMME TOUT ce qui manque en une fois — pas un aller-retour par champ", async () => {
    // Quinze champs et un refus par champ, c'est quinze ressaisies du formulaire le plus long du
    // pôle (§118.18). Le nom est la seule exception, gardé à part pour le CONTRAT d'action.
    const fd = complet({
      type: "", format: "", city: "", specialty: "", estimatedBudget: "",
      responsibleId: "", doctorIds: ["Dr Benali"], productIds: ["Nivolex"],
    });
    const r = await createEvent(fd);
    expect(r.ok).toBe(false);
    const msg = r.ok === false ? (r.error ?? "") : "";
    for (const attendu of ["le type", "le format", "la ville", "la spécialité", "le budget estimé", "le responsable interne"]) {
      expect(msg, attendu).toContain(attendu);
    }
  });

  it("LA MODIFICATION exige la MÊME chose — sinon il suffirait d'enregistrer deux fois", async () => {
    // LE DÉFAUT QUE CE CAS FERME : une obligation posée à la création seule n'oblige à rien. On
    // crée complet, puis on tente de vider le budget par « Modifier ».
    const cree = await createEvent(complet({ name: `${TAG}Maj`, responsibleId: responsableId, doctorIds: ["Dr Benali"], productIds: ["Nivolex"] }));
    expect(cree.ok).toBe(true);
    const ev = await prisma.event.findFirstOrThrow({ where: { name: `${TAG}Maj` } });
    const fd = complet({ name: `${TAG}Maj`, estimatedBudget: "", responsibleId: responsableId, doctorIds: ["Dr Benali"], productIds: ["Nivolex"] });
    fd.set("id", ev.id);
    const r = await updateEvent(fd);
    expect(r.ok, "vider le budget par la modification doit être refusé").toBe(false);
    expect(r.ok === false ? r.error : "").toContain("budget estimé");
    const relu = await prisma.event.findUniqueOrThrow({ where: { id: ev.id } });
    expect(Number(relu.estimatedBudget), "et rien n'a été écrit").toBe(450000);
  });

  it("le NOM garde sa garde propre — celle que le contrat d'action sait LIRE", async () => {
    // `actions/contrat.ts` déduit « obligatoire » d'un `if (!v)` dans le corps ; il ne sait pas
    // lire une liste rendue par une fonction. Tout basculer dans `champsManquants` a fait sortir
    // le nom `obligatoire: false` de l'artefact — mesuré, et la carte d'Adam ne l'aurait plus
    // demandé alors que l'action l'exige (§118.137).
    const r = await createEvent(complet({ name: "", responsibleId: responsableId, doctorIds: ["Dr Benali"], productIds: ["Nivolex"] }));
    expect(r.ok).toBe(false);
    expect(r.ok === false ? r.error : "").toContain("nom de l'événement");
  });
});
