import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "@/lib/prisma";
import { retirerDocumentsEtContenu } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, hasGlobalView, type SessionUser } from "@/lib/rbac";
import { chargerPiecesLegalDeLaDemande, clausePiecesDeLaDemande } from "./pieces-legal-demande";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES PIÈCES LEGAL RATTACHÉES DIRECTEMENT À UNE DEMANDE — « elles doivent s'afficher même sur la
 * demande » (Direction, 04/10). Trois propriétés, prouvées sur la base avec des acteurs SANS vue
 * globale (§118.104) :
 *   1. une pièce rattachée à la demande et à AUCUN de ses postes s'affiche — et une pièce qu'un
 *      poste de la demande porte, non (elle est déjà sur la carte du poste) ;
 *   2. ce que la personne ne peut pas ouvrir n'est PAS rendu — ni titre, ni fichiers — mais COMPTÉ ;
 *   3. les quatre fiches qui ont perdu « Pièces liées » montent le composant (le point d'appel).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__pldem__";

async function acteur(id: string, role: string): Promise<SessionUser> {
  return { id, role, secondaryRole: null, access: await getAccess(id, role as never) } as unknown as SessionUser;
}

describe("la clause — hors postes seulement là où il y a des postes", () => {
  it("une demande à postes exclut les pièces de SES postes ; une autre nature n'a pas de filtre de poste", () => {
    const spo = clausePiecesDeLaDemande("SPONSORING", "s1");
    expect(spo).toMatchObject({ sourceType: "SPONSORING", sourceId: "s1", postesAdPro: { none: { item: { sponsoringId: "s1" } } } });
    expect(clausePiecesDeLaDemande("CONGRESS_NATIONAL", "c1")).toMatchObject({ postesAdPro: { none: { item: { congressNationalId: "c1" } } } });
    expect(clausePiecesDeLaDemande("EVENT", "e1")).toMatchObject({ postesAdPro: { none: { item: { eventId: "e1" } } } });
    expect(clausePiecesDeLaDemande("CONSULTING_CONTRACT", "k1")).toEqual({ sourceType: "CONSULTING_CONTRACT", sourceId: "k1" });
  });
});

describe("le point d'appel — les quatre fiches qui ont perdu « Pièces liées »", () => {
  it("chaque fiche monte le composant avec SA nature", () => {
    const code = (rel: string) => fs.readFileSync(path.join(process.cwd(), rel), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
    const pages: [string, string][] = [
      ["src/app/(app)/sponsoring/[id]/page.tsx", "SPONSORING"],
      ["src/app/(app)/events/[id]/page.tsx", "EVENT"],
      ["src/app/(app)/congress-international/[id]/page.tsx", "CONGRESS_INTERNATIONAL"],
      ["src/app/(app)/congress-national/[id]/page.tsx", "CONGRESS_NATIONAL"],
    ];
    for (const [rel, nature] of pages) {
      expect(code(rel), rel).toMatch(new RegExp(`<PiecesLegalDeLaDemande\\s+spectateur=\\{user\\}\\s+entityType="${nature}"`));
    }
  });
});

suite("les pièces Legal de la demande — hors postes, droits pièce par pièce", () => {
  let admin = "", assistante = "", delegue = "", lecteur = "";
  let spo = "", autreSpo = "", poste = "";
  let convention = "", devisDuPoste = "", restreinte = "", ailleurs = "";
  let A: SessionUser, D: SessionUser;

  const nettoyer = async () => {
    const legaux = await prisma.legalDocument.findMany({ where: { title: { startsWith: TAG } }, select: { id: true } });
    const ids = legaux.map((l) => l.id);
    await retirerDocumentsEtContenu({ where: { name: { startsWith: TAG } } }).catch(() => {});
    await prisma.adProItemPiece.deleteMany({ where: { legalDocumentId: { in: ids } } }).catch(() => {});
    await prisma.legalDocumentReader.deleteMany({ where: { documentId: { in: ids } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { id: { in: ids } } }).catch(() => {});
    await prisma.adProItem.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.sponsoringRequest.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
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

    const [s1, s2] = await Promise.all([
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-1`, institution: `${TAG}CHU`, type: "Congrès", createdById: admin } }),
      prisma.sponsoringRequest.create({ data: { reference: `${TAG}SPO-2`, institution: `${TAG}EPH`, type: "Congrès", createdById: admin } }),
    ]);
    spo = s1.id; autreSpo = s2.id;
    poste = (await prisma.adProItem.create({ data: { sponsoringId: spo, kind: "OTHER", label: `${TAG}Traiteur` } })).id;

    const src = { sourceType: "SPONSORING" as const, sourceId: spo, createdById: admin };
    convention = (await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Convention orateur`, kind: "AGREEMENT", amount: 120_000 } })).id;
    devisDuPoste = (await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Devis du poste`, kind: "QUOTE" } })).id;
    await prisma.adProItemPiece.create({ data: { itemId: poste, legalDocumentId: devisDuPoste, nature: "DEVIS" } });
    restreinte = (await prisma.legalDocument.create({ data: { ...src, title: `${TAG}Contrat confidentiel`, kind: "CONTRACT" } })).id;
    await prisma.legalDocumentReader.create({ data: { documentId: restreinte, userId: lecteur, grantedById: admin } });
    ailleurs = (await prisma.legalDocument.create({ data: { sourceType: "SPONSORING", sourceId: autreSpo, createdById: admin, title: `${TAG}Convention ailleurs`, kind: "AGREEMENT" } })).id;

    await prisma.document.createMany({
      data: [
        { name: `${TAG}convention-signee.pdf`, category: "CONVENTION", entityType: "LEGAL_DOCUMENT", entityId: convention, uploadedById: admin },
        { name: `${TAG}secret.pdf`, category: "OTHER", entityType: "LEGAL_DOCUMENT", entityId: restreinte, uploadedById: admin },
      ],
    });
  });

  afterAll(nettoyer);

  it("l'assistante (Legal, sans vue globale) voit la pièce de la demande, pas celle du poste, et la restreinte est COMPTÉE", async () => {
    expect(hasGlobalView(A.role), "prémisse : pas de vue globale").toBe(false);
    expect(userCan(A, "LEGAL", "VIEW"), "prémisse : elle lit Legal").toBe(true);
    const p = await chargerPiecesLegalDeLaDemande(A, "SPONSORING", spo);
    expect(p.lignes.map((l) => l.id)).toEqual([convention]);
    expect(p.lignes.map((l) => l.id), "la pièce d'un poste est déjà sur sa carte").not.toContain(devisDuPoste);
    expect(p.lignes.map((l) => l.id), "une pièce d'une AUTRE demande n'est pas d'ici").not.toContain(ailleurs);
    expect(p.total, "convention + restreinte, hors poste").toBe(2);
    expect(p.masquees, "la restreinte n'est pas rendue mais elle est dite").toBe(1);
    const l = p.lignes[0]!;
    expect(l).toMatchObject({ nature: "Convention / accord-cadre", montant: 120_000, fiche: true });
    expect(l.statut?.label).toBeTruthy();
    expect(l.documents.map((d) => d.name)).toEqual([`${TAG}convention-signee.pdf`]);
    // RIEN n'est rendu de ce qu'on ne peut pas ouvrir : ni la ligne, ni le fichier secret.
    expect(JSON.stringify(p)).not.toContain(`${TAG}secret.pdf`);
    expect(JSON.stringify(p)).not.toContain(`${TAG}Contrat confidentiel`);
  });

  it("le délégué SANS Legal : aucune ligne, et les deux pièces sont comptées", async () => {
    expect(userCan(D, "LEGAL", "VIEW"), "prémisse : le délégué n'a pas Legal").toBe(false);
    const p = await chargerPiecesLegalDeLaDemande(D, "SPONSORING", spo);
    expect(p.lignes).toEqual([]);
    expect(p.masquees).toBe(2);
  });

  it("une demande sans pièce directe ne rend rien à afficher", async () => {
    await prisma.legalDocument.delete({ where: { id: ailleurs } });
    const p = await chargerPiecesLegalDeLaDemande(A, "SPONSORING", autreSpo);
    expect(p).toMatchObject({ lignes: [], total: 0, masquees: 0, nonLues: 0 });
  });
});
