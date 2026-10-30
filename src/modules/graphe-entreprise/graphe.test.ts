import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan } from "@/lib/rbac";
import { scopeRegulatory, scopeSponsoring } from "@/lib/rbac/portees";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { inscrireDocumentRh, piecesOuvrables, traiterFile } from "@/modules/bibliotheque/api";
import { plier } from "@/modules/referentiels/partage";
import { outilsGraphe } from "@/platform/ia/lectures/graphe";
import {
  chiffresSansSource, compterChiffres, etatALaDate, explorerRelations, indexEntites, indexer, oublierIndex, resoudreDans, resoudreEntite, typeDe,
} from "./api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC DU GRAPHE (J9, décision 0021) — sur la vraie base, sans Prisma simulé, sans modèle.
 *
 *   1. RÉSOLUTION ≥ 95 % sur un corpus semé (doublons arabe/latin, fautes, sigles, NIF/RC, homonymes) ;
 *   2. 100 % DES CHIFFRES servis par les trois outils portent leur source ;
 *   3. PARCOURS p95 < 300 ms sur 50 000 arêtes semées (profondeur 3) ;
 *   4. AUCUN RÉSULTAT HORS DROITS : chaque nœud rendu est rejugé par la règle de l'écran, par rôle ; rien n'est atteint
 *      À TRAVERS un nœud interdit ; une famille fermée retire ses types ; une pièce du coffre ne part jamais au modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `g9${Date.now().toString(36)}`;
const pieces: string[] = [];
const comptes: Record<string, CurrentUser> = {};
const ids: Record<string, string> = {};

async function compte(nom: string, role: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { name: `${TAG} ${nom}`, email: `${TAG}${nom}@t.dz`, passwordHash: "x", role: role as never } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
}

const PERSONNES: [string, string, string][] = [
  ["p1", "Mohamed", "Benali"], ["p2", "Ahmed", "Benali"], ["p3", "Karima", "Cherif"], ["p4", "Abdelkader", "Bouzid"],
  ["p5", "Fatima Zohra", "Hamidi"], ["p6", "Youcef", "Khaldi"], ["p7", "Ouahiba", "Mansouri"], ["p8", "Abderrahmane", "Belkacem"],
  ["p9", "Djamel", "Saidi"], ["p10", "Hocine", "Ait Ahmed"], ["p11", "Nadia", "Boudiaf"], ["p12", "Rachid", "Mebarki"],
  ["p13", "Samira", "Zerrouki"], ["p14", "Mustapha", "Haddad"], ["p15", "Leila", "Ouali"], ["p16", "Salim", "Kaci"],
  ["p17", "Meriem", "Bensalem"], ["p18", "Omar", "Ferhat"], ["p19", "Amina", "Brahimi"], ["p20", "Khaled", "Bouchama"],
];
const ORGS: { k: string; rs: string; court?: string; ident?: [string, string, string] }[] = [
  { k: "o1", rs: "Groupe Saidal SPA", court: "Saidal", ident: ["NIF", "000116001234567", "000116001234567"] },
  { k: "o2", rs: "Entreprise Nationale des Produits Pharmaceutiques", ident: ["RC", "16/00-0012345B99", "16000012345B99"] },
  { k: "o3", rs: "Hikma Pharma Algérie SPA", court: "Hikma" },
  { k: "o4", rs: "Laboratoires Merinal SARL", ident: ["NIF", "000216009876543", "000216009876543"] },
  { k: "o5", rs: "Biopharm SPA" },
  { k: "o6", rs: "Centre Hospitalo-Universitaire Mustapha Pacha", court: "CHU Mustapha" },
  { k: "o7", rs: "Pharmacie Centrale des Hôpitaux" },
  { k: "o8", rs: "Imprimerie Atlas EURL" },
  { k: "o9", rs: "Frater Razes SARL" },
  { k: "o10", rs: "Institut Pasteur d'Algérie" },
  { k: "o11", rs: "El Kendi Pharmaceutical Manufacturing" },
  { k: "o12", rs: "Sanofi Aventis Algérie" },
];

/** Le corpus : mention → clé attendue (`null` = INCONNU attendu, `"?"` = AMBIGU attendu). */
const CORPUS: [string, string | null][] = [
  ["Mohamed Benali", "p1"], ["BENALI Mohamed", "p1"], ["Mohammed Ben Ali", "p1"], ["محمد بن علي", "p1"], ["Med Benali", "p1"], ["Mohamed Benaly", "p1"],
  ["Ahmed Benali", "p2"], ["أحمد بن علي", "p2"], ["Benali", "?"],
  ["Karima Cherif", "p3"], ["Karima Chérif", "p3"], ["كريمة شريف", "p3"], ["Cherif Karima", "p3"], ["Karima Cherf", "p3"],
  ["Abdelkader Bouzid", "p4"], ["Abd El Kader Bouzid", "p4"], ["عبد القادر بوزيد", "p4"], ["Bouzid Abdelkader", "p4"],
  ["Fatima Zohra Hamidi", "p5"], ["Fatima Ez-Zohra Hamidi", "p5"], ["فاطمة الزهراء حميدي", "p5"],
  ["Youcef Khaldi", "p6"], ["Youssef Khaldi", "p6"], ["يوسف خالدي", "p6"],
  ["Ouahiba Mansouri", "p7"], ["Wahiba Mansouri", "p7"], ["وهيبة منصوري", "p7"],
  ["Abderrahmane Belkacem", "p8"], ["عبد الرحمن بلقاسم", "p8"], ["Abderahmane Belkacem", "p8"],
  ["Djamel Saidi", "p9"], ["Jamel Saidi", "p9"], ["جمال سعيدي", "p9"],
  ["Hocine Ait Ahmed", "p10"], ["حسين آيت أحمد", "p10"], ["Hocine Aït-Ahmed", "p10"],
  ["Nadia Boudiaf", "p11"], ["نادية بوضياف", "p11"],
  ["Rachid Mebarki", "p12"], ["رشيد مباركي", "p12"], ["Rachid Mbarki", "p12"],
  ["Samira Zerrouki", "p13"], ["سميرة زروقي", "p13"],
  ["Mustapha Haddad", "p14"], ["Moustafa Haddad", "p14"], ["مصطفى حداد", "p14"],
  ["Leila Ouali", "p15"], ["ليلى والي", "p15"],
  ["Salim Kaci", "p16"], ["سليم قاسي", "p16"],
  ["Meriem Bensalem", "p17"], ["مريم بن سالم", "p17"],
  ["Omar Ferhat", "p18"], ["عمر فرحات", "p18"],
  ["Amina Brahimi", "p19"], ["أمينة براهيمي", "p19"],
  ["Khaled Bouchama", "p20"], ["Khalid Bouchama", "p20"], ["خالد بوشامة", "p20"],
  ["Saidal", "o1"], ["Groupe Saidal", "o1"], ["مجمع صيدال", "o1"], ["Sadial", "o1"], ["NIF 000116001234567", "o1"], ["000 116 001 234 567", "o1"],
  ["ENPP", "o2"], ["Entreprise nationale des produits pharmaceutiques", "o2"], ["RC 16/00-0012345 B 99", "o2"],
  ["Hikma", "o3"], ["Hikma Pharma", "o3"], ["حكمة فارما", "o3"],
  ["Merinal", "o4"], ["Laboratoires Mérinal", "o4"], ["NIF 000216009876543", "o4"], ["Mirinal", "o4"],
  ["Biopharm", "o5"], ["Bio Pharm", "o5"],
  ["CHU Mustapha", "o6"], ["CHU Mustapha Pacha", "o6"], ["المستشفى الجامعي مصطفى باشا", "o6"],
  ["PCH", "o7"], ["Pharmacie Centrale des Hôpitaux", "o7"],
  ["Imprimerie Atlas", "o8"], ["مطبعة أطلس", "o8"],
  ["Frater Razes", "o9"], ["Frater-Razes", "o9"],
  ["Institut Pasteur", "o10"], ["IPA", "o10"],
  ["El Kendi", "o11"], ["الكندي", "o11"],
  ["Sanofi", "o12"], ["Sanofi Aventis", "o12"], ["سانوفي", "o12"],
  ["Daclatasvir", "pr1"], ["PRD-9026-002", "pr2"], ["Sofosbuvire", "pr2"], ["nivolumab", "pr3"], ["REG-9026-014", "d1"],
  ["Zoubir Tlemcani", null], ["Laboratoire Inexistant", null], ["Société Fantôme", null],
];

suite("Graphe de l'entreprise (J9) — banc sur la base", () => {
  beforeAll(async () => {
    for (const [k, prenoms, nom] of PERSONNES) {
      const p = await prisma.personne.create({ data: { nom: `${nom}`, prenoms, nomReplie: plier(`${nom} ${prenoms}`), roles: { create: { role: "COLLABORATEUR" } }, creeParId: TAG } });
      ids[k] = p.id;
    }
    for (const o of ORGS) {
      const org = await prisma.organisation.create({ data: { raisonSociale: o.rs, nomCourt: o.court ?? null, nomReplie: plier(o.rs), creeParId: TAG } });
      ids[o.k] = org.id;
      if (o.ident) await prisma.organisationIdentifiant.create({ data: { organisationId: org.id, type: o.ident[0] as never, valeur: o.ident[1], valeurNormalisee: `${o.ident[2]}` } });
    }
    const produits = [["pr1", "Daclatasvir 60 mg", "daclatasvir"], ["pr2", "Sofosbuvir 400 mg", "sofosbuvir"], ["pr3", "Nivolumab 100 mg", "nivolumab"]];
    for (const [k, nom, dci] of produits) {
      const n = k.slice(2);
      const p = await prisma.product.create({ data: { code: `PRD-9026-00${n}`, canonicalName: nom!, dci: dci!, identityKey: `${TAG}${k}` } });
      ids[k!] = p.id;
    }
    // Le fournisseur Saidal (fiche Supplier rattachée à l'organisation), son dossier verrouillé ou non, une demande Ad & Pro.
    const sup = await prisma.supplier.create({ data: { name: `${TAG} Saidal fournisseur`, organisationId: ids.o1 } });
    ids.sup = sup.id;
    comptes.admin = await compte("admin", "SUPER_ADMIN");
    comptes.proprio = await compte("proprio", "MEDICAL_DELEGATE");
    comptes.viewer = await compte("viewer", "VIEWER");
    comptes.reg = await compte("reg", "HEAD_OF_REGULATORY");
    comptes.delegue = await compte("delegue", "MEDICAL_DELEGATE");
    await prisma.user.update({ where: { id: comptes.reg.id }, data: { personneId: ids.p3 } });
    const d1 = await prisma.regulatoryProduct.create({ data: { reference: "REG-9026-014", dci: "daclatasvir", supplierId: sup.id, productId: ids.pr1, responsibleId: comptes.reg.id } });
    ids.d1 = d1.id;
    const s1 = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}-SPO`, institution: "CHU", type: "congres", organisationId: ids.o1, requesterId: comptes.proprio.id } });
    ids.s1 = s1.id;
    await prisma.affiliation.create({ data: { personneId: ids.p1!, organisationId: ids.o1!, depuis: new Date("2025-01-01"), jusquA: new Date("2026-03-01") } });
    await prisma.affiliation.create({ data: { personneId: ids.p2!, organisationId: ids.o1!, depuis: new Date("2026-03-01") } });

    // Deux pièces : une note du délégué (ouvrable par lui), un bulletin de paie (pièce du coffre : jamais au modèle).
    const note = await putBlob(Buffer.from(`Note ${TAG} : audit qualité du fournisseur Saidal, daclatasvir.`, "utf8"));
    await enregistrerFichierDrive(comptes.proprio, { parentId: null }, { blobId: note.blobId, size: note.size, mimeType: "text/plain", name: `${TAG} audit Saidal.txt`, sha256: note.sha256 });
    ids.note = `piece_${note.sha256}`;
    const emp = await prisma.employee.create({ data: { fullName: `${TAG} Employé`, userId: comptes.proprio.id } });
    const b = await putBlob(Buffer.from(`Bulletin ${TAG}. Salaire de base 185000.`, "utf8"));
    const doc = await prisma.employeeDocument.create({ data: { employeeId: emp.id, category: "PAYSLIP", name: `${TAG}bulletin.txt`, blobId: b.blobId, mime: "text/plain", size: b.size, visibleToEmployee: true } });
    await inscrireDocumentRh({ id: doc.id, blobId: b.blobId, sha256: b.sha256, nom: doc.name, mime: "text/plain", taille: b.size, deposeParId: null });
    ids.bulletin = `piece_${b.sha256}`;
    pieces.push(ids.note, ids.bulletin);
    for (let i = 0; i < 5; i++) if ((await traiterFile({ max: 20, seulement: pieces })).prises === 0) break;
    await prisma.pieceLien.createMany({ data: [
      { pieceId: ids.note, sujetType: "ORGANISATION", sujetId: ids.o1!, role: "MENTIONNE" },
      { pieceId: ids.bulletin, sujetType: "ORGANISATION", sujetId: ids.o1!, role: "MENTIONNE" },
    ] });
    // Des faits datés de Saidal : la raison sociale a changé (l'ancienne FERMÉE), un capital confirmé sur pièce.
    await prisma.faitConfirme.createMany({ data: [
      { id: `${TAG}f1`, sujetType: "ORGANISATION", sujetId: ids.o1!, attribut: "organisation.raisonSociale", valeur: "Saidal SARL", source: "PIECE", pieceId: ids.note, confirmeParId: comptes.admin.id, confirmeLe: new Date("2025-01-05"), valideDu: new Date("2025-01-01"), valideAu: new Date("2026-02-01"), actif: false, fermeLe: new Date("2026-02-03"), fermeParId: comptes.admin.id, remplaceParId: `${TAG}f2` },
      { id: `${TAG}f2`, sujetType: "ORGANISATION", sujetId: ids.o1!, attribut: "organisation.raisonSociale", valeur: "Groupe Saidal SPA", source: "PIECE", pieceId: ids.note, confirmeParId: comptes.admin.id, confirmeLe: new Date("2026-02-03"), valideDu: new Date("2026-02-01") },
      { id: `${TAG}f3`, sujetType: "ORGANISATION", sujetId: ids.o1!, attribut: "organisation.capital", valeur: "2500000000", source: "PIECE", pieceId: ids.note, confirmeLe: new Date("2026-02-03"), valideDu: new Date("2026-02-01") },
      { id: `${TAG}f4`, sujetType: "ORGANISATION", sujetId: ids.o1!, attribut: "organisation.iban", valeur: null, sensible: true, source: "PIECE", pieceId: ids.note },
    ] });
    oublierIndex();
  }, 120_000);

  afterAll(async () => {
    const orgIds = ORGS.map((o) => ids[o.k]!).filter(Boolean);
    await prisma.faitConfirme.deleteMany({ where: { sujetId: { in: orgIds } } }).catch(() => {});
    await prisma.pieceLien.deleteMany({ where: { pieceId: { in: pieces } } }).catch(() => {});
    await prisma.bibliothequeFiche.deleteMany({ where: { pieceId: { in: pieces } } }).catch(() => {});
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.piece.deleteMany({ where: { id: { in: pieces } } }).catch(() => {});
    await prisma.employeeDocument.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.employee.deleteMany({ where: { fullName: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.regulatoryProduct.deleteMany({ where: { reference: "REG-9026-014" } }).catch(() => {});
    await prisma.supplier.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { identityKey: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    await prisma.personne.deleteMany({ where: { creeParId: { in: [TAG, `${TAG}perf`] } } }).catch(() => {});
    await prisma.organisation.deleteMany({ where: { creeParId: { in: [TAG, `${TAG}perf`] } } }).catch(() => {});
    oublierIndex();
  }, 120_000);

  it("RÉSOLUTION ≥ 95 % sur le corpus semé (arabe/latin, fautes, sigles, NIF/RC, homonymes)", async () => {
    // L'index est celui que charge l'infra ; on le restreint aux fiches semées pour ne pas mesurer les restes d'autres tests.
    const semes = new Set(Object.values(ids));
    const index = await indexEntites();
    const corpus = indexer(index.candidats.filter((c) => semes.has(c.ref.split(":").slice(1).join(":"))));
    const cle = (ref: string) => Object.entries(ids).find(([, v]) => ref.endsWith(`:${v}`))?.[0];
    const fautes: string[] = [];
    for (const [mention, attendu] of CORPUS) {
      const r = resoudreDans(corpus, mention);
      const juste = attendu === null ? r.verdict === "INCONNU"
        : attendu === "?" ? r.verdict === "AMBIGU"
          : (r.verdict === "CERTAIN" || r.verdict === "PROBABLE") && cle(r.retenu!.candidat.ref) === attendu;
      if (!juste) fautes.push(`${mention} → ${r.verdict} ${r.retenu ? cle(r.retenu.candidat.ref) : r.candidats.map((c) => cle(c.candidat.ref)).join("/")} (attendu ${attendu})`);
    }
    const taux = 1 - fautes.length / CORPUS.length;
    console.info(`[banc J9] résolution : ${CORPUS.length - fautes.length}/${CORPUS.length} = ${(taux * 100).toFixed(1)} %`, fautes);
    expect(CORPUS.length).toBeGreaterThanOrEqual(100);
    expect(taux).toBeGreaterThanOrEqual(0.95);
  });

  it("la résolution juge les droits AVANT le verdict : un dossier hors droits n'est pas reconnu", async () => {
    const admin = await resoudreEntite(comptes.admin, "REG-9026-014");
    expect(admin.retenu?.candidat.ref).toBe(`DOSSIER:${ids.d1}`);
    const v = comptes.viewer;
    const r = await resoudreEntite(v, "REG-9026-014");
    if (!userCan(v, "REGULATORY", "VIEW")) expect(r.candidats.map((c) => c.candidat.ref)).not.toContain(`DOSSIER:${ids.d1}`);
  });

  it("qu'est-ce qui dépend de ce fournisseur ? — dossier, produit, responsable, demande, documents, chacun avec son chemin", async () => {
    const r = await explorerRelations(comptes.admin, `ORGANISATION:${ids.o1}`, { profondeur: 3 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const refs = r.noeuds.map((n) => n.ref);
    expect(refs).toEqual(expect.arrayContaining([`DOSSIER:${ids.d1}`, `PRODUIT:${ids.pr1}`, `PERSONNE:${ids.p3}`, `DEMANDE_AD_PRO:s:${ids.s1}`, `DOCUMENT:${ids.note}`, `PERSONNE:${ids.p1}`]));
    const produit = r.noeuds.find((n) => n.ref === `PRODUIT:${ids.pr1}`)!;
    expect(produit.chemin.map((e) => e.relation)).toEqual(["fourni_par", "concerne"]);
    for (const n of r.noeuds) for (const e of n.chemin) expect(e.source.table).toBeTruthy();
    // Le graphe tel qu'il était : en 2025, Mohamed Benali était affilié, Ahmed Benali pas encore.
    const avant = await explorerRelations(comptes.admin, `ORGANISATION:${ids.o1}`, { profondeur: 1, relations: ["affilie_a"], aLaDate: new Date("2025-06-01") });
    expect(avant.ok && avant.noeuds.map((n) => n.ref)).toEqual([`PERSONNE:${ids.p1}`]);
  });

  it("état à une date et provenance : la valeur d'alors, ce qu'on savait, qui a confirmé, ce qui a été fermé", async () => {
    const e = await etatALaDate(comptes.admin, `ORGANISATION:${ids.o1}`, new Date("2025-06-01"));
    expect(e.ok && e.valeurs.find((v) => v.attribut === "organisation.raisonSociale")?.valeur).toBe("Saidal SARL");
    expect(e.ok && e.inconnus).toContain("organisation.capital");
    const apres = await etatALaDate(comptes.admin, `ORGANISATION:${ids.o1}`, new Date("2026-06-01"));
    expect(apres.ok && apres.valeurs.find((v) => v.attribut === "organisation.raisonSociale")?.valeur).toBe("Groupe Saidal SPA");
    // Ce qu'on savait le 2 février 2026 de la raison sociale au 1er février : la fermeture n'était pas encore saisie.
    const su = await etatALaDate(comptes.admin, `ORGANISATION:${ids.o1}`, new Date("2026-02-01T12:00:00Z"), { connuLe: new Date("2026-02-02") });
    expect(su.ok && su.valeurs.filter((v) => v.attribut === "organisation.raisonSociale").map((v) => v.valeur)).toEqual(["Saidal SARL"]);
    const o = JSON.parse(await outilsGraphe(comptes.admin).find((t) => t.def.name === "d_ou_vient")!.run({ fait: `${TAG}f1` }, comptes.admin));
    expect(o.provenances[0].fermeture.remplacePar).toBe(`${TAG}f2`);
    expect(o.provenances[0].piece.id).toBe(ids.note);
    // Le fait sensible ne se rend jamais.
    const s = JSON.parse(await outilsGraphe(comptes.admin).find((t) => t.def.name === "d_ou_vient")!.run({ fait: `${TAG}f4` }, comptes.admin));
    expect(s.statut).toBe("INCONNU");
  });

  it("100 % DES CHIFFRES servis par les outils portent leur source", async () => {
    const appels: [string, Record<string, unknown>, CurrentUser][] = [
      ["explorer_relations", { entite: "Saidal", profondeur: 3 }, comptes.admin],
      ["explorer_relations", { entite: "مجمع صيدال", profondeur: 2, types: ["DOCUMENT"] }, comptes.admin],
      ["explorer_relations", { entite: "REG-9026-014", profondeur: 2 }, comptes.reg],
      ["explorer_relations", { entite: "Saidal", profondeur: 2, date: "2025-06-01" }, comptes.proprio],
      ["etat_a_une_date", { entite: "Groupe Saidal", date: "2026-06-01" }, comptes.admin],
      ["etat_a_une_date", { entite: "NIF 000116001234567", date: "2025-06-01" }, comptes.admin],
      ["etat_a_une_date", { entite: "Saidal", date: "2026-02-01", connu_le: "2026-02-02" }, comptes.proprio],
      ["etat_a_une_date", { entite: "Saidal" }, comptes.admin],
      ["d_ou_vient", { fait: `${TAG}f1` }, comptes.admin],
      ["d_ou_vient", { entite: "Saidal", attribut: "capital" }, comptes.admin],
      ["explorer_relations", { entite: "Benali" }, comptes.admin],
    ];
    let total = 0; let sourcees = 0;
    for (const [nom, entree, u] of appels) {
      const sortie = JSON.parse(await outilsGraphe(u).find((t) => t.def.name === nom)!.run(entree, u));
      expect(chiffresSansSource(sortie), `${nom} ${JSON.stringify(entree)}`).toEqual([]);
      const c = compterChiffres(sortie);
      total += c.total; sourcees += c.sourcees;
    }
    console.info(`[banc J9] chiffres servis : ${sourcees}/${total} avec leur source`);
    expect(total).toBeGreaterThan(30);
    expect(sourcees).toBe(total);
  });

  it("AUCUN RÉSULTAT HORS DROITS, par rôle — chaque nœud rejugé par la règle de l'écran", async () => {
    for (const nom of ["viewer", "proprio", "delegue", "reg", "admin"] as const) {
      const u = comptes[nom]!;
      const r = await explorerRelations(u, `ORGANISATION:${ids.o1}`, { profondeur: 3, pourModele: true });
      expect(r.ok, nom).toBe(true);
      if (!r.ok) continue;
      const parType = (t: string) => r.noeuds.filter((n) => typeDe(n.ref) === t).map((n) => n.ref.split(":").slice(1).join(":"));
      const dossiers = parType("DOSSIER");
      if (dossiers.length) expect(await prisma.regulatoryProduct.count({ where: { AND: [{ id: { in: dossiers } }, scopeRegulatory(u)] } }), nom).toBe(dossiers.length);
      const demandes = parType("DEMANDE_AD_PRO").map((x) => x.slice(2));
      if (demandes.length) expect(await prisma.sponsoringRequest.count({ where: { AND: [{ id: { in: demandes } }, scopeSponsoring(u)] } }), nom).toBe(demandes.length);
      const docs = parType("DOCUMENT");
      const ouvrables = await piecesOuvrables(u, docs);
      expect(docs.filter((d) => !ouvrables.has(d)), nom).toEqual([]);
      // La pièce du coffre ne part jamais au modèle, même au Super Admin.
      expect(docs, nom).not.toContain(ids.bulletin);
      // Rien n'est atteint À TRAVERS un dossier interdit : sans le dossier, ni son produit ni son responsable.
      if (!dossiers.includes(ids.d1!)) {
        expect(r.noeuds.map((n) => n.ref), nom).not.toContain(`PRODUIT:${ids.pr1}`);
      }
    }
    const v = comptes.viewer;
    const rv = await explorerRelations(v, `ORGANISATION:${ids.o1}`, { profondeur: 3 });
    if (rv.ok && !userCan(v, "REGULATORY", "VIEW") && !userCan(v, "REGULATORY_PIPELINE", "VIEW")) expect(rv.noeuds.some((n) => n.type === "DOSSIER")).toBe(false);
    const delegue = await explorerRelations(comptes.delegue, `ORGANISATION:${ids.o1}`, { profondeur: 1 });
    expect(delegue.ok && delegue.noeuds.map((n) => n.ref)).not.toContain(`DEMANDE_AD_PRO:s:${ids.s1}`);
    // Un départ hors droits : introuvable, rien n'est lu.
    if (!userCan(v, "REGULATORY", "VIEW")) expect((await explorerRelations(v, `DOSSIER:${ids.d1}`)).ok).toBe(false);
  });

  it("une famille de la console FERMÉE retire ses types du graphe, même au Super Admin", async () => {
    const t = outilsGraphe(comptes.admin, ["REGLEMENTAIRE", "DRIVE"]).find((o) => o.def.name === "explorer_relations")!;
    const r = JSON.parse(await t.run({ entite: "Saidal", profondeur: 3 }, comptes.admin));
    const types = new Set(r.resultats.map((n: { type: string }) => n.type));
    expect(types.has("dossier réglementaire")).toBe(false);
    expect(types.has("document")).toBe(false);
    expect(types.has("demande Ad & Pro")).toBe(true);
  });

  it("PARCOURS p95 < 300 ms sur 50 000 arêtes semées (profondeur 3)", async () => {
    const P = 5000; const O = 1000; const A = 50_000;
    const pers = Array.from({ length: P }, (_, i) => ({ id: `${TAG}pp${i}`, nom: `Perf${i}`, nomReplie: `perf${i}`, creeParId: `${TAG}perf` }));
    const orgs = Array.from({ length: O }, (_, i) => ({ id: `${TAG}po${i}`, raisonSociale: `PerfOrg${i}`, nomReplie: `perforg${i}`, creeParId: `${TAG}perf` }));
    await prisma.personne.createMany({ data: pers });
    await prisma.organisation.createMany({ data: orgs });
    await prisma.personneRole.createMany({ data: pers.map((p) => ({ personneId: p.id, role: "COLLABORATEUR" as const })) });
    let graine = 7;
    const hasard = (n: number) => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine % n; };
    const aff = Array.from({ length: A }, () => ({ personneId: `${TAG}pp${hasard(P)}`, organisationId: `${TAG}po${hasard(O)}` }));
    for (let i = 0; i < aff.length; i += 10_000) await prisma.affiliation.createMany({ data: aff.slice(i, i + 10_000) });
    expect(await prisma.affiliation.count({ where: { personne: { creeParId: `${TAG}perf` } } })).toBe(A);

    const mesurer = async (u: CurrentUser) => {
      const durees: number[] = [];
      for (let i = 0; i < 40; i++) {
        const depart = i % 2 ? `PERSONNE:${TAG}pp${hasard(P)}` : `ORGANISATION:${TAG}po${hasard(O)}`;
        const t0 = performance.now();
        const r = await explorerRelations(u, depart, { profondeur: 3 });
        durees.push(performance.now() - t0);
        expect(r.ok).toBe(true);
      }
      durees.sort((a, b) => a - b);
      return { p50: durees[19]!, p95: durees[37]! };
    };
    await explorerRelations(comptes.admin, `ORGANISATION:${TAG}po0`, { profondeur: 1 }); // chauffe
    const admin = await mesurer(comptes.admin);
    const viewer = await mesurer(comptes.viewer);
    console.info(`[banc J9] parcours profondeur 3 sur ${A} arêtes : Super Admin p50 ${admin.p50.toFixed(0)} ms, p95 ${admin.p95.toFixed(0)} ms ; lecteur p50 ${viewer.p50.toFixed(0)} ms, p95 ${viewer.p95.toFixed(0)} ms`);
    expect(admin.p95).toBeLessThan(300);
    expect(viewer.p95).toBeLessThan(300);
  }, 180_000);
});
