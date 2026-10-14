import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { legalReaderWhere } from "@/lib/lecteurs/legal";
import { updateLegalDocument } from "@/lib/actions/legal-actions";
import { AMONT_HORS_PERIMETRE, AMONT_PROPOSEES, piecesAmontProposees } from "@/lib/queries/legal-chain";
import { REFUS_CHAINE_FACTURE_PROMO } from "./chaine";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__chaineAmont__";

function fd(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

/**
 * LA CHAÎNE D'UNE FACTURE NE SE PERD PAS EN L'ENREGISTRANT (§118.168).
 *
 * Trouvé en écrivant le parcours navigateur de la réception : l'écran de modification de Legal ne
 * proposait, au menu « Fait suite à », que les CENT devis et bons de commande les plus récents.
 * Une facture chaînée à un BC plus ancien n'y retrouvait pas son BC, le navigateur affichait
 * « — Pièce isolée — », et un simple « Enregistrer » la DÉTACHAIT — sans un mot. Détachée, elle
 * sortait du cumul qui empêche de payer plus que la commande, de la règle « la facture d'un BC non
 * validé ne part pas » et de l'écran du dossier.
 *
 * Deux propriétés, et chacune a son cas qui la ferait tomber :
 *   • le menu porte TOUJOURS la pièce actuelle — y compris hors du périmètre de la personne, sous un
 *     libellé neutre (garder un lien n'accorde rien ; nommer son titre le révélerait) ;
 *   • une facture saisie LIGNE À LIGNE sur un dossier promotionnel ne change pas de BC à
 *     l'enregistrement : ses lignes découlent de celles de CE bon de commande. Une facture ordinaire,
 *     elle, se rechaîne librement — sans ce témoin, une garde trop large passerait pour armée.
 */
suite("La chaîne d'une facture survit à sa modification", () => {
  let adminId = "";
  let lecteurId = "";
  let ancienBcId = "";
  let autreBcId = "";
  let facturePromoId = "";
  let factureOrdinaireId = "";

  async function nettoyer() {
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: TAG } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  }

  beforeAll(async () => {
    await nettoyer();
    const admin = await prisma.user.create({ data: { name: `${TAG}admin`, email: `${TAG}admin@t.dz`, role: "SUPER_ADMIN", passwordHash: "x" } });
    const lecteur = await prisma.user.create({ data: { name: `${TAG}lecteur`, email: `${TAG}lecteur@t.dz`, role: "VIEWER", passwordHash: "x" } });
    const tiers = await prisma.user.create({ data: { name: `${TAG}tiers`, email: `${TAG}tiers@t.dz`, role: "VIEWER", passwordHash: "x" } });
    adminId = admin.id;
    lecteurId = lecteur.id;
    ACTOR = { id: admin.id, name: admin.name, email: admin.email, role: "SUPER_ADMIN", access: await getAccess(admin.id, "SUPER_ADMIN"), mustChangePassword: false } as CurrentUser;

    // LE BC ANCIEN — daté de 2000, donc derrière les cent pièces plus récentes que ce banc pose
    // lui-même ensuite : la prémisse ne dépend pas de ce que contient la base de travail.
    const ancien = await prisma.legalDocument.create({
      data: {
        title: `${TAG} BC ancien imprimerie`, reference: `${TAG}BC-OLD`, kind: "PURCHASE_ORDER", counterparty: "Imprimerie",
        createdAt: new Date("2000-01-01T00:00:00Z"), createdById: admin.id,
        // Restreint à un TIERS : le lecteur ne le voit pas — c'est le cas du libellé neutre.
        readers: { create: [{ userId: tiers.id }] },
      },
      select: { id: true },
    });
    ancienBcId = ancien.id;
    await prisma.legalDocument.createMany({
      data: Array.from({ length: AMONT_PROPOSEES }, (_, i) => ({
        title: `${TAG} devis récent ${i}`, reference: `${TAG}DV-${i}`, kind: "QUOTE" as const, counterparty: "Imprimerie", createdById: admin.id,
      })),
    });
    autreBcId = (await prisma.legalDocument.create({
      data: { title: `${TAG} BC d'un autre dossier`, reference: `${TAG}BC-AUTRE`, kind: "PURCHASE_ORDER", counterparty: "Imprimerie", createdById: admin.id },
      select: { id: true },
    })).id;

    // La facture SAISIE LIGNE À LIGNE sur un dossier promotionnel : elle porte un `PromoFacture`.
    facturePromoId = (await prisma.legalDocument.create({
      data: {
        title: `${TAG} facture promo`, reference: `${TAG}F-PROMO`, kind: "INVOICE", counterparty: "Imprimerie", amount: 2380,
        chainFromId: ancienBcId, createdById: admin.id,
        promoFacture: { create: { tvaRate: 19 } },
      },
      select: { id: true },
    })).id;
    // Une facture ORDINAIRE chaînée au même BC : elle se rechaîne librement.
    factureOrdinaireId = (await prisma.legalDocument.create({
      data: { title: `${TAG} facture ordinaire`, reference: `${TAG}F-ORD`, kind: "INVOICE", counterparty: "Imprimerie", amount: 500, chainFromId: ancienBcId, createdById: admin.id },
      select: { id: true },
    })).id;
  });

  afterAll(async () => {
    await nettoyer();
  });

  it("prémisse : le BC actuel est HORS des cent pièces les plus récentes que le menu propose", async () => {
    const sansActuelle = await piecesAmontProposees({ userId: adminId, readerScope: null, docId: facturePromoId });
    expect(sansActuelle).toHaveLength(AMONT_PROPOSEES);
    expect(sansActuelle.some((o) => o.value === ancienBcId), "le menu d'avant ne pouvait PAS le proposer").toBe(false);
  });

  it("à la modification, la pièce ACTUELLE est proposée en tête, sous son vrai libellé", async () => {
    const options = await piecesAmontProposees({ userId: adminId, readerScope: null, docId: facturePromoId, actuelId: ancienBcId });
    expect(options[0]?.value, "sans elle, « Enregistrer » détache la facture de son BC").toBe(ancienBcId);
    expect(options[0]?.label).toContain(`${TAG}BC-OLD`);
    expect(options).toHaveLength(AMONT_PROPOSEES + 1);
    expect(options.filter((o) => o.value === ancienBcId), "jamais deux fois").toHaveLength(1);
  });

  it("hors du périmètre de la personne, la pièce actuelle reste proposée — sans révéler son titre", async () => {
    const readerScope = legalReaderWhere({ viewerId: lecteurId, isSuperAdmin: false });
    const options = await piecesAmontProposees({ userId: lecteurId, readerScope, docId: facturePromoId, actuelId: ancienBcId });
    expect(options[0]).toEqual({ value: ancienBcId, label: AMONT_HORS_PERIMETRE });
    expect(options.some((o) => o.label.includes("BC ancien")), "le titre d'une pièce restreinte ne fuit pas").toBe(false);
  });

  it("une facture promotionnelle enregistrée telle quelle GARDE son BC", async () => {
    const r = await updateLegalDocument(fd({ id: facturePromoId, title: `${TAG} facture promo`, kind: "INVOICE", amount: "2380", chainFromId: ancienBcId }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facturePromoId } })).chainFromId).toBe(ancienBcId);
  });

  it("une facture promotionnelle ne se rattache pas à un AUTRE BC, ni ne se détache — et le refus nomme le geste", async () => {
    for (const chainFromId of [autreBcId, ""]) {
      const r = await updateLegalDocument(fd({ id: facturePromoId, title: `${TAG} facture promo`, kind: "INVOICE", amount: "2380", chainFromId }));
      expect(r.ok, `chaîne demandée : « ${chainFromId} »`).toBe(false);
      expect(r.error).toBe(REFUS_CHAINE_FACTURE_PROMO);
      expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: facturePromoId } })).chainFromId, "rien n'a bougé").toBe(ancienBcId);
    }
  });

  it("POINT D'APPEL : l'écran de modification passe la pièce ACTUELLE au chargeur (§118.49)", () => {
    // Vérifier le chargeur sans son appelant ne prouverait rien : le défaut était dans l'ÉCRAN.
    const source = readFileSync(path.join(process.cwd(), "src/app/(app)/legal/[id]/page.tsx"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Le chargeur reçoit aussi la porte de la liste (`perimetreLegal`, lot D1c) : son objet porte des accolades
    // imbriquées, donc on cherche l'argument dans l'appel, pas jusqu'à la première accolade fermante.
    expect(source).toMatch(/piecesAmontProposees\(\{[\s\S]{0,300}?actuelId:\s*doc\.chainFromId/);
    expect(source, "plus aucune requête de candidates écrite à la main dans l'écran").not.toMatch(/kind:\s*\{\s*in:\s*\[\s*"QUOTE",\s*"PURCHASE_ORDER"\s*\]/);
  });

  it("TÉMOIN : une facture ORDINAIRE, elle, se rechaîne librement", async () => {
    const r = await updateLegalDocument(fd({ id: factureOrdinaireId, title: `${TAG} facture ordinaire`, kind: "INVOICE", amount: "500", chainFromId: autreBcId }));
    expect(r.ok, r.error).toBe(true);
    expect((await prisma.legalDocument.findUniqueOrThrow({ where: { id: factureOrdinaireId } })).chainFromId).toBe(autreBcId);
  });
});
