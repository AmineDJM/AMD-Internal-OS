import { describe, expect, it } from "vitest";
import { regrouperFile, type ElementFile } from "./aujourdhui";
import { affinerFile, compterUrgences } from "./file-affinee";

/**
 * LA FILE « À FAIRE MAINTENANT » AFFINÉE (recette du 23/11/2026) — urgence, domaine, plus récent d'abord.
 * Les lots se RECOMPOSENT sur les lignes gardées : un titre « dont 1 en retard » ne survit pas à un filtre
 * qui a retiré cette ligne.
 */
const NOW = new Date("2026-11-23T10:00:00Z");
const jours = (n: number) => new Date(NOW.getTime() + n * 86_400_000).toISOString();

function el(over: Partial<ElementFile> & { key: string }): ElementFile {
  return {
    objet: `TASK:${over.key}`, title: over.key, subtitle: "", module: "Mes tâches", href: `/t/${over.key}`, kind: "task",
    deadline: null, depuis: null, owner: "", statusLabel: null, ...over,
  };
}

const ELEMENTS: ElementFile[] = [
  el({ key: "retard", deadline: jours(-3), depuis: jours(-10) }),
  el({ key: "demain", deadline: jours(1), depuis: jours(-1) }),
  el({ key: "prioritaire", priority: "HIGH", depuis: jours(-5) }),
  el({ key: "tranquille", deadline: jours(20), depuis: jours(-2) }),
  el({ key: "neuf", depuis: jours(0) }),
];

describe("la file affinée", () => {
  const lots = regrouperFile(ELEMENTS, NOW);

  it("chaque ligne porte son niveau d'urgence, lu sur l'échéance et la priorité", () => {
    const parCle = new Map(lots.flatMap((l) => l.lignes).map((l) => [l.key, l.urgence]));
    expect(parCle.get("retard")).toBe("retard");
    expect(parCle.get("demain")).toBe("urgent");
    expect(parCle.get("prioritaire")).toBe("urgent");
    expect(parCle.get("tranquille")).toBe("normal");
    expect(compterUrgences(lots)).toEqual({ retard: 1, urgent: 2, normal: 2 });
  });

  it("le filtre « Urgent » ne garde que les lignes urgentes — et le lot se recompte", () => {
    const urgents = affinerFile(lots, { urgence: "urgent", chapeau: null, tri: "urgence" });
    const lignes = urgents.flatMap((l) => l.lignes.map((x) => x.key));
    expect(lignes.sort()).toEqual(["demain", "prioritaire"]);
    expect(urgents.every((l) => l.enRetard === 0)).toBe(true);
    expect(urgents.reduce((s, l) => s + l.n, 0)).toBe(2);
  });

  it("« Plus récent » met en tête ce qui vient d'arriver", () => {
    const recents = affinerFile(lots, { urgence: null, chapeau: null, tri: "recent" });
    expect(recents[0].lignes[0].key).toBe("neuf");
  });

  it("un domaine inconnu ne garde rien — et le filtre vide rend la file entière", () => {
    expect(affinerFile(lots, { urgence: null, chapeau: "Nulle part", tri: "urgence" })).toEqual([]);
    expect(affinerFile(lots, { urgence: null, chapeau: null, tri: "urgence" }).reduce((s, l) => s + l.n, 0)).toBe(5);
  });
});
