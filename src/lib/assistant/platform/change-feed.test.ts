import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";
import { emit } from "@/platform/events";
import { resetBus } from "@/platform/event-bus";
import { startChangeFeed, recentChanges, feedHealth, resetChangeFeed } from "./change-feed";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA CHAÎNE COMPLÈTE — l'ERP annonce, Adam sait.
 *
 * Ce fichier vérifie les deux moitiés du circuit événementiel :
 *
 *   • FONCTIONNELLE — un fait publié à la frontière arrive dans la projection d'Adam, sans
 *     que ni l'un ni l'autre ne se connaisse ;
 *   • STRUCTURELLE — les actions métier instrumentées le RESTENT. Un `emit` retiré au détour
 *     d'un correctif rendrait Adam sourd sur ce domaine, en silence : rien ne casserait, il
 *     cesserait simplement de savoir. C'est le genre de régression qu'aucun test fonctionnel
 *     ne rattrape, parce qu'il n'y a pas d'erreur à observer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

beforeEach(() => {
  resetChangeFeed();
  resetBus();
  startChangeFeed();
});

describe("l'ERP annonce, Adam sait — sans que l'un connaisse l'autre", () => {
  it("un fait publié atteint la projection", () => {
    emit({
      type: "hr.employee-added",
      subject: { type: "employee", id: "emp-1" },
      actorId: "u-pdg",
      data: { fullName: "Raihana Bensalem", department: "Réglementaire" },
    });

    const changes = recentChanges();
    expect(changes).toHaveLength(1);
    expect(changes[0].type).toBe("hr.employee-added");
    expect(changes[0].subjectId).toBe("emp-1");
    expect(changes[0].label).toBe("Raihana Bensalem");
    expect(changes[0].actorId).toBe("u-pdg");
  });

  it("le plus RÉCENT vient en premier — c'est l'ordre de la question posée", () => {
    emit({ type: "hr.employee-added", subject: { type: "employee", id: "a" } });
    emit({ type: "regulatory.owner-changed", subject: { type: "regulatory_product", id: "b" } });
    expect(recentChanges().map((c) => c.subjectId)).toEqual(["b", "a"]);
  });

  it("on peut ne demander qu'un type de sujet", () => {
    emit({ type: "hr.employee-added", subject: { type: "employee", id: "a" } });
    emit({ type: "regulatory.owner-changed", subject: { type: "regulatory_product", id: "b" } });
    emit({ type: "mail.sent", subject: { type: "outbound_mail", id: "c" } });

    const reg = recentChanges({ subjectTypes: ["regulatory_product"] });
    expect(reg.map((c) => c.subjectId)).toEqual(["b"]);
  });

  it("on peut demander « depuis la dernière fois »", () => {
    emit({ type: "hr.employee-added", subject: { type: "employee", id: "a" } });
    const marque = feedHealth().lastSeq;
    emit({ type: "hr.employee-added", subject: { type: "employee", id: "b" } });

    expect(recentChanges({ sinceSeq: marque }).map((c) => c.subjectId)).toEqual(["b"]);
  });

  it("la projection ne stocke PAS l'entité — seulement de quoi savoir qu'il faut relire", () => {
    // C'est la règle qui l'empêche de devenir « une seconde base ERP concurrente ». On vérifie
    // qu'un champ sensible glissé dans la charge utile ne se retrouve pas dans le flux.
    emit({
      type: "hr.employee-added",
      subject: { type: "employee", id: "emp-2" },
      data: { fullName: "Khaled Meziane", salaireBrut: 480000, iban: "DZ59..." },
    });
    const entry = recentChanges()[0];
    expect(Object.keys(entry)).toEqual(
      expect.arrayContaining(["type", "subjectType", "subjectId", "at", "seq", "actorId", "label"]),
    );
    expect(JSON.stringify(entry)).not.toContain("480000");
    expect(JSON.stringify(entry)).not.toContain("DZ59");
  });

  it("brancher deux fois ne double pas les changements", () => {
    startChangeFeed();
    startChangeFeed();
    emit({ type: "mail.sent", subject: { type: "outbound_mail", id: "m" } });
    expect(recentChanges()).toHaveLength(1);
  });

  it("« vide » et « je ne sais pas » ne se confondent pas", () => {
    // Un flux non démarré qui répondrait « rien n'a changé » ferait annoncer une entreprise au
    // calme plat le jour où le bus n'a pas démarré. L'état est donc lisible.
    resetChangeFeed();
    expect(feedHealth().started).toBe(false);
    expect(feedHealth().entries).toBe(0);

    startChangeFeed();
    expect(feedHealth().started).toBe(true);
    expect(feedHealth().entries).toBe(0); // démarré ET vide : là, « rien n'a changé » est vrai
  });

  it("la mémoire est bornée — pas de fuite sur un long processus", () => {
    for (let i = 0; i < 500; i += 1) {
      emit({ type: "hr.employee-added", subject: { type: "employee", id: String(i) } });
    }
    expect(feedHealth().entries).toBeLessThanOrEqual(300);
  });
});

describe("les actions métier instrumentées le RESTENT", () => {
  // Un `emit` retiré ne casse rien : Adam devient juste sourd, en silence. D'où ce contrôle
  // structurel — le même esprit que le ratchet de parité des actions.
  const INSTRUMENTED: [string, string][] = [
    ["src/modules/rh/actions.ts", "hr.employee-added"],
    ["src/lib/actions/regulatory-actions.ts", "regulatory.owner-changed"],
    ["src/lib/comms/outbound.ts", "mail.sent"],
  ];

  it.each(INSTRUMENTED)("%s annonce toujours « %s »", (file, type) => {
    const src = fs.readFileSync(file, "utf8");
    expect(src, `${file} doit importer la frontière`).toContain('from "@/platform/events"');
    expect(src, `${file} doit publier « ${type} »`).toContain(`"${type}"`);
  });
});
