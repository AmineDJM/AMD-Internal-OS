import { describe, expect, it } from "vitest";
import { clesAPurger, dateDeCle, POLITIQUE } from "../../../scripts/sauvegarde/retention.mjs";

/**
 * LA RÉTENTION DES SAUVEGARDES (`scripts/sauvegarde/retention.mjs`) — ce que la purge nocturne garde.
 * Un défaut ici détruit des copies de la base : chaque règle a son cas.
 */
const cle = (d: string) => `sauvegardes/base/amd-${d.replace(/[-:]/g, "").replace(/\.\d+/, "")}.dump.gpg`;
const jours = (depuis: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(new Date(depuis).getTime() - i * 86_400_000).toISOString().slice(0, 19) + "Z");

describe("rétention des sauvegardes", () => {
  it("lit la date UTC de la clé ; une clé illisible ne se lit pas", () => {
    expect(dateDeCle("x/amd-20261028T021700Z.dump.gpg")?.toISOString()).toBe("2026-10-28T02:17:00.000Z");
    expect(dateDeCle("x/autre-fichier.txt")).toBeNull();
  });

  it("garde les 14 quotidiennes, une par semaine sur 8, une par mois sur 12 — purge le reste", () => {
    const maintenant = new Date("2026-10-28T03:00:00Z");
    const cles = jours("2026-10-28T02:17:00Z", 400).map(cle);
    const purgees = new Set<string>(clesAPurger(cles, maintenant));
    const gardees = cles.filter((c) => !purgees.has(c));
    // 14 quotidiennes + au plus 8 hebdomadaires + au plus 12 mensuelles, avec recouvrements.
    expect(gardees.length).toBeGreaterThanOrEqual(POLITIQUE.quotidiennes);
    expect(gardees.length).toBeLessThanOrEqual(POLITIQUE.quotidiennes + POLITIQUE.hebdomadaires + POLITIQUE.mensuelles);
    for (const c of cles.slice(0, 14)) expect(purgees.has(c), `quotidienne ${c}`).toBe(false);
    // Rien de plus vieux que 12 mois et quelques jours n'est gardé.
    for (const c of gardees) expect(maintenant.getTime() - dateDeCle(c)!.getTime()).toBeLessThan(380 * 86_400_000);
  });

  it("la plus récente n'est JAMAIS purgée, même vieille de six mois (les sauvegardes échouent depuis)", () => {
    const seule = cle("2026-04-01T02:17:00Z");
    expect(clesAPurger([seule], new Date("2026-10-28T03:00:00Z"))).toEqual([]);
  });

  it("une clé illisible n'est jamais purgée — on ne détruit pas ce qu'on ne comprend pas", () => {
    const etrangere = "sauvegardes/base/manuel-avant-migration.dump.gpg";
    const cles = [...jours("2026-10-28T02:17:00Z", 60).map(cle), etrangere];
    expect(clesAPurger(cles, new Date("2026-10-28T03:00:00Z"))).not.toContain(etrangere);
  });

  it("deux copies le même jour : la plus récente compte pour le jour, l'autre part si aucune règle ne la garde", () => {
    const matin = cle("2026-10-28T02:17:00Z");
    const relance = cle("2026-10-28T09:00:00Z");
    const purgees = clesAPurger([matin, relance], new Date("2026-10-28T10:00:00Z"));
    expect(purgees).toEqual([matin]);
  });
});
