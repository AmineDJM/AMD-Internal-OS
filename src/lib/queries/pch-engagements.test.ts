import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { loadEngagementsAilleurs, reserveEngagement } from "./pch-engagements";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__engag__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « CE PRODUIT EST DÉJÀ ENGAGÉ AILLEURS » — par le VRAI point d'entrée.
 *
 * Le module pur décide (`pch/rattachement-produit.test.ts`, 21 cas) ; ici on vérifie que la
 * lecture APPELLE ces vocabulaires, que la garde de Legal existe, et qu'elle peut ÉCHOUER
 * (§118.104 : une garde qu'on ne peut pas faire tomber est une décoration).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("engagements ailleurs — la cardinalité, au moment du chiffrage", () => {
  let produitId = "", autreProduitId = "";
  let aoCourant = "", aoVivant = "", aoClos = "";
  let contratId = "";
  let sa: SessionUser, pchSeul: SessionUser;

  beforeAll(async () => {
    const mk = async (s: string, role: string) => {
      const u = await prisma.user.create({
        data: { name: `${TAG}${s}`, email: `${TAG}${s}@t.dz`, role: role as never, passwordHash: "x" },
      });
      return { id: u.id, name: u.name, email: u.email, role, secondaryRole: null, access: await getAccess(u.id, role as never), mustChangePassword: false } as unknown as SessionUser;
    };
    [sa, pchSeul] = await Promise.all([mk("admin", "SUPER_ADMIN"), mk("pch", "LOGISTICS_MANAGER")]);

    const prod = async (n: string) => prisma.product.create({
      data: { code: `${TAG}${n}`, canonicalName: `${TAG}${n}`, dci: `${TAG}${n}`, identityKey: `${TAG}${n}` },
    });
    [produitId, autreProduitId] = (await Promise.all([prod("Nivo"), prod("Pembro")])).map((p) => p.id);

    const ao = async (ref: string, statut: string) => prisma.pchTender.create({
      data: { reference: `${TAG}${ref}`, title: `AO ${ref}`, status: statut as never, createdById: sa.id },
    });
    [aoCourant, aoVivant, aoClos] = (await Promise.all([
      ao("AO-COURANT", "IN_PROGRESS"), ao("AO-VIVANT", "IN_PROGRESS"), ao("AO-CLOS", "COMPLETED"),
    ])).map((t) => t.id);

    const ligne = (tenderId: string, productId: string, status: string) => prisma.pchTenderLine.create({
      data: { tenderId, productId, designation: `${TAG}lot`, quantityUnits: 100, status: status as never },
    });
    await Promise.all([
      ligne(aoCourant, produitId, "QUOTED"),
      ligne(aoVivant, produitId, "SUBMITTED"),
      ligne(aoClos, produitId, "WON"),
      // DEUX LOTS du MÊME autre AO : le dédoublonnage doit les compter pour UN.
      ligne(aoVivant, autreProduitId, "QUOTED"),
      ligne(aoVivant, autreProduitId, "QUOTED"),
    ]);

    const contrat = await prisma.legalDocument.create({
      data: { title: `${TAG}Marché PCH 2026`, reference: `${TAG}PCH-2026-14`, kind: "CONTRACT", createdById: sa.id },
    });
    contratId = contrat.id;
    await prisma.pchContractLine.create({
      data: {
        documentId: contrat.id, contractId: contrat.id, productId: produitId,
        designation: `${TAG}lot`, quantityUnits: 100,
      },
    });
  });

  afterAll(async () => {
    await prisma.pchContractLine.deleteMany({ where: { designation: { startsWith: TAG } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTenderLine.deleteMany({ where: { designation: { startsWith: TAG } } }).catch(() => {});
    await prisma.pchTender.deleteMany({ where: { reference: { startsWith: TAG } } }).catch(() => {});
    await prisma.product.deleteMany({ where: { code: { startsWith: TAG } } }).catch(() => {});
    await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {});
  });

  it("l'AO COURANT est exclu — on ne se signale pas à soi-même", async () => {
    // Le cas qui ferait tomber cette assertion : oublier `tenderId: { not: tenderId }`. Chaque
    // lot afficherait « déjà engagé sur cet AO », une réserve vraie et parfaitement inutile,
    // c'est-à-dire du bruit sur toutes les lignes de tous les marchés (§118.32).
    const t = await loadEngagementsAilleurs(sa, aoCourant, [produitId]);
    expect(t.get(produitId)?.autresAo.map((a) => a.aoId)).toEqual([aoVivant]);
  });

  it("un AO CLOS n'engage plus rien — l'histoire n'est pas une alerte", async () => {
    const t = await loadEngagementsAilleurs(sa, aoCourant, [produitId]);
    expect(t.get(produitId)?.autresAo.some((a) => a.aoId === aoClos)).toBe(false);
  });

  it("DEUX LOTS du même AO comptent pour UN engagement", async () => {
    const t = await loadEngagementsAilleurs(sa, aoCourant, [autreProduitId]);
    expect(t.get(autreProduitId)?.autresAo.length).toBe(1);
  });

  it("le MARCHÉ PCH est lu, et la phrase NOMME les deux pièces", async () => {
    const t = await loadEngagementsAilleurs(sa, aoCourant, [produitId]);
    const e = t.get(produitId)!;
    expect(e.marchesLus).toBe(true);
    expect(e.marches.map((m) => m.contratId)).toEqual([contratId]);
    const phrase = reserveEngagement(e)!;
    expect(phrase).toContain(`${TAG}AO-VIVANT`);
    expect(phrase).toContain(`${TAG}PCH-2026-14`);
    expect(phrase).toContain("un seul AO");
  });

  it("SANS LE MODULE LEGAL, le marché n'est pas CHARGÉ — et la phrase le DIT", async () => {
    // C'est la garde de §118.109 : quelqu'un qui a PCH sans Legal ne doit pas apprendre ici le
    // titre d'un contrat. Et une liste vide ne doit pas se lire « aucun marché » alors qu'elle
    // dit « je n'ai pas regardé » (§118.57b) — d'où le témoin.
    // LA PRÉMISSE SE VÉRIFIE, elle ne se suppose pas : si `LOGISTICS_MANAGER` gagnait Legal un
    // jour, ce cas passerait au vert sans plus rien garder — c'est le défaut de §118.104, où la
    // garde protégeait par la grâce du filtre de son appelant et non par elle-même.
    expect(userCan(pchSeul, "LEGAL", "VIEW")).toBe(false);
    const t = await loadEngagementsAilleurs(pchSeul, aoCourant, [produitId]);
    const e = t.get(produitId)!;
    expect(e.marches).toEqual([]);
    expect(e.marchesLus).toBe(false);
    expect(reserveEngagement(e)).toContain("module Legal absent");
    // L'AUTRE MOITIÉ RESTE VISIBLE : les AO sont du module PCH, qu'il a.
    expect(e.autresAo.length).toBe(1);
  });

  it("un produit SANS engagement ailleurs n'a pas d'entrée, et la phrase se TAIT", async () => {
    const t = await loadEngagementsAilleurs(sa, aoVivant, [autreProduitId]);
    expect(t.get(autreProduitId)).toBeUndefined();
    expect(reserveEngagement(undefined)).toBeNull();
  });

  it("aucun produit à rapprocher : aucune requête, table vide", async () => {
    expect((await loadEngagementsAilleurs(sa, aoCourant, [])).size).toBe(0);
    // Une ligne d'AO sans produit canonique n'entre pas : sans identité, rapprocher par
    // ressemblance de libellé confondrait un 40 mg et un 100 mg.
    expect((await loadEngagementsAilleurs(sa, aoCourant, [""])).size).toBe(0);
  });
});
