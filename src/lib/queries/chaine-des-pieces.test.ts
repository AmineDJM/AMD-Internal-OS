import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTEUR: unknown = null;
vi.mock("@/lib/session", () => ({
  requireUser: async () => ACTEUR, requireUserAuNomDeLaVue: async () => ACTEUR,
  getUser: async () => ACTEUR,
  requireModule: async () => ACTEUR,
}));

import { LegalDocKind } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { DOCUMENT_CATEGORY, LEGAL_DOC_KIND, natureLegale } from "@/lib/labels";
import { accesAuxPiecesLegal, canAccessEntity } from "@/lib/entity-access";
import fs from "node:fs";
import path from "node:path";
import {
  AD_PRO_DOC_CATEGORIES, PROMO_MATERIAL_DOC_CATEGORIES, categoriesDuDepotDeLaDemande, natureDeLaCategorie, naturesDEngagement,
} from "@/lib/ad-pro/doc-categories";
import { contextePiecesLiees } from "@/lib/ad-pro/pieces-liees";
import { rangerPiece } from "@/lib/legal/adoption";
import { createLegalDocument } from "@/lib/actions/legal-actions";
import { createInvoice } from "@/lib/actions/invoice-actions";
import { categorieDuPdf, chargerPiecesLiees, PAR_SECTION, sectionDeLaNature } from "./chaine-des-pieces";
import type { DocItem } from "@/components/documents/document-list";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES LIÉES D'UNE FICHE Ad & Pro — Devis → Bon de commande → Facture, puis Engagements
 * (§118.161). Décision de la Direction du 30/09/2026 : « enlève le bloc Documents (devis, BC,
 * quittance, matériel, visa, facture…) au profit des pièces liées, restructurées en Devis → BC →
 * Facture, chacun avec sa version plateforme et son PDF, et une partie Engagement (conventions
 * d'orateurs, contrats, tout le reste). Enlève les BC des engagements. »
 *
 * Trois choses se prouvent ici, et aucune ne se prouve en relisant un rendu :
 *   1. la RÈGLE de classement (pure) — le BC n'est plus un engagement, rien ne disparaît ;
 *   2. les DROITS, pièce par pièce, par la porte même du serveur, avec des acteurs SANS vue
 *      globale (§118.104) — un document restreint ne montre pas ses fichiers à qui n'en est pas
 *      lecteur, même s'il a le module ;
 *   3. « Créer sa fiche » par le VRAI point d'entrée (l'action serveur) : le fichier déjà déposé
 *      est RANGÉ, jamais copié — et jamais volé à une autre fiche.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le classement — le BC quitte les engagements, rien ne disparaît", () => {
  it("chaque nature Legal a UNE section, et le bon de commande n'est PAS un engagement", () => {
    for (const kind of Object.values(LegalDocKind)) {
      const s = sectionDeLaNature(kind);
      expect(["QUOTE", "PURCHASE_ORDER", "INVOICE", "ENGAGEMENT"], kind).toContain(s);
    }
    // LA DEMANDE EXPLICITE : « Enlève les BC de engagements ».
    expect(sectionDeLaNature("PURCHASE_ORDER")).toBe("PURCHASE_ORDER");
    expect(sectionDeLaNature("QUOTE")).toBe("QUOTE");
    expect(sectionDeLaNature("INVOICE")).toBe("INVOICE");
    // « conventions d'orateurs, contrats, et tout autre chose » : le reste est un engagement.
    for (const k of ["AGREEMENT", "CONTRACT", "AMENDMENT", "NDA", "INSURANCE", "LICENSE", "LEASE", "OTHER"]) {
      expect(sectionDeLaNature(k), k).toBe("ENGAGEMENT");
    }
  });

  it("le formulaire propose en « Engagement » EXACTEMENT ce que la fiche range sous « Engagements »", () => {
    // Deux lecteurs d'une seule règle : si le formulaire proposait une nature que la fiche range
    // ailleurs, la pièce créée sous « Engagements » apparaîtrait dans une autre section.
    const engagement = naturesDEngagement();
    expect(engagement, "le BC n'est pas une nature d'engagement").not.toContain("PURCHASE_ORDER");
    for (const k of ["QUOTE", "INVOICE"]) expect(engagement, k).not.toContain(k);
    // Tout ce qu'on propose se range sous « Engagements »…
    for (const k of engagement) expect(sectionDeLaNature(k), k).toBe("ENGAGEMENT");
    // …et tout engagement CRÉABLE depuis un formulaire est proposé. L'avenant est la seule
    // exception, et elle est voulue : il naît de SON contrat (`amendsId`, impact marché), jamais
    // d'un formulaire générique — mais il se range bien sous « Engagements » quand on le rattache.
    const creables = Object.keys(LEGAL_DOC_KIND).filter((k) => sectionDeLaNature(k) === "ENGAGEMENT");
    expect([...engagement].sort()).toEqual([...creables].sort());
    expect(engagement, "un avenant sans son contrat serait une pièce mal formée").not.toContain("AMENDMENT");
    expect(sectionDeLaNature("AMENDMENT")).toBe("ENGAGEMENT");
    // …et les deux lecteurs LISENT cette règle au lieu de la réécrire (§118.49 : le point
    // d'appel, pas le corps). Le code est lu sans ses commentaires, qui la citent forcément.
    const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const formulaire = code("src/components/shared/attach-to-source.tsx");
    expect(formulaire, "le formulaire doit lire la règle partagée").toMatch(/naturesDEngagement\(\)/);
    expect(formulaire, "le formulaire réécrit sa propre liste de la chaîne").not.toMatch(/new Set\(\s*\[\s*"QUOTE"/);
    const chargeur = code("src/lib/queries/chaine-des-pieces.ts");
    expect(chargeur, "le chargeur réécrit la règle au lieu de la lire").not.toMatch(/function\s+sectionDeLaNature/);
    expect(chargeur).toMatch(/sectionDeLaNature\(/);
  });

  it("chaque nature du schéma s'AFFICHE en français — jamais le nom de l'énumération", () => {
    // L'avenant manquait à la table des libellés : la liste de Legal et les pièces liées
    // affichaient « AMENDMENT ». Ce qui le ferait tomber : une nature ajoutée au schéma sans son
    // libellé d'affichage.
    for (const kind of Object.values(LegalDocKind)) {
      expect(natureLegale(kind), kind).not.toBe(kind);
    }
    expect(natureLegale("AMENDMENT")).toBe("Avenant");
    // La liste des natures CRÉABLES n'a pas bougé : l'avenant n'y entre pas.
    expect(Object.keys(LEGAL_DOC_KIND)).not.toContain("AMENDMENT");
    // …et plus AUCUN écran n'affiche une nature en indexant la liste des créables : c'est ce qui
    // faisait lire « AMENDMENT » à la place d'« Avenant » (§118.58 — on cherche tous les lecteurs).
    const fautifs: string[] = [];
    const parcourir = (d: string) => {
      for (const e of fs.readdirSync(path.join(process.cwd(), d), { withFileTypes: true })) {
        const rel = path.join(d, e.name);
        if (e.isDirectory()) parcourir(rel);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) && /LEGAL_DOC_KIND\[/.test(fs.readFileSync(path.join(process.cwd(), rel), "utf8"))) fautifs.push(rel);
      }
    };
    parcourir("src");
    expect(fautifs, "afficher une nature passe par `natureLegale`").toEqual([]);
  });

  it("le PDF joint à une pièce se classe dans une catégorie qui EXISTE, selon sa nature", () => {
    for (const kind of Object.values(LegalDocKind)) {
      expect(DOCUMENT_CATEGORY[categorieDuPdf(kind)], kind).toBeTruthy();
    }
    expect(categorieDuPdf("QUOTE")).toBe("QUOTE");
    expect(categorieDuPdf("PURCHASE_ORDER")).toBe("PURCHASE_ORDER");
    expect(categorieDuPdf("INVOICE")).toBe("INVOICE");
    expect(categorieDuPdf("AGREEMENT")).toBe("CONVENTION");
  });

  it("le dépôt de la demande perd EXACTEMENT les quatre catégories qui ont désormais une fiche", () => {
    // Ce qui le ferait tomber : en retirer une de trop (la photo, la demande du médecin — des
    // pièces de la demande, qu'on ne saurait plus déposer) ou en oublier une (un devis encore
    // déposable comme simple fichier, la double saisie qu'on ferme).
    const retirees = (l: readonly string[]) => l.filter((c) => !categoriesDuDepotDeLaDemande(l).includes(c)).sort();
    expect(retirees(AD_PRO_DOC_CATEGORIES)).toEqual(["CONVENTION", "INVOICE", "PURCHASE_ORDER", "QUOTE"]);
    expect(retirees(PROMO_MATERIAL_DOC_CATEGORIES)).toEqual(["INVOICE", "PURCHASE_ORDER", "QUOTE"]);
    // La demande du médecin, les photos, la quittance, le visa restent des pièces de la demande.
    for (const c of ["REQUEST_LETTER", "PHOTO", "PROGRAM", "SUPPORTING_DOC", "OTHER"]) {
      expect(categoriesDuDepotDeLaDemande(AD_PRO_DOC_CATEGORIES), c).toContain(c);
    }
    for (const c of ["PAYMENT_RECEIPT", "AD_VISA", "PROMO_MATERIAL_FILE", "DELIVERY_NOTE"]) {
      expect(categoriesDuDepotDeLaDemande(PROMO_MATERIAL_DOC_CATEGORIES), c).toContain(c);
    }
    expect(natureDeLaCategorie("CONVENTION")).toBe("AGREEMENT");
    expect(natureDeLaCategorie("PHOTO")).toBeNull();
    expect(natureDeLaCategorie(null)).toBeNull();
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__chaine161__";
const fd = (o: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(o)) f.set(k, v);
  return f;
};

async function acteur(id: string, role: string): Promise<SessionUser> {
  return { id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser;
}

suite("les pièces liées d'une fiche — droits pièce par pièce, et « Créer sa fiche »", () => {
  let admin = "", assistante = "", delegue = "", lecteur = "";
  let spo = "", autreSpo = "", promo = "";
  let devis = "", bc = "", facture = "", convention = "", contrat = "", restreint = "", piecePromo = "";
  let partieId = "";
  let A: SessionUser, D: SessionUser, L: SessionUser;

  const nettoyer = async () => {
    const legaux = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    const ids = legaux.map((l) => l.id);
    await prisma.document.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.updateMany({ where: { id: { in: ids } }, data: { chainFromId: null } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.promoMaterial.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.companyContact.deleteMany({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  };

  beforeAll(async () => {
    await nettoyer();
    const mk = (s: string, role: string) =>
      prisma.user.create({ data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" } });
    const [a, as, d, l] = await Promise.all([
      mk("admin", "SUPER_ADMIN"), mk("assistante", "DIRECTION_ASSISTANT"), mk("delegue", "MEDICAL_DELEGATE"), mk("lecteur", "DIRECTION_ASSISTANT"),
    ]);
    admin = a.id; assistante = as.id; delegue = d.id; lecteur = l.id;
    A = await acteur(assistante, "DIRECTION_ASSISTANT");
    D = await acteur(delegue, "MEDICAL_DELEGATE");
    L = await acteur(lecteur, "DIRECTION_ASSISTANT");

    const [s1, s2] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}CHU`, type: "Congrès", createdById: admin } }),
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-2`, institution: `${TAG}Clinique`, type: "Congrès", createdById: admin } }),
    ]);
    spo = s1.id; autreSpo = s2.id;
    const pm = await prisma.promoMaterial.create({ data: { reference: `${TAG}MP-1`, title: `${TAG}Brochure`, requesterId: delegue } });
    promo = pm.id;

    const src = { sourceType: "SPONSORING" as const, sourceId: spo, createdById: admin };
    const dv = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Devis traiteur`, reference: `${TAG}DEV-1`, kind: "QUOTE" } });
    const b = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}BC traiteur`, reference: `${TAG}BC-1`, kind: "PURCHASE_ORDER", chainFromId: dv.id } });
    const f = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Facture traiteur`, reference: `${TAG}FA-1`, kind: "INVOICE", chainFromId: b.id } });
    const cv = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Convention orateur`, kind: "AGREEMENT" } });
    const ct = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Contrat hôtel`, kind: "CONTRACT" } });
    // RESTREINT à un lecteur désigné : la personne qui n'en est pas ne doit voir QUE la ligne.
    const r = await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Convention confidentielle`, kind: "AGREEMENT" } });
    await prisma.legalDocumentReader.create({ data: { documentId: r.id, userId: lecteur, grantedById: admin } });
    const pp = await prisma.legalDocument.create({ data: { sourceType: "PROMO_MATERIAL", sourceId: promo, createdById: admin, title: `${TAG}BC brochure`, kind: "PURCHASE_ORDER" } });
    devis = dv.id; bc = b.id; facture = f.id; convention = cv.id; contrat = ct.id; restreint = r.id; piecePromo = pp.id;

    await prisma.document.createMany({
      data: [
        { name: `${TAG}devis-signe.pdf`, category: "QUOTE", entityType: "LEGAL_DOCUMENT", entityId: devis, uploadedById: admin },
        { name: `${TAG}secret.pdf`, category: "CONVENTION", entityType: "LEGAL_DOCUMENT", entityId: restreint, uploadedById: admin },
      ],
    });
    const contact = await prisma.companyContact.create({ data: { name: `${TAG}Traiteur SARL`, createdById: admin } as never });
    partieId = contact.id;
  });

  afterAll(nettoyer);

  it("LA PORTE UNITAIRE ET LA PORTE EN LOT DISENT LA MÊME CHOSE, pièce par pièce", async () => {
    // `canAccessEntity` n'est plus que l'appel de `accesAuxPiecesLegal` sur UN identifiant — ce
    // cas exige qu'ils répondent pareil sur chaque (acteur, pièce, geste), sans quoi l'écran
    // proposerait un geste que le serveur refuse, ou l'inverse.
    const ids = [devis, bc, facture, convention, contrat, restreint, piecePromo];
    for (const u of [A, D, L]) {
      const lot = await accesAuxPiecesLegal(u, ids, ["VIEW", "UPLOAD", "UPDATE", "DELETE"]);
      for (const id of ids) {
        for (const a of ["VIEW", "UPLOAD", "UPDATE", "DELETE"] as const) {
          expect(lot.get(a)!.has(id), `${u.role} ${a} ${id}`).toBe(await canAccessEntity(u, "LEGAL_DOCUMENT", id, a));
        }
      }
    }
  });

  it("un document RESTREINT ne s'ouvre qu'à ses lecteurs — même pour qui a le module Legal", async () => {
    expect(userCan(A, "LEGAL", "VIEW"), "prémisse : l'assistante a le module Legal").toBe(true);
    const pourA = await accesAuxPiecesLegal(A, [restreint, convention], ["VIEW", "UPLOAD"]);
    expect(pourA.get("VIEW")!.has(convention)).toBe(true);
    expect(pourA.get("VIEW")!.has(restreint), "le module ne suffit pas").toBe(false);
    expect(pourA.get("UPLOAD")!.has(restreint)).toBe(false);
    const pourL = await accesAuxPiecesLegal(L, [restreint], ["VIEW", "UPLOAD"]);
    expect(pourL.get("VIEW")!.has(restreint), "le lecteur désigné l'ouvre").toBe(true);
  });

  it("sans le module Legal : rien — sauf les pièces du matériel promotionnel dont on OUVRE le dossier", async () => {
    expect(userCan(D, "LEGAL", "VIEW"), "prémisse : le délégué n'a pas Legal").toBe(false);
    const r = await accesAuxPiecesLegal(D, [devis, bc, piecePromo], ["VIEW", "UPLOAD"]);
    expect([...r.get("VIEW")!]).toEqual([piecePromo]);
    expect(r.get("UPLOAD")!.size, "l'exception est une LECTURE, jamais un dépôt").toBe(0);
  });

  it("la fiche lit Devis → BC → Facture, puis les engagements — et le BC n'y est PLUS", async () => {
    const ctx = await contextePiecesLiees(A, "SPONSORING");
    const fichierLibre = (id: string, name: string, category: string): DocItem => ({
      id, name, category, version: 1, sizeBytes: 10, confidentiality: "INTERNAL", uploadedBy: null, createdAt: new Date().toISOString(), hasFile: true,
    });
    const p = await chargerPiecesLiees({
      entityType: "SPONSORING", entityId: spo, canCreate: true,
      spectateur: A, courriers: false, creer: ctx.acces.creer,
      documentsDeLaFiche: [
        fichierLibre("x1", "Devis INSIGNE.pdf", "QUOTE"),
        fichierLibre("x2", "Convention signée.pdf", "CONVENTION"),
        fichierLibre("x3", "Photo du stand.jpg", "PHOTO"),
      ],
    });
    expect(p.sections.QUOTE.map((l) => l.id)).toEqual([devis]);
    expect(p.sections.PURCHASE_ORDER.map((l) => l.id)).toEqual([bc]);
    expect(p.sections.INVOICE.map((l) => l.id)).toEqual([facture]);
    expect(p.sections.ENGAGEMENT.map((l) => l.id).sort()).toEqual([contrat, convention, restreint].sort());
    expect(p.sections.ENGAGEMENT.map((l) => l.id), "LA DEMANDE : le BC n'est pas un engagement").not.toContain(bc);

    // Le « → » : le BC dit de quel devis il découle, la facture de quel BC.
    expect(p.sections.PURCHASE_ORDER[0]!.meta).toContain(`découle du devis ${TAG}DEV-1`);
    expect(p.sections.INVOICE[0]!.meta).toContain(`découle du BC ${TAG}BC-1`);

    // Les droits, pièce par pièce : le devis s'ouvre et reçoit un PDF de SA catégorie…
    const ld = p.sections.QUOTE[0]!;
    expect(ld.documents?.map((d) => d.name)).toEqual([`${TAG}devis-signe.pdf`]);
    expect(ld.joindre).toBe("QUOTE");
    // …la convention restreinte montre sa LIGNE, pas ses fichiers, et ne reçoit rien.
    const lr = p.sections.ENGAGEMENT.find((l) => l.id === restreint)!;
    expect(lr.documents, "rien n'est chargé de ce qu'on ne peut pas ouvrir").toBeNull();
    expect(lr.joindre).toBeNull();

    // Les fichiers déjà déposés : rangés dans la section de leur nature, rien ne disparaît.
    expect(p.libres.QUOTE.map((d) => d.id)).toEqual(["x1"]);
    expect(p.libres.AGREEMENT.map((d) => d.id)).toEqual(["x2"]);
    expect(p.propres.map((d) => d.id)).toEqual(["x3"]);

    // Ce qu'on peut créer d'ici — l'assistante tient Legal.
    expect(p.droitDeCreer).toMatchObject({ quote: true, order: true, invoice: true, legal: true });
    expect(p.devisAmont.map((m) => m.value)).toEqual([devis]);
    expect(p.bonsAmont.map((m) => m.value)).toEqual([bc]);
  });

  it("sans Legal : les lignes sont là, les fichiers non, et AUCUN bouton de création", async () => {
    const ctx = await contextePiecesLiees(D, "SPONSORING");
    const p = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: spo, canCreate: true, spectateur: D, creer: ctx.acces.creer });
    expect(p.sections.QUOTE.map((l) => l.id)).toEqual([devis]);
    expect(p.sections.QUOTE[0]!.documents).toBeNull();
    expect(p.sections.QUOTE[0]!.joindre).toBeNull();
    // Un bouton qui refuse ensuite fait chercher la panne : il n'est pas offert.
    expect(p.droitDeCreer).toMatchObject({ quote: false, order: false, invoice: false, legal: false });
  });

  it("une section COUPÉE le dit : le total vient de la base, pas de ce qu'on affiche", async () => {
    const n = PAR_SECTION + 2;
    await prisma.legalDocument.createMany({
      data: Array.from({ length: n }, (_, i) => ({
        sourceType: "SPONSORING" as const, sourceId: autreSpo, createdById: admin, title: `${TAG}Devis ${i}`, kind: "QUOTE" as const,
      })),
    });
    const p = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: autreSpo, canCreate: false, spectateur: A });
    expect(p.sections.QUOTE.length).toBe(PAR_SECTION);
    expect(p.totaux.QUOTE).toBe(n);
  });

  it("un devis ANNULÉ reste affiché — mais ne se propose plus comme amont d'un BC", async () => {
    // Le montrer garde l'histoire de la demande ; le proposer ferait naître un BC d'un devis que
    // personne ne retient plus. Ce qui le ferait tomber : filtrer l'affichage (l'histoire perdue)
    // ou ne rien filtrer (un amont mort offert en premier choix).
    const s3 = await prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-3`, institution: `${TAG}EPH`, type: "Congrès", createdById: admin } });
    const src3 = { sourceType: "SPONSORING" as const, sourceId: s3.id, createdById: admin };
    const vivant = await prisma.legalDocument.create({ data: { ...src3, title: `${TAG}Devis retenu`, kind: "QUOTE" } });
    const annule = await prisma.legalDocument.create({ data: { ...src3, title: `${TAG}Devis écarté`, kind: "QUOTE", status: "CANCELLED" } });
    const bcAnnule = await prisma.legalDocument.create({ data: { ...src3, title: `${TAG}BC écarté`, kind: "PURCHASE_ORDER", status: "CANCELLED" } });
    const p = await chargerPiecesLiees({ entityType: "SPONSORING", entityId: s3.id, canCreate: true, spectateur: A });
    expect(p.sections.QUOTE.map((l) => l.id).sort()).toEqual([vivant.id, annule.id].sort());
    expect(p.sections.QUOTE.find((l) => l.id === annule.id)?.badge?.label).toBe("Annulé");
    expect(p.devisAmont.map((m) => m.value)).toEqual([vivant.id]);
    expect(p.sections.PURCHASE_ORDER.map((l) => l.id)).toEqual([bcAnnule.id]);
    expect(p.bonsAmont, "une facture ne découle pas d'un BC annulé").toEqual([]);
  });

  it("« Créer sa fiche » par la VRAIE action : le fichier est RANGÉ, pas copié", async () => {
    // Le fichier a été déposé par l'assistante elle-même : elle peut le gérer (la règle du
    // renommage), et elle tient Legal — les deux droits que ranger exige.
    const doc = await prisma.document.create({
      data: { name: `${TAG}Devis INSIGNE.pdf`, category: "QUOTE", entityType: "SPONSORING", entityId: spo, uploadedById: assistante },
    });
    ACTEUR = A;
    const r = await createLegalDocument(undefined, fd({
      sourceType: "SPONSORING", sourceId: spo, kind: "QUOTE", title: `${TAG}Devis INSIGNE`,
      counterpartyIds: partieId, pieceExistanteId: doc.id,
    }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toContain("rangé");
    const apres = await prisma.document.findUnique({ where: { id: doc.id }, select: { entityType: true, entityId: true } });
    expect(apres).toEqual({ entityType: "LEGAL_DOCUMENT", entityId: r.ok ? r.id : "" });
    expect(await prisma.document.count({ where: { name: `${TAG}Devis INSIGNE.pdf` } }), "rangé, jamais copié").toBe(1);
    const cree = await prisma.legalDocument.findUnique({ where: { id: r.ok ? r.id! : "" }, select: { kind: true, sourceType: true, sourceId: true } });
    expect(cree).toEqual({ kind: "QUOTE", sourceType: "SPONSORING", sourceId: spo });
  });

  it("un fichier d'une AUTRE fiche ne se range pas — et RIEN n'est créé", async () => {
    const doc = await prisma.document.create({
      data: { name: `${TAG}BC ailleurs.pdf`, category: "PURCHASE_ORDER", entityType: "SPONSORING", entityId: autreSpo, uploadedById: assistante },
    });
    const avant = await prisma.legalDocument.count({ where: { title: `${TAG}BC volé` } });
    ACTEUR = A;
    const r = await createLegalDocument(undefined, fd({
      sourceType: "SPONSORING", sourceId: spo, kind: "PURCHASE_ORDER", title: `${TAG}BC volé`,
      counterpartyIds: partieId, pieceExistanteId: doc.id,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("n'est pas déposé sur cette fiche");
    expect(await prisma.legalDocument.count({ where: { title: `${TAG}BC volé` } }), "refusé AVANT d'écrire").toBe(avant);
    expect((await prisma.document.findUnique({ where: { id: doc.id } }))?.entityId).toBe(autreSpo);
  });

  it("un fichier qu'on ne peut pas gérer sur sa fiche ne se range pas", async () => {
    // Déposé par le délégué ; l'assistante ne peut ni modifier ni supprimer la fiche de
    // sponsoring — la PRÉMISSE est vérifiée, sans elle ce cas ne mesurerait rien.
    expect(await canAccessEntity(A, "SPONSORING", spo, "UPDATE"), "prémisse").toBe(false);
    expect(await canAccessEntity(A, "SPONSORING", spo, "DELETE"), "prémisse").toBe(false);
    const doc = await prisma.document.create({
      data: { name: `${TAG}Devis du délégué.pdf`, category: "QUOTE", entityType: "SPONSORING", entityId: spo, uploadedById: delegue },
    });
    ACTEUR = A;
    const r = await createLegalDocument(undefined, fd({
      sourceType: "SPONSORING", sourceId: spo, kind: "QUOTE", title: `${TAG}Devis pas à moi`,
      counterpartyIds: partieId, pieceExistanteId: doc.id,
    }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ne pouvez pas déplacer");
    expect((await prisma.document.findUnique({ where: { id: doc.id } }))?.entityType).toBe("SPONSORING");
  });

  it("ranger ne vise que la ligne restée sur sa fiche : déplacée entre-temps, rien ne bouge", async () => {
    const doc = await prisma.document.create({
      data: { name: `${TAG}déjà parti.pdf`, category: "QUOTE", entityType: "SPONSORING", entityId: autreSpo, uploadedById: assistante },
    });
    const range = await rangerPiece(A, doc.id, { type: "SPONSORING", id: spo }, devis);
    expect(range).toBeNull();
    expect((await prisma.document.findUnique({ where: { id: doc.id } }))?.entityId).toBe(autreSpo);
  });

  it("la facture dit de quel BC elle découle — et un BC inventé est refusé AVANT d'écrire", async () => {
    ACTEUR = A;
    const ok = await createInvoice(undefined, fd({ sourceType: "SPONSORING", sourceId: spo, title: `${TAG}Facture 2`, chainFromId: bc }));
    expect(ok.ok, ok.ok ? "" : ok.error).toBe(true);
    expect((await prisma.legalDocument.findUnique({ where: { id: ok.ok ? ok.id! : "" }, select: { chainFromId: true } }))?.chainFromId).toBe(bc);

    const avant = await prisma.legalDocument.count({ where: { title: `${TAG}Facture fantôme` } });
    const ko = await createInvoice(undefined, fd({ sourceType: "SPONSORING", sourceId: spo, title: `${TAG}Facture fantôme`, chainFromId: "inexistant" }));
    expect(ko.ok).toBe(false);
    // Le refus NOMME la faute — pas une erreur de clé étrangère lâchée par la base.
    if (!ko.ok) expect(ko.error).toContain("n'existe plus");
    expect(await prisma.legalDocument.count({ where: { title: `${TAG}Facture fantôme` } })).toBe(avant);
  });

  it("« Créer sa fiche » d'une facture range aussi le fichier", async () => {
    const doc = await prisma.document.create({
      data: { name: `${TAG}Facture scannée.pdf`, category: "INVOICE", entityType: "SPONSORING", entityId: spo, uploadedById: assistante },
    });
    ACTEUR = A;
    const r = await createInvoice(undefined, fd({ sourceType: "SPONSORING", sourceId: spo, title: `${TAG}Facture scannée`, pieceExistanteId: doc.id }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(r.message).toContain("rangé");
    expect((await prisma.document.findUnique({ where: { id: doc.id } }))?.entityId).toBe(r.ok ? r.id : "");
  });
});
