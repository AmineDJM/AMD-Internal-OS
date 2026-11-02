import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { executerHorsRequete } from "@/platform/ia/hors-requete";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { appliquerLotAnnuaire } from "@/lib/actions/fournisseurs-annuaire-actions";
import { executerOperationJournalisee, outilsOperations } from "./infra/operations";
import { ANNULER_DERNIERE, FUSION_DOUBLONS, MAJ_ANNUAIRE } from "./infra/operations/annuaire";
import { lecturesAnnuaireTerrain } from "./infra/annuaire/lectures";
import { agregerDepenses, bornesPeriode, cleDeDoublon, motsDuNom } from "./domaine/annuaire/analyse";
import { COMPTE_JOUE, type PersonaCle } from "./infra/testing/audit/personas";
import { adresseDe, retirerAudit, semerAudit, sessionDe, type SemisAudit } from "./infra/testing/audit/semis";
import { INITIAL, TEMOIN_VISITE } from "./infra/testing/audit/taches/annuaire-marketing-donnees";
import { TACHES } from "./infra/testing/audit/taches";
import { idsDuMondeT2 } from "./infra/testing/audit/taches/annuaire-marketing";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LOT T2 (décision 0052) — L'ANNUAIRE, LE MARKETING ET LE TERRAIN, EXÉCUTÉS CONTRE LA BASE LOCALE, PUIS ANNULÉS.
 *
 * Les gestes de l'assistant (`maj_annuaire`, `fusionner_doublons_annuaire`, `annuler_mon_action`) sont préparés par
 * leur `proposer` (la carte), confirmés sous la session de la personne et SOUS LE JOURNAL DES EFFETS (le chemin du clic),
 * relus en base, puis annulés — tout le lot d'un coup. Les lectures sont jugées sur leurs portées : le délégué d'un autre
 * secteur ne voit ni la fiche ni la visite d'un autre panel ; un compte sans Ad & Pro n'a pas les dépenses.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

// « -t2-… » : l'étiquette qui sème le monde T2 (`semeLeMondeT2`) — les autres suites ne le sèment pas.
const ETIQUETTE = `-t2-${Date.now().toString(36)}`;
let S: SemisAudit;
const u = {} as Record<PersonaCle, CurrentUser>;
let T2: Awaited<ReturnType<typeof idsDuMondeT2>>;
const t2 = () => T2;

/** Le clic : la carte proposée, confirmée sous la session de la personne, sous le journal (comme `confirmerCarte`). */
async function confirmerOperation(user: CurrentUser, op: string, args: Record<string, string | null>) {
  const { resultat } = await executerHorsRequete(user, "banc-t2", () => executerOperationJournalisee(user, { kind: "assistant_ia_op", op, args }, { origine: "carte" }));
  return resultat;
}
const lecture = (nom: string) => lecturesAnnuaireTerrain().find((o) => o.def.name === nom)!;
const lire = async (nom: string, user: CurrentUser, entree: Record<string, unknown>) => JSON.parse(await lecture(nom).run(entree, user)) as Record<string, unknown>;

suite("Lot T2 — l'annuaire tenu par l'assistant (base locale, exécuté puis annulé)", () => {
  beforeAll(async () => {
    S = await semerAudit(ETIQUETTE, { putBlob, enregistrerFichierDrive });
    T2 = await idsDuMondeT2();
    for (const p of ["delegue", "delegue_ouest", "marketing", "commercial", "superadmin"] as PersonaCle[]) u[p] = await sessionDe(S.users[COMPTE_JOUE[p]]);
  }, 180_000);
  afterAll(async () => { if (S) await retirerAudit(ETIQUETTE); }, 120_000);

  it("le délégué corrige un téléphone par le nom dit (« Dr … ») ; la carte montre avant → après ; l'annulation remet l'ancien", async () => {
    const p = await MAJ_ANNUAIRE.proposer({ changements: [{ fiche: "Dr Karima BENSALEM", champ: "telephone", valeur: "0550 12 34 56" }] }, u.delegue);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if (!("carte" in p)) return;
    expect(p.carte.fields[0]!.value).toMatch(/0550 00 00 01 → 0550 12 34 56/);
    const r = await confirmerOperation(u.delegue, MAJ_ANNUAIRE.nom, p.args);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const d = await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: t2().medecins.bensalem } });
    expect(d.phone).toBe("0550 12 34 56");
    expect(d.institutionId).toBe(t2().etablissements.chuConstantine);
    // « Annule cette mise à jour » : la carte d'annulation, confirmée.
    const a = await ANNULER_DERNIERE.proposer({ quoi: "annuaire" }, u.delegue);
    expect("carte" in a, JSON.stringify(a)).toBe(true);
    if (!("carte" in a)) return;
    const ra = await confirmerOperation(u.delegue, ANNULER_DERNIERE.nom, a.args);
    expect(ra.ok, JSON.stringify(ra)).toBe(true);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: t2().medecins.bensalem } })).phone).toBe(INITIAL.bensalem.phone);
  }, 60_000);

  it("le délégué HORS SECTEUR : la fiche d'un autre panel est introuvable, et l'action la refuse même par son identifiant", async () => {
    const p = await MAJ_ANNUAIRE.proposer({ changements: [{ fiche: "Karima BENSALEM", champ: "telephone", valeur: "0770 99 88 77" }] }, u.delegue_ouest);
    expect("erreur" in p && p.erreur).toMatch(/introuvable/);
    const fd = new FormData();
    fd.set("lignes", JSON.stringify([{ cible: "medecin", id: t2().medecins.bensalem, champs: { telephone: "0770 99 88 77" } }]));
    const { resultat } = await executerHorsRequete(u.delegue_ouest, "banc-t2", () => appliquerLotAnnuaire(fd));
    expect(resultat.ok).toBe(false);
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: t2().medecins.bensalem } })).phone).toBe(INITIAL.bensalem.phone);
    // Un compte sans droit sur l'annuaire ne se voit pas même offrir le geste.
    expect(outilsOperations(u.commercial, []).map((o) => o.def.name)).not.toContain("maj_annuaire");
  }, 60_000);

  it("un lot depuis un Excel : chaque ligne résolue, l'introuvable dit ; tout le lot s'annule d'un coup", async () => {
    const p = await MAJ_ANNUAIRE.proposer({ changements: [
      { fiche: "Pharmacie El Amel", champ: "telephone", valeur: "041 33 22 11" },
      { fiche: "Pharmacie Belle Vue", champ: "telephone", valeur: "041 45 67 89" },
      { fiche: "Pharmacie Inconnue", champ: "telephone", valeur: "041 00 00 00" },
      { fiche: "Nora AISSAOUI", champ: "specialite", valeur: "Hépatologie" },
    ] }, u.marketing);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if (!("carte" in p)) return;
    expect(p.carte.fields).toHaveLength(3);
    expect(p.carte.warnings.join(" ")).toMatch(/Inconnue/);
    const r = await confirmerOperation(u.marketing, MAJ_ANNUAIRE.nom, p.args);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const [elAmel, aissaoui] = await Promise.all([
      prisma.medicalInstitution.findUniqueOrThrow({ where: { id: t2().etablissements.elAmel } }),
      prisma.medicalDoctor.findUniqueOrThrow({ where: { id: t2().medecins.aissaoui }, include: { specialtyRef: true } }),
    ]);
    expect(elAmel.phone).toBe("041 33 22 11");
    expect(elAmel.address).toBe(INITIAL.elAmel.address);
    expect(aissaoui.specialtyRef?.name).toBe("Hépatologie");
    // Régression (banc réel 02/11) : corriger la spécialité n'efface plus ni le téléphone ni le délégué.
    expect(aissaoui.phone).toBe("0664 11 22 33");
    expect(aissaoui.delegateId).toBe(S.users.delegue);
    const a = await ANNULER_DERNIERE.proposer({}, u.marketing);
    if (!("carte" in a)) throw new Error(JSON.stringify(a));
    expect((await confirmerOperation(u.marketing, ANNULER_DERNIERE.nom, a.args)).ok).toBe(true);
    const apres = await prisma.medicalInstitution.findMany({ where: { id: { in: [t2().etablissements.elAmel, t2().etablissements.belleVue] } } });
    expect(apres.map((e) => e.phone).sort()).toEqual([INITIAL.belleVue.phone, INITIAL.elAmel.phone].sort());
    expect((await prisma.medicalDoctor.findUniqueOrThrow({ where: { id: t2().medecins.aissaoui } })).specialtyId).toBeNull();
  }, 90_000);

  it("la regulatory corrige UN champ d'un fournisseur (fabricant) : le reste de la fiche est intact", async () => {
    const reg = await sessionDe(S.users.regulatory);
    const p = await MAJ_ANNUAIRE.proposer({ changements: [{ fiche: "Hetero Labs", champ: "site", valeur: "www.heterolabs.com" }] }, reg);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if (!("carte" in p)) return;
    expect((await confirmerOperation(reg, MAJ_ANNUAIRE.nom, p.args)).ok).toBe(true);
    const f = await prisma.supplier.findUniqueOrThrow({ where: { id: t2().fournisseur } });
    expect(f.website).toBe("www.heterolabs.com");
    expect(f.contactEmail).toBe("regulatory@hetero.example");
    expect(f.country).toBe("Inde");
  }, 60_000);

  it("des homonymes (« Dr BENALI ») : une question avec les candidats, jamais un choix en silence", async () => {
    const p = await MAJ_ANNUAIRE.proposer({ changements: [{ fiche: "Dr BENALI", champ: "etablissement", valeur: "CHU Constantine" }] }, u.delegue);
    expect("manque" in p && p.manque[0]).toMatch(/Amel BENALI.*Omar BENALI|Omar BENALI.*Amel BENALI/);
  });

  it("nettoyer les doublons des pharmacies d'Oran : trois groupes, un geste, annulable d'un coup", async () => {
    const p = await FUSION_DOUBLONS.proposer({ wilaya: "Oran" }, u.marketing);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if (!("carte" in p)) return;
    expect(p.carte.fields).toHaveLength(3);
    const e = t2().etablissements;
    const ids = [e.esSalamA, e.esSalamB, e.ibnRochdA, e.ibnRochdB, e.portA, e.portB];
    expect((await confirmerOperation(u.marketing, FUSION_DOUBLONS.nom, p.args)).ok).toBe(true);
    expect(await prisma.medicalInstitution.count({ where: { id: { in: ids }, isActive: true } })).toBe(3);
    // Es-Salam : la fiche gardée (celle du secteur) a reçu l'adresse de l'autre.
    const salam = await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: e.esSalamA } });
    expect(salam.isActive && salam.address).toBe(INITIAL.esSalamB.address);
    const a = await ANNULER_DERNIERE.proposer({ quoi: "doublons" }, u.marketing);
    if (!("carte" in a)) throw new Error(JSON.stringify(a));
    expect((await confirmerOperation(u.marketing, ANNULER_DERNIERE.nom, a.args)).ok).toBe(true);
    expect(await prisma.medicalInstitution.count({ where: { id: { in: ids }, isActive: true } })).toBe(6);
    expect((await prisma.medicalInstitution.findUniqueOrThrow({ where: { id: e.esSalamA } })).address).toBeNull();
  }, 90_000);

  it("demander au terrain : la carte confirmée ouvre UNE mission (2 demandes + livrable), approuvée, sans aucun envoi externe", async () => {
    const { DEMANDER_AU_TERRAIN } = await import("./infra/operations/demandes-terrain");
    // Par e-mail : les suites parallèles sèment les mêmes noms dans la base de test (de vrais homonymes, donc refusés).
    const a = (t: "delegue" | "delegue_ouest") => adresseDe(t, ETIQUETTE);
    const p = await DEMANDER_AU_TERRAIN.proposer({ destinataires: [a("delegue"), a("delegue_ouest")], question: "Combien de boîtes de Daclavir reste-t-il dans les pharmacies de ton secteur ?", echeance: "vendredi", relanceJours: 2 }, u.marketing);
    expect("carte" in p, JSON.stringify(p)).toBe(true);
    if (!("carte" in p)) return;
    expect(p.carte.fields[0]!.value).toBe(`${a("delegue")}, ${a("delegue_ouest")}`);
    const r = await confirmerOperation(u.marketing, DEMANDER_AU_TERRAIN.nom, p.args);
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const m = await prisma.mission.findFirstOrThrow({ where: { ownerId: u.marketing.id, kind: "TRAVAIL", context: "carte demander_au_terrain" }, orderBy: { createdAt: "desc" }, include: { steps: true } });
    expect(m.status).not.toBe("AWAITING_APPROVAL");
    expect(JSON.stringify(m.steps)).toContain(S.users.delegue);
    expect(JSON.stringify(m.steps)).toContain(S.users.delegue_ouest);
    // Une personne inconnue : jamais sollicitée en silence.
    const x = await DEMANDER_AU_TERRAIN.proposer({ destinataires: ["Personne INEXISTANTE"], question: "x" }, u.marketing);
    expect("erreur" in x && x.erreur).toMatch(/INEXISTANTE/);
  }, 60_000);

  it("les lectures : qui couvre, le panel sans téléphone, les comptes exacts, sous la portée de chacun", async () => {
    const ibnSina = await lire("annuaire_terrain", u.marketing, { quoi: "pharmacie", nom: "Ibn Sina" });
    expect(JSON.stringify(ibnSina.etablissements)).toMatch(/Yanis HAMDI/);
    const oran = await lire("annuaire_terrain", u.marketing, { quoi: "pharmacie", wilaya: "Oran", limite: 1 });
    expect(oran.etablissementsTotal).toBe(8);
    expect(oran.etablissementsCouverts).toBe(3);
    const sansTel = JSON.stringify(await lire("annuaire_terrain", u.delegue, { quoi: "medecin", manquant: "telephone" }));
    expect(sansTel).toMatch(/KHELIF/);
    expect(sansTel).toMatch(/LAMRI/);
    expect(sansTel).not.toMatch(/TOUATI/);
    // Hors secteur : ni la fiche, ni la visite (ni son compte rendu) d'un autre panel.
    expect(JSON.stringify(await lire("annuaire_terrain", u.delegue_ouest, { nom: "MANSOURI" }))).not.toMatch(/0661/);
    const visitesOuest = JSON.stringify(await lire("visites_terrain", u.delegue_ouest, { medecin: "MANSOURI", jours: 365 }));
    expect(visitesOuest).not.toContain(TEMOIN_VISITE);
    const derniere = await lire("visites_terrain", u.superadmin, { medecin: "Rachid MANSOURI", jours: 365 });
    expect(JSON.stringify(derniere.parMedecin)).toMatch(/Yanis HAMDI/);
    expect(lecture("visites_terrain").allowed(u.commercial)).toBe(false);
  }, 60_000);

  it("les dépenses marketing : totaux exacts par BU, comparaison au mois précédent ; refusées à qui n'a pas l'Ad & Pro", async () => {
    const r = await lire("depenses_marketing", u.marketing, { par: ["bu", "produit"], periode: "annee" });
    const bu = r.parBu as Record<string, unknown>[];
    expect(bu.find((v) => v.bu === "Hépatologie")?.totalDzd).toBe(950_000);
    expect(bu.find((v) => v.bu === "Oncologie")?.totalDzd).toBe(810_000);
    const m = await lire("depenses_marketing", u.marketing, { par: ["bu"], periode: "mois", comparer: true });
    const hep = (m.parBu as Record<string, unknown>[]).find((v) => v.bu === "Hépatologie");
    expect(hep).toMatchObject({ totalDzd: 735_000, periodePrecedenteDzd: 215_000 });
    expect(lecture("depenses_marketing").allowed(u.commercial)).toBe(false);
  }, 60_000);
});

describe("Lot T2 — les règles pures et le catalogue du banc", () => {
  it("les mots d'un nom, la clé de doublon, les périodes, les agrégats", () => {
    expect(motsDuNom("le Dr Karima BENSALEM")).toEqual(["Karima", "BENSALEM"]);
    expect(cleDeDoublon("Pharmacie Es-Salam", "Oran")).toBe(cleDeDoublon("PHARMACIE ES SALAM", "oran"));
    expect(cleDeDoublon("Pharmacie Ibn Rochd", "Oran")).not.toBe(cleDeDoublon("Pharmacie Ibn Sina", "Oran"));
    const b = bornesPeriode("mois", new Date("2026-11-02T10:00:00Z"));
    expect(b.du.toISOString().slice(0, 10)).toBe("2026-11-01");
    expect(b.precedente.du.toISOString().slice(0, 10)).toBe("2026-10-01");
    const l = (bu: string, montant: number, etat = "ACCEPTED") => ({ nature: "Sponsoring", reference: null, objet: "x", bu, produit: "P", le: new Date("2026-10-03"), montant, etat, demandeur: null });
    const a = agregerDepenses([l("A", 100), l("A", 50), l("B", 70), l("B", 999, "REFUSED")], ["bu"], [l("A", 100)]);
    expect(a.totalDzd).toBe(220);
    expect(a.parAxe[0]!.valeurs[0]).toMatchObject({ bu: "A", totalDzd: 150, periodePrecedenteDzd: 100, ecartPct: 50 });
  });

  it("le banc T2 : 25 à 40 tâches variées, chacune avec sa preuve (vérificateur ou attendu), sur les cinq personas du domaine", () => {
    const t = TACHES.filter((x) => /^(ANN|MKT|TER)-/.test(x.id));
    expect(t.length).toBeGreaterThanOrEqual(25);
    expect(t.length).toBeLessThanOrEqual(40);
    for (const x of t) expect(x.verifier || x.attendu.contient || x.attendu.interdit || x.attendu.objet, x.id).toBeTruthy();
    for (const p of ["kam", "delegue", "marketing", "superadmin", "delegue_ouest"]) expect(t.some((x) => x.persona === p), p).toBe(true);
  });
});

describe("Lot T2 — demander au terrain : le plan de mission construit par le code", () => {
  it("une demande par personne, relance avant l'échéance, abandon, puis le livrable consolidé (relu par le moteur)", async () => {
    const { planDemandesTerrain, joursJusqua } = await import("./domaine/annuaire/demandes");
    const { lirePlan } = await import("@/lib/missions/travaux/plan");
    expect(joursJusqua("vendredi", new Date("2026-11-02T10:00:00Z"))).toBe(4);
    expect(joursJusqua("2026-11-06", new Date("2026-11-02T10:00:00Z"))).toBe(4);
    expect(joursJusqua("demain", new Date())).toBe(1);
    const { plan } = planDemandesTerrain({ destinataires: ["Yanis HAMDI", "Farid ZEROUAL"], question: "Combien de boîtes de Daclavir reste-t-il ?", jours: 4, relanceJours: 2, format: "xlsx" });
    const lu = lirePlan(plan, { lectures: [], gestes: [] } as never);
    expect(lu.ok, JSON.stringify(lu)).toBe(true);
    expect(plan.etapes.filter((e) => e.type === "DEMANDE")).toHaveLength(2);
    expect(JSON.stringify(plan)).toMatch(/"relance":\{"jours":2\}/);
    expect(plan.etapes.at(-1)).toMatchObject({ type: "LIVRABLE", format: "xlsx", apres: ["demande-1", "demande-2"] });
  });
});
