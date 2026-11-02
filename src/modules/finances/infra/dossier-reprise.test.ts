import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prisma } from "@/lib/prisma";

/**
 * LA REPRISE DES ORDRES DÉJÀ ÉMIS — prouvée sur des données, pas sur une lecture.
 *
 * La règle « un ordre, un dossier » ne vaudrait que pour l'avenir si l'on ne rouvrait pas le
 * dossier manquant des ordres DÉJÀ en base : les lignes d'aujourd'hui resteraient muettes, et
 * c'est précisément celles-là que l'on a sous les yeux. Cette reprise est une migration de
 * DONNÉES : elle ne tourne qu'une fois, au déploiement, et n'a aucune seconde chance.
 *
 * D'où ce test, qui rejoue LE TEXTE RÉEL du fichier `.sql` — pas une copie qui aurait divergé —
 * sur un jeu construit à la main.
 *
 * Ce qu'il vérifie, et pourquoi chacun compte :
 *   • un ordre né ailleurs reçoit son dossier, rattaché à SA source et à SON demandeur ;
 *   • l'état du dossier SUIT l'ordre : réglé → soldé, annulé → annulé. Un dossier « chez les
 *     Finances » sous un paiement fait il y a six mois ferait relancer pour rien ;
 *   • un ordre né d'une DEMANDE DE PAIEMENT n'en reçoit pas un second — il en a déjà un ;
 *   • un ordre SANS DEMANDEUR est laissé de côté : `requesterId` n'est pas nullable, et inventer
 *     un demandeur porterait à l'audit le nom de quelqu'un qui n'a rien demandé ;
 *   • LA NUMÉROTATION CONTINUE la série PAY de l'année — repartir à 001 heurterait la contrainte
 *     d'unicité, et l'un des ordres n'aurait toujours pas de dossier ;
 *   • rejouer la migration ne crée pas de doublon.
 */

const TAG = "REPRISE-DOSSIER-TEST";
const SQL = join(process.cwd(), "prisma", "migrations", "20261010090000_un_ordre_un_dossier", "migration.sql");

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

/** Rejoue le fichier de migration, instruction par instruction (commentaires retirés d'abord). */
async function rejouerLaMigration(): Promise<void> {
  const brut = readFileSync(SQL, "utf8");
  const sansCommentaires = brut
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("--"))
    .join("\n");
  for (const stmt of sansCommentaires.split(";")) {
    if (stmt.trim()) await prisma.$executeRawUnsafe(stmt);
  }
}

let demandeurId = "";
let ordrePromo = "";
let ordreRegle = "";
let ordreAnnule = "";
let ordreSansDemandeur = "";
let ordreDeDemandePaiement = "";
let demandeNativeId = "";
const annee = new Date().getFullYear();

suite("Reprise : le dossier manquant des ordres déjà émis", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({
      data: { name: `${TAG} demandeur`, email: `${TAG.toLowerCase()}@amd.dz`, role: "DIRECTION", passwordHash: "x" },
      select: { id: true },
    });
    demandeurId = u.id;

    const mk = async (label: string, extra: Record<string, unknown>) => {
      const o = await prisma.expenseOrder.create({
        data: {
          reference: `OD-${annee}-${TAG}-${Math.random().toString(36).slice(2, 8)}`,
          label, amount: 12000, category: "FOURNISSEUR", ...extra,
        },
        select: { id: true },
      });
      return o.id;
    };

    ordrePromo = await mk(`${TAG} matériel promotionnel`, {
      beneficiary: "Agence Zed", sourceType: "PROMO_MATERIAL", sourceId: "pm-1",
      requestedById: demandeurId, deadlineNature: "FIXED",
    });
    ordreRegle = await mk(`${TAG} sponsoring réglé`, {
      sourceType: "SPONSORING", sourceId: "sp-1", requestedById: demandeurId, status: "PAID",
    });
    ordreAnnule = await mk(`${TAG} congrès annulé`, {
      sourceType: "CONGRESS_NATIONAL", sourceId: "cn-1", requestedById: demandeurId, status: "CANCELLED",
    });
    // Sans bénéficiaire NI demandeur : le second est ce qui l'exclut de la reprise.
    ordreSansDemandeur = await mk(`${TAG} sans demandeur`, { sourceType: "PROMO_MATERIAL", sourceId: "pm-2" });

    // Une demande de paiement NATIVE, avec son ordre : elle a déjà son dossier.
    const native = await prisma.paymentRequest.create({
      data: {
        reference: `PAY-${annee}-${TAG}`, title: `${TAG} demande native`, amount: 5000,
        payee: "Fournisseur", requesterId: demandeurId, status: "SUBMITTED",
      },
      select: { id: true },
    });
    demandeNativeId = native.id;
    ordreDeDemandePaiement = await mk(`${TAG} depuis une demande`, {
      sourceType: "PAYMENT_REQUEST", sourceId: native.id, requestedById: demandeurId,
    });
    await prisma.paymentRequest.update({ where: { id: native.id }, data: { expenseOrderId: ordreDeDemandePaiement } });

    await rejouerLaMigration();
  });

  afterAll(async () => {
    await prisma.paymentRequestEvent.deleteMany({ where: { request: { title: { startsWith: TAG } } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { title: { startsWith: TAG } } }).catch(() => {});
    await prisma.paymentRequest.deleteMany({ where: { requesterId: demandeurId } }).catch(() => {});
    await prisma.expenseOrder.deleteMany({ where: { label: { startsWith: TAG } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: demandeurId } }).catch(() => {});
  });

  it("UN ORDRE NÉ AILLEURS REÇOIT SON DOSSIER, rattaché à sa source et à son demandeur", async () => {
    const d = await prisma.paymentRequest.findFirst({ where: { expenseOrderId: ordrePromo } });
    expect(d).not.toBeNull();
    expect(d!.origin).toBe("EXPENSE_ORDER");
    expect(d!.id).toBe(`pcomp_${ordrePromo}`);
    expect(d!.title).toBe(`${TAG} matériel promotionnel`);
    expect(d!.payee).toBe("Agence Zed");
    expect(d!.requesterId).toBe(demandeurId);
    expect(d!.entityType).toBe("PROMO_MATERIAL");
    expect(d!.entityId).toBe("pm-1");
    // La nature de l'échéance voyage : c'est elle qui classe la file.
    expect(d!.deadlineNature).toBe("FIXED");
    // Le moyen de paiement n'a jamais été déclaré sur ces circuits : l'affirmer serait un faux.
    expect(d!.paymentMethodStated).toBe(false);
  });

  it("L'ÉTAT DU DOSSIER SUIT L'ORDRE — réglé → soldé, annulé → annulé, sinon chez les Finances", async () => {
    const [promo, regle, annule] = await Promise.all([
      prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordrePromo } }),
      prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordreRegle } }),
      prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordreAnnule } }),
    ]);
    expect(promo.status).toBe("SUBMITTED");
    expect(regle.status).toBe("APPROVED");
    expect(annule.status).toBe("CANCELLED");
  });

  it("À DÉFAUT DE BÉNÉFICIAIRE, LE LIBELLÉ — un tiret serait un faux", async () => {
    const d = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordreRegle } });
    expect(d.payee).toBe(`${TAG} sponsoring réglé`);
  });

  it("UNE DEMANDE DE PAIEMENT N'EN REÇOIT PAS UN SECOND — elle EST déjà son dossier", async () => {
    const tous = await prisma.paymentRequest.findMany({ where: { expenseOrderId: ordreDeDemandePaiement } });
    expect(tous).toHaveLength(1);
    expect(tous[0].id).toBe(demandeNativeId);
    expect(tous[0].origin).toBe("REQUEST");
  });

  it("UN ORDRE SANS DEMANDEUR EST LAISSÉ DE CÔTÉ — une lacune honnête vaut mieux qu'un nom faux", async () => {
    expect(await prisma.paymentRequest.count({ where: { expenseOrderId: ordreSansDemandeur } })).toBe(0);
  });

  it("LA NUMÉROTATION CONTINUE LA SÉRIE — repartir à 001 heurterait l'unicité", async () => {
    const refs = (await prisma.paymentRequest.findMany({
      where: { expenseOrderId: { in: [ordrePromo, ordreRegle, ordreAnnule] } },
      select: { reference: true },
    })).map((r) => r.reference);
    expect(refs).toHaveLength(3);
    expect(new Set(refs).size).toBe(3);
    for (const r of refs) expect(r).toMatch(new RegExp(`^PAY-${annee}-\\d{3,}$`));
  });

  it("LA RÉFÉRENCE GARDE TOUS SES CHIFFRES — `lpad` TRONQUE au-delà de sa cible", async () => {
    /*
     * `lpad('1013', 3, '0')` rend « 101 » : Postgres tronque une chaîne plus longue que la
     * longueur demandée. Au-delà de 999 dossiers dans l'année, la reprise retombait donc sur une
     * référence EXISTANTE et échouait sur l'unicité — trouvé quand la base locale a franchi
     * 1 000 dossiers (§118.147). Le cas ci-dessus ne l'attrapait qu'à CETTE condition, c'est-à-
     * dire au hasard de l'état de la base. Celui-ci évalue l'expression RÉELLE du fichier (sans
     * ses commentaires) sur des numéros choisis : il tombe sur le défaut quel que soit l'état.
     */
    const brut = readFileSync(SQL, "utf8").split("\n").filter((l) => !l.trimStart().startsWith("--")).join("\n");
    const m = brut.match(/'PAY-' \|\| n\.an \|\| '-' \|\| ([^\n]+),\n/);
    expect(m, "l'expression de numérotation doit se trouver dans la migration").not.toBeNull();
    const rows = await prisma.$queryRawUnsafe<{ ref: string }[]>(
      `SELECT 'PAY-' || n.an || '-' || ${m![1]} AS ref FROM (VALUES (2026, 7), (2026, 999), (2026, 1013)) AS n(an, n) ORDER BY n.n`,
    );
    expect(rows.map((r) => r.ref)).toEqual(["PAY-2026-007", "PAY-2026-999", "PAY-2026-1013"]);
  });

  it("LE FIL NE S'OUVRE PAS VIDE — l'historique blanc laisse croire qu'il ne s'est rien passé", async () => {
    const d = await prisma.paymentRequest.findFirstOrThrow({ where: { expenseOrderId: ordrePromo } });
    const ev = await prisma.paymentRequestEvent.findMany({ where: { requestId: d.id } });
    expect(ev).toHaveLength(1);
    expect(ev[0].message).toMatch(/automatiquement/i);
    expect(ev[0].actorId).toBeNull();
  });

  it("REJOUER LA MIGRATION NE CRÉE PAS DE DOUBLON", async () => {
    const avant = await prisma.paymentRequest.count({ where: { requesterId: demandeurId } });
    await rejouerLaMigration();
    expect(await prisma.paymentRequest.count({ where: { requesterId: demandeurId } })).toBe(avant);
    const ev = await prisma.paymentRequestEvent.count({
      where: { request: { expenseOrderId: ordrePromo } },
    });
    expect(ev).toBe(1);
  });
});
