import { afterEach, describe, expect, it } from "vitest";
import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import { JournalDuTour } from "./journal";
import { observationDeMission } from "../missions/pilotage";
import { observationsDuTour } from "./historique";

/**
 * I1 (décision 0063) — le journal du tour, alimenté par l'ENVELOPPE des outils : la carte devient sa projection (étape 2),
 * les observations déclarées sont reprises et retirées de ce que lit le modèle, un échec n'est pas une preuve.
 */
const moi = { id: "u1" } as CurrentUser;
const outil = (name: string, run: PowerTool["run"]): PowerTool => ({ def: { name, description: "", input_schema: { type: "object", properties: {} } } as PowerTool["def"], allowed: () => true, label: name, run });

afterEach(() => { delete process.env.ADAM_OBSERVATION; });

describe("I1 — le journal du tour", () => {
  it("une carte préparée : la sortie rendue au modèle EST sa projection (mail tel qu'il partira) — passée par la garde", async () => {
    const j = new JournalDuTour((s) => s.replace("radia@x.dz", "⟦S1⟧"));
    const prep = outil("envoyer_mail", async () => {
      j.propositions.push({ intentId: "i1", proposition: { kind: "assistant_ia_op", title: "Envoyer par le Gmail d'Adam", fields: [], warnings: ["Fenêtre d'annulation : 30 s"], mails: [{ expediteur: "adam@x.dz (Gmail d'Adam)", a: ["Radia <radia@x.dz>"], objet: "Réunion", texte: "Bonjour Radia,\n\nJeudi 15 h.", html: null }] } });
      return JSON.stringify({ statut: "EN_ATTENTE_DE_CONFIRMATION", consigne: "Ne dis jamais que c'est fait." });
    });
    const sortie = JSON.parse(await j.envelopper(prep).run({}, moi));
    expect(sortie.statut).toBe("EN_ATTENTE_DE_CONFIRMATION");
    expect(sortie.consigne).toBeUndefined();
    expect(sortie.observation).toMatch(/carte \(id i1\) — état : proposée — attend la confirmation/);
    expect(sortie.observation).toMatch(/expéditeur : adam@x\.dz \(Gmail d'Adam\) ; à : Radia <⟦S1⟧> ; objet : Réunion ; rendu : texte brut/);
    expect(j.observations()).toHaveLength(1);
    expect(j.observations()[0]!.projection.a).toEqual(["Radia <radia@x.dz>"]);
  });

  it("un outil appelé DANS un autre n'est observé qu'une fois, au niveau le plus haut ; une enveloppe ne s'enveloppe pas", async () => {
    const j = new JournalDuTour();
    const interne = j.envelopper(outil("envoyer_gmail", async () => { j.propositions.push({ intentId: "i2", proposition: { kind: "k", title: "Envoyer", fields: [] } }); return "{}"; }));
    const externe = j.envelopper(outil("envoyer_mail", async (e, u) => { await interne.run(e, u); j.propositions[0]!.proposition.title = "Envoyer par l'envoi de l'ERP"; return "{}"; }));
    expect(j.envelopper(externe)).toBe(externe);
    await externe.run({}, moi);
    expect(j.observations().map((o) => o.projection.titre)).toEqual(["Envoyer par l'envoi de l'ERP"]);
  });

  it("observations déclarées (`_observations`) reprises puis retirées ; lecture tabulaire et fichier observés ; échec non prouvé", async () => {
    const j = new JournalDuTour();
    const m = observationDeMission({ id: "m1", titre: "Veille", objectif: "", etat: "EN_COURS", libelle: "En cours", etapes: { faites: 0, total: 2, enEchec: 0 }, coutUsd: 0, plafondUsd: null, parentId: null, majLe: new Date().toISOString(), diagnostic: { code: "PRETE", phrase: "prête" } });
    const missions = j.envelopper(outil("mes_missions", async () => JSON.stringify({ missions: [{ id: "m1", titre: "Veille" }], total: 1, _observations: [m] })), { prouve: true });
    const sortie = JSON.parse(await missions.run({}, moi));
    expect(sortie._observations).toBeUndefined();
    expect(j.sorties).toHaveLength(1);
    await j.envelopper(outil("exporter", async () => JSON.stringify({ statut: "FAIT", nom: "salaries.xlsx", lien: "/api/drive/ckfichier12345/raw" }))).run({}, moi);
    await j.envelopper(outil("piloter_mission", async () => JSON.stringify({ statut: "REFUS", raison: "x" }))).run({}, moi);
    const natures = j.observations().map((o) => `${o.nature}:${o.objet.id}`);
    expect(natures).toEqual(expect.arrayContaining(["mission:m1", "lecture:mes_missions", "fichier:ckfichier12345"]));
    expect(j.observations().find((o) => o.nature === "mission")!.objet.lien).toBe("/missions/m1");
    expect(j.reussis(["mes_missions", "piloter_mission", "exporter"])).toEqual(["mes_missions", "exporter"]);
  });

  it("interrupteur `ADAM_OBSERVATION=0` : la sortie d'origine, aucune observation", async () => {
    process.env.ADAM_OBSERVATION = "0";
    const j = new JournalDuTour();
    const prep = outil("x", async () => { j.propositions.push({ intentId: "i3", proposition: { kind: "k", title: "T", fields: [] } }); return '{"statut":"EN_ATTENTE_DE_CONFIRMATION","titre":"T"}'; });
    expect(await j.envelopper(prep).run({}, moi)).toBe('{"statut":"EN_ATTENTE_DE_CONFIRMATION","titre":"T"}');
    expect(j.observations()).toEqual([]);
  });

  it("un tour d'avant I1 est observé par sa carte et ses blocs stockés", () => {
    const obs = observationsDuTour({ intent: { id: "i9", title: "Rendez-vous", status: "PROPOSED", fields: [{ label: "Avec", value: "Dr X" }] }, blocs: [{ kind: "table", title: "3 missions", columns: [{ key: "t", label: "Titre" }], rows: [{ id: "m1" }, { id: "m2" }, { id: "m3" }] }] });
    expect(obs.map((o) => o.nature)).toEqual(["carte", "lecture"]);
    expect(obs[1]!.projection).toMatchObject({ titre: "tableau affiché « 3 missions »", lignes: 3, colonnes: ["Titre"], ids: ["m1", "m2", "m3"] });
    expect(observationsDuTour({ observations: [], intent: { id: "i9", title: "x" } })).toEqual([]);
  });
});
