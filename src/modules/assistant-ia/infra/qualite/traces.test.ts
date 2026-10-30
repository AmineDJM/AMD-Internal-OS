import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { remplacerLecteurInterrupteurIaPourTests } from "@/lib/ai-settings";
import { jouerTour } from "../fil/tour";
import { remplacerModelesPourTests } from "../generer";
import { modeleFactice } from "../testing/modele-factice";
import { effacerJournalDe } from "../testing/journal";
import { decoderTrace, lireTrace, purgerTraces, sauvegarderTrace } from "./traces";
import { rejouerTrace } from "./rejeu";

/**
 * LES TRACES REJOUABLES (J14, décision 0022) — un tour joué (faux modèle : un outil, puis une réponse) laisse sa trace ;
 * rejouée SANS AUCUN MODÈLE configuré, elle rend le même texte, les mêmes outils, les mêmes prompts (empreintes) ; une
 * sortie d'outil altérée dans la trace se voit comme une DIVERGENCE (c'est ainsi qu'on trouve un bug).
 */
let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

const TAG = `__traces_${Date.now().toString(36)}_`;
let moi: CurrentUser;

suite("Les traces rejouables de l'Assistant IA", () => {
  beforeAll(async () => {
    const u = await prisma.user.create({ data: { name: `${TAG}moi`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "DIRECTION_ASSISTANT" } });
    await prisma.userAccess.create({ data: { userId: u.id, module: "ASSISTANT_IA", canView: true, scope: "ASSIGNED" } });
    await prisma.user.create({ data: { name: `${TAG}Ophélie Testeuse`, email: `${TAG}o@t.dz`, passwordHash: "x", role: "VIEWER" } });
    const access = await getAccess(u.id, u.role);
    moi = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    remplacerLecteurInterrupteurIaPourTests(async () => false);
  });
  afterAll(async () => {
    remplacerModelesPourTests(null);
    await effacerJournalDe([moi?.id]);
    await prisma.assistantIaTrace.deleteMany({ where: { userId: moi?.id } });
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } });
  });

  it("un tour joué se rejoue à l'identique, sans modèle, et une sortie altérée se voit", async () => {
    const faux = modeleFactice([
      { appel: { outil: "directory_lookup", entree: { name: `${TAG}Ophélie` } } },
      { texte: '{"message":"Ophélie Testeuse est dans l\'annuaire.","components":[]}' },
    ]);
    remplacerModelesPourTests([faux.modele as never]);
    const tourId = `${TAG}reponse`;
    const r = await jouerTour(moi, { texte: "Qui est Ophélie ?", pieces: [], historique: [], trace: { tourId, messageId: `${TAG}message` }, surTexte: () => {} });
    expect(r.ok).toBe(true);

    const trace = await lireTrace(`${TAG}message`);
    expect(trace?.tourId).toBe(tourId);
    expect(trace!.appels.filter((a) => a.nature === "tour")).toHaveLength(2);
    expect(trace!.sorties.map((s) => s.nom)).toEqual(["directory_lookup"]);
    expect(trace!.entree?.instructions.length).toBeGreaterThan(500);

    // Plus AUCUN modèle : le rejeu ne doit appeler personne.
    remplacerModelesPourTests(null);
    const appelsAvant = faux.toursJoues();
    const b = await rejouerTrace(trace!);
    expect(b.divergences).toEqual([]);
    expect(b.identique).toBe(true);
    expect(b.texte).toBe(trace!.resultat!.texte);
    expect(b.appelsRejoues).toBe(2);
    expect(faux.toursJoues()).toBe(appelsAvant);

    // Un bug simulé : la sortie de l'annuaire n'est plus la même → le prompt suivant diverge.
    const alteree = decoderTrace(gzipSync(JSON.stringify(trace)));
    alteree.sorties[0]!.sortie = `${alteree.sorties[0]!.sortie} (altérée)`;
    const b2 = await rejouerTrace(alteree);
    expect(b2.identique).toBe(false);
    expect(b2.divergences.join(" ")).toMatch(/appel tour n° 2 : le prompt reçu diffère/);
  });

  it("la durée de garde : une trace trop vieille est purgée", async () => {
    await sauvegarderTrace({ version: 1, tourId: `${TAG}vieille`, messageId: null, userId: moi.id, quand: "", entree: null, appels: [{ nature: "tour", modelId: "x", empreinte: "e", outils: [], mode: "flux", parties: [], ms: 0 }], sorties: [], resultat: null, erreur: null });
    await prisma.assistantIaTrace.update({ where: { tourId: `${TAG}vieille` }, data: { createdAt: new Date(Date.now() - 400 * 86_400_000) } });
    expect(await purgerTraces()).toBeGreaterThanOrEqual(1);
    expect(await prisma.assistantIaTrace.count({ where: { tourId: `${TAG}vieille` } })).toBe(0);
  });
});
