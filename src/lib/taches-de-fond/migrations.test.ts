import { describe, expect, it } from "vitest";
import { migrationsAttendues, migrationsManquantes } from "./migrations";

/** Le worker attend la base : la lecture des migrations, contre la vraie table `_prisma_migrations`. */
describe("migrations attendues par le code du worker", () => {
  it("lit le dossier livré, dans l'ordre, et y trouve celle de ce lot", () => {
    const attendues = migrationsAttendues();
    expect(attendues).toContain("20270201100000_taches_de_fond");
    expect([...attendues].sort()).toEqual(attendues);
  });

  it("une base migrée n'a rien de manquant ; une migration inconnue de la base est signalée", async () => {
    const attendues = migrationsAttendues();
    expect(await migrationsManquantes(attendues)).toEqual([]);
    expect(await migrationsManquantes([...attendues, "20990101000000_pas_encore_appliquee"])).toEqual(["20990101000000_pas_encore_appliquee"]);
  });
});
