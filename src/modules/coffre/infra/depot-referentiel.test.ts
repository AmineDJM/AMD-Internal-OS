import { afterAll, describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { clesDepuisMaitresse } from "./cle";
import { chiffrer } from "./chiffrement";
import { creerServiceCoffre } from "./service";
import { cleVersionDe, creerDepotReferentiel, depuisColonnes, enColonnes, idCleDe } from "./depot-referentiel";

/** Le coffre sur les VRAIES tables du référentiel R6 : écrire, retrouver par empreinte, lire avec journal. */

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }

const cles = clesDepuisMaitresse(crypto.createHash("sha256").update("cle-du-banc-depot-referentiel").digest(), true);

describe("les colonnes du chiffré", () => {
  it("se découpent et se recomposent à l'identique, identifiant de clé compris", () => {
    const c = chiffrer(cles, "IBAN", "d1", "DZ5800020000000000000000");
    expect(depuisColonnes(enColonnes(c))).toBe(c);
    for (const id of ["00000000", "7fffffff", "80000000", "ffffffff"]) expect(idCleDe(cleVersionDe(id))).toBe(id);
    expect(() => enColonnes("pas-un-chiffre")).toThrow();
  });
});

describe.skipIf(!dbOk)("le dépôt du coffre sur DonneeSensible / AccesDonneeSensible", () => {
  const titulaireId = `__coffre_ref__${Date.now()}`;
  afterAll(async () => {
    await prisma.accesDonneeSensible.deleteMany({ where: { titulaireId } });
    await prisma.donneeSensible.deleteMany({ where: { titulaireId } });
  });

  it("dépose une fois, retrouve par empreinte, lit en journalisant — refus d'un modèle compris", async () => {
    const coffre = creerServiceCoffre({ depot: creerDepotReferentiel(prisma), cles: () => cles });
    const titulaire = { genre: "PERSONNE" as const, personneId: titulaireId };
    const d1 = await coffre.deposer({ titulaire, nature: "PASSEPORT_NUMERO", valeur: "198 765 432", deposeParId: null });
    const d2 = await coffre.deposer({ titulaire, nature: "PASSEPORT_NUMERO", valeur: "198765432", deposeParId: null });
    expect(d1.ok && d2.ok && d2.dejaPresente && d1.id === d2.id).toBe(true);
    const ligne = await prisma.donneeSensible.findFirstOrThrow({ where: { titulaireId } });
    expect(ligne.derniersCaracteres).toBe("5432");
    expect(Buffer.concat([ligne.valeurChiffree, ligne.iv, ligne.tag]).toString("utf8")).not.toContain("198765432");

    const lu = await coffre.lire({ lecteur: { genre: "UTILISATEUR", userId: "u-sa", superAdmin: true, tientRH: false, tientFinances: false }, id: ligne.id, geste: "contrôle" });
    expect(lu).toMatchObject({ ok: true, valeur: "198765432" });
    const refus = await coffre.lire({ lecteur: { genre: "IA", nom: "modele" }, id: ligne.id, geste: "résumé" });
    expect(refus.ok).toBe(false);
    // Comparées sans ordre : deux lignes du journal écrites coup sur coup peuvent porter le même `createdAt`.
    const journal = await prisma.accesDonneeSensible.findMany({ where: { titulaireId } });
    expect(journal.map((j) => [j.userId, j.motif?.split(":")[0]]).sort()).toEqual([["ia:modele", "REFUSE"], ["u-sa", "ACCORDE"]]);
  });
});
