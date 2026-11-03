import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { consignerMesure } from "@/lib/evals/registre";
import { readFileSync } from "node:fs";
import { prisma } from "@/lib/prisma";
import { resoudreEntite, resoudreMentions, contexteEntitesResolues } from "./entites";
import type { TypeEntite, Verdict } from "./entites-score";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DE RÉSOLUTION — des entités RÉALISTES plantées dans la vraie base (accents, traits
 * d'union, ordre des mots, formes juridiques, acronymes, alias marque ↔ DCI, homonymes,
 * distracteurs proches), puis soixante mentions telles qu'un dirigeant les tape : exactes,
 * fautives, partielles, inversées, identifiants, ambiguës, inconnues. Le mandat exige ≥ 95 % de
 * bonnes résolutions et une recherche simple sous 300 ms au P95 — mesurés ici, en local.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
const P = "__er__";
const ids: Record<string, string> = {};

async function nettoyer() {
  await prisma.regulatoryProduct.deleteMany({ where: { OR: [{ reference: { startsWith: P } }, { reference: { in: ["PRD-9101", "PRD-9102", "PRD-9103", "PRD-9104"] } }] } });
  await prisma.supplier.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.employee.deleteMany({ where: { fullName: { startsWith: P } } });
  await prisma.user.deleteMany({ where: { OR: [{ email: { startsWith: "__er__", mode: "insensitive" } }, { name: { startsWith: P } }] } });
  await prisma.medicalInstitution.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.medicalDoctor.deleteMany({ where: { name: { startsWith: P } } });
  await prisma.company.deleteMany({ where: { name: { startsWith: P } } }); // son département part en cascade
}

interface Cas { q: string; types?: TypeEntite[]; attendu: Verdict; id?: string; note?: string }

describe("résolution d'entités — banc réaliste sur la vraie base (F9)", () => {
  beforeAll(async () => {
    await nettoyer();
    // La société et le département sont À CE BANC : empruntés, c'étaient souvent ceux d'un voisin, retirés en cours de route
    // (et la création qui les désigne échouait sur la clé étrangère).
    const company = await prisma.company.create({ data: { name: `${P} Société du banc` }, select: { id: true } });
    const dept = await prisma.department.create({ data: { name: `${P} Département du banc`, code: `${P}DEPT`, companyId: company.id }, select: { id: true } });
    const u = async (name: string, email: string, title?: string) => (await prisma.user.create({ data: { name: `${P} ${name}`, email, passwordHash: "x", role: "VIEWER", isActive: true, title: title ?? null, departmentId: dept.id } })).id;
    ids.raihana = await u("Raïhana Cherif", "__er__r.cherif@adventum.dz", "Chargée Regulatory");
    ids.nadir1 = await u("Nadir Benali", "__er__n.benali@adventum.dz", "RH");
    ids.nadir2 = await u("Nadir Cherif", "__er__n.cherif@adventum.dz", "Ventes");
    ids.khaled = await u("Khaled Mansouri", "__er__k.mansouri@adventum.dz", "DAF");
    ids.amine = await u("Mohamed-Amine Djouamai", "__er__a.djouamai@adventum.dz", "PDG");
    const e = async (fullName: string, email: string, userId: string | null) => (await prisma.employee.create({ data: { fullName: `${P} ${fullName}`, email, isActive: true, baseSalary: 100000, userId, departmentId: dept.id } })).id;
    ids.empRaihana = await e("Raïhana Cherif", "__er__r.cherif@adventum.dz", ids.raihana);
    ids.empSansCompte = await e("Yasmine Boudiaf", "__er__y.boudiaf@adventum.dz", null);
    const s = async (name: string, country: string, contactEmail: string | null) => (await prisma.supplier.create({ data: { name: `${P} ${name}`, country, contactEmail, active: true } })).id;
    ids.hetero = await s("Hetero Labs Limited", "Inde", "deepak@heterolabs.com");
    ids.hikma = await s("Hikma Pharmaceuticals", "Jordanie", "sales@hikma.com");
    ids.kwality = await s("Kwality Pharma SPA", "Algérie", null);
    ids.sunPharma = await s("Sun Pharmaceutical Industries", "Inde", "info@sunpharma.com");
    const p = async (reference: string, dci: string, brandName: string | null, dosage: string, form: string) => (await prisma.regulatoryProduct.create({ data: { reference, dci, brandName, dosage, dosageUnit: "mg", pharmaceuticalForm: form, packaging: "B/30", status: "SUBMITTED", companyId: company.id } as never })).id;
    /**
     * DES MOLÉCULES RÉELLES, MAIS QUI N'APPARTIENNENT QU'À CE BANC.
     *
     * Les personnes, fournisseurs, hôpitaux et médecins portent le marqueur du run (`__er__`) :
     * leur corpus est à lui, donc ses verdicts mesurent le RÉSOLVEUR. Un DCI et une marque, eux,
     * ne peuvent pas porter de préfixe sans cesser d'être ce qu'un dirigeant tape — et le corpus
     * produit était donc PARTAGÉ. Mesuré : le semis du banc de mission porte Lenvatinib
     * (Lenvatix) et Nivolumab (Nivolex) ; « Lenvatinib » sortait AMBIGU à deux candidats à 1,00,
     * et le banc accusait le résolveur alors que celui-ci avait RAISON — deux produits portent
     * bien cette molécule, et une liste de plusieurs ne désigne personne (§118.34). Il mesurait
     * le VOISINAGE (§118.91).
     *
     * On choisit donc des molécules aussi réelles et aussi piégeuses, ABSENTES du semis — et le
     * cas suivant PROUVE cette exclusivité, pour qu'une contamination future soit diagnostiquée
     * en une ligne au lieu de soixante.
     */
    ids.lenva = await p("PRD-9101", "Ibrutinib", "Imbruvica", "140", "Gélule");
    ids.sofo = await p("PRD-9102", "Sofosbuvir + Velpatasvir", "Epclusa", "400", "Comprimé");
    ids.pembro = await p("PRD-9103", "Atezolizumab", "Tecentriq", "1200", "Solution");
    ids.nivo = await p("PRD-9104", "Durvalumab", "Imfinzi", "500", "Solution");
    const i = async (name: string, type: "CHU" | "EPH" | "CLINIQUE_PRIVEE" | "PHARMACIE", city: string) => (await prisma.medicalInstitution.create({ data: { name: `${P} ${name}`, type, sector: "PUBLIC" as never, city, isActive: true } as never })).id;
    ids.chuTizi = await i("CHU de Tizi-Ouzou", "CHU", "Tizi Ouzou");
    ids.chuOran = await i("CHU d'Oran", "CHU", "Oran");
    ids.ephBejaia = await i("EPH de Béjaïa", "EPH", "Béjaïa");
    const d = async (name: string, specialty: string, email: string | null) => (await prisma.medicalDoctor.create({ data: { name: `${P} ${name}`, title: "PRATICIEN_SPECIALISTE", sector: "HOSPITAL", specialty, email, influenceLevel: "MEDIUM", prescriptionPotential: "MEDIUM", influence: "MEDIUM", potential: "MEDIUM", affinity: "MEDIUM" } })).id;
    ids.haddad = await d("Meriem Haddad", "Oncologie", "__er__m.haddad@chu.dz");
    ids.haddad2 = await d("Meriem Haddadi", "Cardiologie", null);
  }, 60_000);

  afterAll(async () => { await nettoyer(); await prisma.$disconnect(); });

  it("la brique ne contient AUCUNE écriture : pas de fusion silencieuse possible", () => {
    const src = readFileSync("src/lib/fabric/entites.ts", "utf8");
    expect(src).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany|\$executeRaw)\(/);
  });

  it("LE CORPUS EST À CE BANC : aucun produit ÉTRANGER ne porte ses molécules ni ses marques", async () => {
    /**
     * POURQUOI CETTE ASSERTION EXISTE, et ce qui la ferait tomber.
     *
     * Le résolveur lit TOUTE la base — c'est sa vocation, et c'est juste. Un banc qui plante des
     * noms réalistes dans une base partagée mesure donc la base autant que le code. Quand un
     * semis voisin porte la même molécule, « Ibrutinib » devient légitimement AMBIGU et les
     * soixante mentions s'effondrent en accusant le résolveur : la première question devant un
     * échec de banc n'est pas « qu'est-ce qui est cassé dans le produit ? » mais « qu'est-ce que
     * le juge a réellement mesuré ? » (§118.92).
     *
     * Ce cas répond à la question EN UNE LIGNE. Il tombe le jour où un autre jeu de données
     * réutilise l'une de ces molécules ou l'une de ces marques — et il nomme alors la
     * contamination, la référence fautive comprise, au lieu de laisser soixante cas mentir sur
     * la cause.
     */
    const miens = [ids.lenva, ids.sofo, ids.pembro, ids.nivo];
    const plantes = await prisma.regulatoryProduct.findMany({
      where: { id: { in: miens } },
      select: { dci: true, brandName: true },
    });
    expect(plantes, "les quatre produits du banc doivent exister").toHaveLength(4);
    const textes = plantes.flatMap((x) => [x.dci, x.brandName].filter((t): t is string => Boolean(t)));
    const etrangers = await prisma.regulatoryProduct.findMany({
      where: {
        id: { notIn: miens },
        OR: textes.flatMap((t) => [
          { dci: { equals: t, mode: "insensitive" as const } },
          { brandName: { equals: t, mode: "insensitive" as const } },
        ]),
      },
      select: { reference: true, dci: true, brandName: true },
    });
    expect(
      etrangers,
      `CORPUS CONTAMINÉ — ces produits ÉTRANGERS portent une molécule ou une marque de ce banc, `
      + `donc ses verdicts « CERTAIN » deviennent AMBIGU à juste titre et ne mesurent plus le résolveur : `
      + etrangers.map((x) => `${x.reference} (${x.dci}${x.brandName ? ` / ${x.brandName}` : ""})`).join(", ")
      + ". Remède : donner au banc des molécules qu'aucun autre jeu de données n'emploie.",
    ).toHaveLength(0);
  }, 60_000);

  it("≥ 95 % de bonnes résolutions sur soixante mentions réalistes, P95 < 300 ms", async () => {
    const cas: Cas[] = [
      // Personnes : exact, accents, ordre, partiel, faute, identifiant, homonymes, inconnu.
      { q: `${P} Raïhana Cherif`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.raihana },
      { q: `${P} Raihana Cherif`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.raihana, note: "sans accent" },
      { q: `${P} Cherif Raihana`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.raihana, note: "ordre inversé" },
      { q: `${P} Raihana`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.raihana, note: "prénom seul, unique" },
      { q: `${P} Raihanna Cherif`, types: ["PERSONNE"], attendu: "PROBABLE", id: ids.raihana, note: "faute de frappe" },
      { q: "__er__r.cherif@adventum.dz", attendu: "CERTAIN", id: ids.raihana, note: "e-mail" },
      { q: `${P} Nadir`, types: ["PERSONNE"], attendu: "AMBIGU", note: "deux Nadir" },
      { q: `${P} Nadir Benali`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.nadir1 },
      { q: `${P} Benali Nadir`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.nadir1 },
      { q: `${P} Khaled`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.khaled },
      { q: `${P} Mansouri`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.khaled },
      { q: `${P} Mohamed Amine Djouamai`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.amine, note: "trait d'union absent" },
      { q: `${P} Amine Djouamai`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.amine },
      { q: `${P} Yasmine Boudiaf`, types: ["PERSONNE"], attendu: "CERTAIN", id: ids.empSansCompte, note: "salariée sans compte" },
      { q: `${P} Zorglub Inconnu`, types: ["PERSONNE"], attendu: "INCONNU" },
      // Fournisseurs : formes juridiques, acronyme, faute, domaine, distracteur.
      { q: `${P} Hetero Labs Limited`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero },
      { q: `${P} Hetero Labs`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero, note: "sans la forme" },
      { q: `${P} Hetero`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero },
      { q: `${P} HETERO LABS LTD`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero },
      { q: `${P} Hetro Labs`, types: ["FOURNISSEUR"], attendu: "PROBABLE", id: ids.hetero, note: "faute" },
      { q: "heterolabs.com", types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero, note: "domaine" },
      { q: "deepak@heterolabs.com", types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hetero, note: "e-mail de contact" },
      { q: `${P} Hikma`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hikma },
      { q: `${P} Hikma Pharma`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.hikma },
      { q: `${P} Kwality`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.kwality },
      { q: `${P} Kwality Pharma`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.kwality },
      { q: `${P} Sun Pharma`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.sunPharma },
      { q: `${P} Sun Pharmaceutical`, types: ["FOURNISSEUR"], attendu: "CERTAIN", id: ids.sunPharma },
      { q: `${P} Novartis`, types: ["FOURNISSEUR"], attendu: "INCONNU" },
      // Produits, molécules, marques : DCI, marque, alias, ordre des molécules, référence, faute.
      { q: "Ibrutinib", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.lenva },
      { q: "ibrutinib", types: ["MOLECULE"], attendu: "CERTAIN", id: "dci:ibrutinib" },
      { q: "Imbruvica", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.lenva, note: "marque" },
      { q: "Imbruvica", types: ["MARQUE"], attendu: "CERTAIN", id: ids.lenva },
      { q: "Ibrutinb", types: ["PRODUIT"], attendu: "PROBABLE", id: ids.lenva, note: "faute" },
      { q: "PRD-9101", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.lenva, note: "référence" },
      { q: "Sofosbuvir + Velpatasvir", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.sofo },
      { q: "Velpatasvir/Sofosbuvir", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.sofo, note: "ordre des molécules" },
      { q: "Epclusa", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.sofo },
      { q: "Tecentriq", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.pembro },
      { q: "Atezolizumab", types: ["MOLECULE"], attendu: "CERTAIN", id: "dci:atezolizumab" },
      { q: "Imfinzi", types: ["MARQUE"], attendu: "CERTAIN", id: ids.nivo },
      { q: "Durvalumab", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.nivo },
      { q: "le dossier Durvalumab", types: ["PRODUIT"], attendu: "CERTAIN", id: ids.nivo, note: "habillage" },
      { q: "Abcdefgomab", types: ["PRODUIT"], attendu: "INCONNU" },
      // Hôpitaux et institutions : sigle, ville, trait d'union, distracteur.
      { q: `${P} CHU de Tizi-Ouzou`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.chuTizi },
      { q: `${P} CHU Tizi Ouzou`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.chuTizi },
      { q: `${P} CHU Tizi`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.chuTizi, note: "partiel" },
      { q: `${P} CHU d'Oran`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.chuOran },
      { q: `${P} CHU Oran`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.chuOran },
      { q: `${P} EPH Bejaia`, types: ["HOPITAL"], attendu: "CERTAIN", id: ids.ephBejaia, note: "sans accents" },
      { q: `${P} CHU`, types: ["HOPITAL"], attendu: "AMBIGU", note: "deux CHU" },
      // Médecins : titre, faute, homonyme proche, e-mail.
      { q: `${P} Meriem Haddad`, types: ["MEDECIN"], attendu: "CERTAIN", id: ids.haddad },
      { q: `Dr ${P} Meriem Haddad`, types: ["MEDECIN"], attendu: "CERTAIN", id: ids.haddad, note: "titre" },
      { q: "__er__m.haddad@chu.dz", types: ["MEDECIN"], attendu: "CERTAIN", id: ids.haddad },
      { q: `${P} Haddadi`, types: ["MEDECIN"], attendu: "CERTAIN", id: ids.haddad2 },
      { q: `${P} Meriem`, types: ["MEDECIN"], attendu: "AMBIGU", note: "deux Meriem" },
      // Toutes natures : la mention seule doit trouver sa nature.
      { q: `${P} Hetero`, attendu: "CERTAIN", id: ids.hetero, note: "sans type" },
      { q: "Tecentriq", attendu: "CERTAIN", note: "marque ou produit — l'un des deux" },
      { q: `${P} Khaled Mansouri`, attendu: "CERTAIN", id: ids.khaled, note: "sans type" },
      { q: `${P} Meriem Haddad`, attendu: "CERTAIN", id: ids.haddad, note: "sans type" },
    ];
    const echecs: string[] = [];
    const durees: number[] = [];
    for (const c of cas) {
      const r = await resoudreEntite(c.q, { types: c.types });
      durees.push(r.ms);
      const okVerdict = r.verdict === c.attendu;
      const okId = !c.id || (r.retenu?.id === c.id) || (c.attendu === "CERTAIN" && r.retenu?.id === c.id);
      if (!okVerdict || !okId) echecs.push(`« ${c.q} »${c.note ? ` (${c.note})` : ""} → ${r.verdict}${r.retenu ? ` ${r.retenu.libelle} [${r.retenu.id}]` : ""} attendu ${c.attendu}${c.id ? ` [${c.id}]` : ""} ; candidats : ${r.candidats.slice(0, 3).map((x) => `${x.libelle}=${x.score.toFixed(2)}`).join(", ")}`);
    }
    durees.sort((a, b) => a - b);
    const p95 = durees[Math.floor(durees.length * 0.95) - 1] ?? durees[durees.length - 1];
    const taux = 1 - echecs.length / cas.length;
    console.log(`   · résolution ${cas.length - echecs.length}/${cas.length} (${(taux * 100).toFixed(1)} %) · P50 ${durees[Math.floor(durees.length / 2)]} ms · P95 ${p95} ms (base locale)`);
    if (echecs.length) console.log(echecs.map((e) => `     ✗ ${e}`).join("\n"));
    expect(taux, echecs.join("\n")).toBeGreaterThanOrEqual(0.95);
    expect(p95).toBeLessThan(300);
    consignerMesure("entites_ambigues", { n: cas.length, ok: cas.length - echecs.length }, "lib/fabric/entites.test.ts");
    consignerMesure("entite_simple_p95", { valeur: p95 }, "lib/fabric/entites.test.ts");
  }, 120_000);

  it("l'ambiguïté devient une QUESTION qui distingue, et le contexte du planificateur l'ordonne", async () => {
    const r = await resoudreEntite(`${P} Nadir`, { types: ["PERSONNE"] });
    expect(r.verdict).toBe("AMBIGU");
    expect(r.question).toMatch(/Nadir Benali — RH/);
    expect(r.question).toMatch(/Nadir Cherif — Ventes/);
    const ctx = contexteEntitesResolues(await resoudreMentions([`${P} Nadir`, `${P} Hetero`, "Zorglub Machin"]));
    expect(ctx).toMatch(/AMBIGU/);
    expect(ctx).toMatch(/poser la question avant d'agir/);
    expect(ctx).toMatch(/Hetero Labs Limited \(fournisseur/);
    expect(ctx).not.toMatch(/Zorglub/);
  });
});
