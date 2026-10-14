import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentUser } from "@/lib/session";

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let ACTOR: CurrentUser | null = null;
vi.mock("@/lib/session", () => ({ requireUser: async () => ACTOR , requireUserAuNomDeLaVue: async () => ACTOR}));

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import { importTransactions } from "./finance-actions";

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = "__importReleve__";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'IMPORT D'UN RELEVÉ NE COMPTE QUE CE QU'IL A ÉCRIT, ET NOMME CHAQUE LIGNE ÉCARTÉE.
 *
 * LE DÉFAUT MESURÉ : `create(...).catch(() => undefined); n += 1`. Une ligne que la base refusait
 * était comptée, l'audit disait « N transactions importées », l'action rendait `{ ok: true }` sans
 * message et l'écran « Import réussi. ». Les lignes sautées avant l'écriture (colonnes, montant)
 * disparaissaient sans un mot. Ce banc passe par la VRAIE action, avec un compte des Finances sans
 * vue globale, et lit la base : un message juste sur une base fausse ne prouverait rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
suite("Import CSV des mouvements de trésorerie — compter ce qui est écrit, nommer ce qui est écarté", () => {
  let acteurId = "";

  const ecritures = () =>
    prisma.financeTransaction.findMany({ where: { createdById: acteurId }, select: { label: true, amount: true, date: true, method: true, category: true } });
  const audits = () =>
    prisma.auditLog.findMany({ where: { actorId: acteurId, action: "IMPORT" }, select: { summary: true } });
  const importer = (csv: string) => {
    const fd = new FormData();
    fd.set("csv", csv);
    return importTransactions(undefined, fd);
  };
  const purger = async () => {
    await prisma.financeTransaction.deleteMany({ where: { createdById: acteurId } });
    await prisma.auditLog.deleteMany({ where: { actorId: acteurId } });
  };

  beforeAll(async () => {
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
    const u = await prisma.user.create({
      data: { name: `${TAG} finances`, email: `${TAG}f@t.dz`, role: "FINANCE_BUDGET_MANAGER", passwordHash: "x" },
      select: { id: true, name: true, email: true },
    });
    acteurId = u.id;
    const access = await getAccess(u.id, "FINANCE_BUDGET_MANAGER");
    ACTOR = { id: u.id, name: u.name, email: u.email, role: "FINANCE_BUDGET_MANAGER", access, mustChangePassword: false };
    // Prémisse : le compte importe parce qu'il a le DROIT, pas parce qu'il voit tout (§118.104).
    expect(access.modules.get("FINANCES")).toBeTruthy();
  }, 60_000);

  afterAll(async () => {
    if (acteurId) await purger().catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }, 60_000);

  it("une ligne valide et deux écartées : UN mouvement écrit, et les deux lignes nommées avec leur raison", async () => {
    await purger();
    const r = await importer([
      "date,direction,category,label,amount,method,account,counterparty",
      `2026-09-28,OUT,LOYER,${TAG} loyer septembre,90000,BANK_TRANSFER,Banque,Propriétaire`,
      `31/02/2026,OUT,LOYER,${TAG} date qui n'existe pas,1000,BANK_TRANSFER,Banque,X`,
      `2026-09-29,OUT,DIVERS,${TAG} catégorie inconnue,1000,BANK_TRANSFER,Banque,X`,
    ].join("\n"));

    expect(r.ok, r.error).toBe(true);
    expect(r.ecartees).toBe(2);
    expect(r.message).toMatch(/^1 mouvement importé ; 2 lignes écartées : /);
    // 31/02 ne se « reporte » pas au 3 mars : une date qui n'existe pas est illisible.
    expect(r.message).toContain("ligne 3 — date illisible « 31/02/2026 » (attendu AAAA-MM-JJ ou JJ/MM/AAAA)");
    // Une catégorie hors de l'énumération est écartée — jamais rangée d'office dans AUTRE.
    expect(r.message).toContain("ligne 4 — catégorie inconnue « DIVERS »");
    expect(r.message).toContain("Catégories reconnues : ");
    // Le texte collé contient encore la ligne passée : le remède dit de ne pas la réimporter.
    expect(r.message).toContain("ne réimportez que les lignes corrigées");

    const lignes = await ecritures();
    expect(lignes.map((l) => l.label)).toEqual([`${TAG} loyer septembre`]);
    expect(Number(lignes[0].amount)).toBe(90000);
    expect(lignes[0].date.toISOString().slice(0, 10)).toBe("2026-09-28");
  });

  it("l'audit ne compte que les écritures RÉUSSIES", async () => {
    // Ce qui le ferait tomber : un résumé bâti sur le nombre de lignes lues — « 3 transactions
    // importées » pour un seul mouvement en base.
    const a = await audits();
    expect(a.map((x) => x.summary)).toEqual(["Import CSV — 1 mouvement importé, 2 lignes écartées"]);
  });

  it("une ligne que la BASE refuse n'est pas comptée — rien d'écrit est un refus, pas un succès vide", async () => {
    await purger();
    // Un montant au-delà de Decimal(14, 2) passe la lecture et se fait refuser par la base : c'est
    // exactement la ligne que `.catch(() => undefined); n += 1` comptait comme importée.
    const journal = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await importer([
      "date,direction,category,label,amount,method,account,counterparty",
      "",
      `2026-09-30,OUT,AUTRE,${TAG} hors borne,99999999999999,BANK_TRANSFER,Banque,X`,
      `2026-09-30,OUT,AUTRE,${TAG} sans montant,,BANK_TRANSFER,Banque,X`,
      "2026-09-30,OUT",
    ].join("\n"));
    // Le refus de la base laisse sa trace côté serveur — la phrase rendue reste courte.
    expect(journal.mock.calls.some((c) => String(c[0]).includes("ligne 3 refusée par la base"))).toBe(true);
    journal.mockRestore();

    expect(r.ok).toBe(false);
    // La ligne vide compte : les numéros sont ceux du texte collé, ceux que la personne cherche.
    expect(r.error).toBe(
      "Aucun mouvement importé ; 3 lignes écartées : ligne 3 — écriture refusée par la base ; ligne 4 — montant absent ; ligne 5 — colonnes manquantes (2 lues, 5 au moins).",
    );
    expect(await ecritures()).toEqual([]);
    // Rien n'a changé : rien à auditer.
    expect(await audits()).toEqual([]);
  });

  it("un relevé de tableur français : séparateur « ; », décimale à virgule, date JJ/MM/AAAA", async () => {
    await purger();
    const r = await importer([
      "date;direction;category;label;amount;method;account;counterparty",
      `06/01/2026;OUT;BANQUE;${TAG} frais de tenue;1250,50;CARD;Banque;SGA`,
    ].join("\n"));

    expect(r.ok, r.error).toBe(true);
    expect(r.ecartees).toBe(0);
    expect(r.message).toBe("1 mouvement importé.");
    const [l] = await ecritures();
    // Couper aussi sur la virgule aurait écrit 1 250 DZD et un mode de paiement « 50 ».
    expect(Number(l.amount)).toBe(1250.5);
    expect(l.method).toBe("CARD");
    expect(l.category).toBe("BANQUE");
    // « 06/01 » est le 6 JANVIER : `new Date("06/01/2026")` le lisait comme le 1er juin.
    expect(l.date.toISOString().slice(0, 10)).toBe("2026-01-06");
  });

  it("le bilan reste lisible : huit lignes nommées au plus, le reste COMPTÉ", async () => {
    await purger();
    const mauvaises = Array.from({ length: 10 }, (_, i) => `x${i + 1},OUT,AUTRE,${TAG} ${i + 1},1000,CASH,Caisse,X`);
    const r = await importer(["date,direction,category,label,amount,method,account,counterparty", ...mauvaises].join("\n"));

    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/^Aucun mouvement importé ; 10 lignes écartées : ligne 2 — date illisible « x1 »/);
    expect(r.error).toContain("ligne 9 — date illisible « x8 »");
    expect(r.error).not.toContain("ligne 10 —");
    expect(r.error).toContain(" ; et 2 autres.");
    expect(await ecritures()).toEqual([]);
  });

  it("un en-tête seul n'est pas un import réussi", async () => {
    const r = await importer("date,direction,category,label,amount,method,account,counterparty");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Aucune ligne à importer/);
  });
});

describe("l'écran d'import affiche le bilan RENDU par l'action", () => {
  // Composant client : aucun banc ne le rend. On tient donc son POINT D'APPEL (§118.49) — le
  // message de l'action est affiché, plus la phrase fixe, et un panneau qui écarte des lignes
  // reste ouvert pour qu'on les lise.
  const src = readFileSync(join(process.cwd(), "src/app/(app)/finances/import-transactions.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/[^\n]*$/gm, "");

  it("le message de l'action est rendu, et la phrase fixe « Import réussi. » a disparu", () => {
    expect(src).toMatch(/\{bilan\.message \?\? "Import terminé\."\}/);
    expect(src).not.toContain("Import réussi.");
  });

  it("le panneau ne se referme seul que si RIEN n'a été écarté — et un texte importé ne se réimporte pas d'un clic", () => {
    expect(src).toMatch(/if \(!state\.ecartees\) setTimeout\(/);
    expect(src).toMatch(/disabled=\{pending \|\| dejaImporte\}/);
  });
});

describe("la conversation relaie le MÊME bilan que l'écran", () => {
  // L'op d'Adam disait « Mouvements importés. » quoi que l'action ait écarté : sur un relevé
  // à moitié refusé, c'est un faux succès (§118.25). Adam est en pause ; la phrase fausse se
  // corrige quand même (§118.149i), et son point d'appel se garde (§118.49).
  const src = readFileSync(join(process.cwd(), "src/lib/assistant/ops/impl-wave8-files.ts"), "utf8");
  it("l'op d'import rend le message de l'action, et ne le remplace que s'il manque", () => {
    const bloc = src.slice(src.indexOf("importTransactions(undefined, fd)"));
    expect(bloc.slice(0, 600)).toMatch(/return \{ ok: true, message: r\.message \?\? "Mouvements importés\." \}/);
  });
});
