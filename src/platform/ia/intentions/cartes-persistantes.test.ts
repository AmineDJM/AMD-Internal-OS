import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { comptesDeBanc } from "@/lib/actions/internes/bancs-concurrents";
import { cartesDuFil, persistActionIntents, rattacherCartes, retirerCaduquesAvantLeTour, sectionCartesEnAttente } from "@/platform/ia/intentions/action-intents";
import { motifDeLaCarte } from "@/platform/ia/intentions/etat-carte";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * C1 (décision 0068) — UNE CARTE NE MEURT PLUS EN SILENCE. Base réelle.
 *
 * Reproduit en vrai navigateur le 04/11 (vrai modèle, base locale) : une tâche proposée, puis « Ok pour la tâche de relance
 * du fournisseur des étiquettes Nivolex, je la valide tout à l'heure » — la carte passait CANCELLED_SUPERSEDED AVANT le
 * modèle (le message reprenait son sujet), Adam répondait « la carte reste en attente », et au retour l'écran disait
 * « Action ignorée », sans bouton. Ce banc tient les deux moitiés : un message qui ne CORRIGE pas la carte ne retire rien,
 * d'où qu'il vienne ; une vraie correction la retire, dans SA conversation seulement, et la raison est dite.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const comptes = comptesDeBanc("__c1cartes_");
const TAG = `c1-${Date.now().toString(36)}`;
let userId = "";
let filA = "";
let filB = "";

const graine = (titre: string, kind = "create_task") => ({
  kind, module: "Tasks", title: "Créer tâche",
  fields: [{ label: "Titre", value: titre }, { label: "Échéance", value: "vendredi" }], payload: { titre },
});

/** Une carte proposée dans la conversation `fil`, rattachée comme le fait le fil en fin de tour. */
async function carteDans(fil: string, titre: string, kind?: string): Promise<string> {
  const [id] = await persistActionIntents(userId, [graine(titre, kind)], "text");
  await rattacherCartes(userId, fil, `tour-${TAG}`, [{ id: id! }]);
  return id!;
}
const statut = async (id: string) => (await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id } })).status;

describe("C1 — le retrait d'une carte : seulement sur un signal explicite, et toujours dit", () => {
  beforeAll(async () => {
    userId = (await comptes.creer("pdg")).id;
    filA = (await prisma.assistantIaFil.create({ data: { userId, titre: `${TAG} A` } })).id;
    filB = (await prisma.assistantIaFil.create({ data: { userId, titre: `${TAG} B` } })).id;
  });
  afterAll(async () => {
    await prisma.assistantActionIntent.deleteMany({ where: { userId } }).catch(() => undefined);
    await prisma.assistantIaFil.deleteMany({ where: { userId } }).catch(() => undefined);
    await comptes.retirer();
  });

  it("un message SANS RAPPORT, ou un ACCORD qui reprend le sujet de la carte, ne retire rien", async () => {
    const id = await carteDans(filA, `Relancer le fournisseur des étiquettes Nivolex ${TAG}`);
    expect(await retirerCaduquesAvantLeTour(userId, "Au fait, combien de jours y a-t-il en février 2028 ?", [], filA)).toEqual([]);
    // LE MESSAGE DU BANC NAVIGATEUR — il tuait la carte avant C1.
    expect(await retirerCaduquesAvantLeTour(userId, "Ok pour la tâche de relance du fournisseur des étiquettes Nivolex, je la valide tout à l'heure.", [], filA)).toEqual([]);
    expect(await statut(id)).toBe("PROPOSED");
    // Et Adam la voit, au tour suivant, comme une carte qui attend (pour ne pas la reproposer en double).
    expect(await sectionCartesEnAttente(userId, filA)).toMatch(/CARTES EN ATTENTE[\s\S]*Relancer le fournisseur des étiquettes Nivolex/);
  });

  it("une CORRECTION retire la carte de SA conversation seulement — et l'écran dit pourquoi", async () => {
    const ici = await carteDans(filA, `Vérifier l'étiquetage bilingue Nivolex ${TAG}`);
    // (Une autre NATURE dans l'autre conversation : de même nature et même objet, elle remplacerait la première — dit.)
    const ailleurs = await carteDans(filB, `Vérifier l'étiquetage bilingue Nivolex ${TAG}`, "send_message");
    const correction = "Non, finalement l'étiquetage bilingue Nivolex c'est pour Amel, et lundi.";
    expect(await retirerCaduquesAvantLeTour(userId, correction, [], filA)).toEqual([ici]);
    expect([await statut(ici), await statut(ailleurs)]).toEqual(["CANCELLED", "PROPOSED"]);

    // L'écran relit la carte à sa source, avec la raison — pas un « Action ignorée » muet.
    const { cartes } = await cartesDuFil(userId, filA);
    const lue = cartes.find((c) => c.id === ici)!;
    expect(motifDeLaCarte(lue.status, lue.events)).toMatch(/^Carte retirée : vous l'avez corrigée \(« Non, finalement l'étiquetage/);
  });

  it("une carte REMPLACÉE par une nouvelle carte du même objet nomme sa remplaçante ; l'expiration se dit aussi", async () => {
    const ancienne = await carteDans(filA, `Préparer le dossier technique Daclavir ${TAG}`);
    const nouvelle = await carteDans(filA, `Préparer le dossier technique Daclavir ${TAG}`);
    expect([await statut(ancienne), await statut(nouvelle)]).toEqual(["CANCELLED", "PROPOSED"]);
    const { cartes } = await cartesDuFil(userId, filA);
    const a = cartes.find((c) => c.id === ancienne)!;
    expect(motifDeLaCarte(a.status, a.events)).toMatch(/^Carte retirée : remplacée par « Créer tâche — Préparer le dossier technique Daclavir/);

    // Une carte vieille de 25 h : lue EXPIRÉE (écrite en base), et dite comme telle — elle ne disparaît pas.
    const vieille = await carteDans(filA, `Appeler Biopharm pour le devis de stabilité ${TAG}`);
    await prisma.assistantActionIntent.update({ where: { id: vieille }, data: { proposedAt: new Date(Date.now() - 25 * 3_600_000) } });
    const relu = (await cartesDuFil(userId, filA)).cartes.find((c) => c.id === vieille)!;
    expect(relu.status).toBe("EXPIRED");
    expect(await statut(vieille)).toBe("EXPIRED");
    expect(motifDeLaCarte(relu.status, relu.events, { expirationH: 24 })).toMatch(/^Carte expirée : non confirmée dans les 24 h/);
  });
});
