import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { retirerComptesEtSemis } from "@/lib/actions/internes/menage-de-banc";
import { projeterCarte, projeterFichier } from "../../domaine/observation/projecteurs";
import { historiqueObserve } from "./historique";

/**
 * I1 (décision 0063, étape 1) — l'historique RE-PROJETÉ depuis la base : la carte proposée au tour 1 est relue au tour 2
 * avec son statut ACTUEL ; un objet hors de portée ou disparu le dit ; jamais de HTML.
 */
const TAG = `i1hist${Date.now()}`;
let moi: CurrentUser;
let autre: CurrentUser;

beforeAll(async () => {
  const u = await prisma.user.create({ data: { name: `Moi ${TAG}`, email: `${TAG}moi@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const v = await prisma.user.create({ data: { name: `Autre ${TAG}`, email: `${TAG}autre@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  moi = { id: u.id, name: u.name, email: u.email, role: "SUPER_ADMIN" } as CurrentUser;
  autre = { id: v.id, name: v.name, email: v.email, role: "SUPER_ADMIN" } as CurrentUser;
});
afterAll(async () => { await retirerComptesEtSemis({ where: { email: { startsWith: TAG } } }).catch(() => {}); });

describe("I1 — l'historique observé", () => {
  it("relit le statut ACTUEL de la carte, porte le mail tel qu'il partira, et cède le texte quand le bloc déborde", async () => {
    const i = await prisma.assistantActionIntent.create({ data: { userId: moi.id, kind: "assistant_ia_op", module: "ASSISTANT_IA", title: "Envoyer par le Gmail d'Adam", summary: "x", payload: {} } });
    const obs = [projeterCarte({ id: i.id, titre: "Envoyer par le Gmail d'Adam", statut: "PROPOSED", mails: [{ expediteur: "adam@x.dz (Gmail d'Adam)", a: ["Radia <r@x.dz>"], objet: "Compte rendu de ta tournée de l'Est", texte: "Bonjour Radia,\n\nPeux-tu m'envoyer le compte rendu avant vendredi ?\n\nBien cordialement,", html: "<table><tr><th style=\"background:#087084\">x</th></tr></table>" }] })];
    const tours = [{ role: "user" as const, content: "Envoie un mail à Radia" }, { role: "assistant" as const, content: "La carte attend votre confirmation.", observations: JSON.parse(JSON.stringify(obs)) }];
    let h = await historiqueObserve(moi, tours);
    expect(h[1]!.content).toMatch(/^La carte attend votre confirmation\.\n\n\[Observé par le serveur/);
    expect(h[1]!.content).toContain("état : proposée — attend la confirmation de la personne");
    expect(h[1]!.content).toContain("objet : Compte rendu de ta tournée de l'Est");
    expect(h[1]!.content).toContain("Bien cordialement,");
    expect(h[1]!.content).not.toMatch(/<table|<th/);
    expect(h[0]!.content).toBe("Envoie un mail à Radia");
    // La personne annule : le tour suivant le VOIT, sans détecter la contestation.
    await prisma.assistantActionIntent.update({ where: { id: i.id }, data: { status: "CANCELLED" } });
    h = await historiqueObserve(moi, tours);
    expect(h[1]!.content).toContain("état : annulée — rien n'a été exécuté");
    // La carte d'un AUTRE n'est pas relue sous sa portée : « retirée », jamais son statut réel.
    const lui = await historiqueObserve(autre, tours);
    expect(lui[1]!.content).toContain("état : retirée");
  });

  it("un fichier disparu le dit (plus de lien) ; interrupteur `ADAM_OBSERVATION_HISTORIQUE=0` : le texte seul", async () => {
    const tours = [{ role: "assistant" as const, content: "Fichier prêt.", observations: [projeterFichier({ id: "ckinexistant0000000000000", nom: "salaries.xlsx", existe: true, lignes: 14 })] }];
    const h = await historiqueObserve(moi, tours);
    expect(h[0]!.content).toContain("état : introuvable");
    expect(h[0]!.content).not.toContain("/api/drive/");
    process.env.ADAM_OBSERVATION_HISTORIQUE = "0";
    try {
      expect((await historiqueObserve(moi, tours))[0]!.content).toBe("Fichier prêt.");
    } finally { delete process.env.ADAM_OBSERVATION_HISTORIQUE; }
  });
});
