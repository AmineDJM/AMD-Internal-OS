import { describe, expect, it } from "vitest";
import { champDuManque, champsACompleter } from "./a-completer";

const schema = { type: "object", properties: {
  institution: { type: "string", description: "Institution / association bénéficiaire." },
  type: { type: "string", description: "Type d'événement : staff, webinaire, congrès, journée ou autre.", enum: ["staff", "webinaire", "congres", "journee", "autre"] },
  dateDebut: { type: "string", description: "Date de début (AAAA-MM-JJ)." },
  titre: { type: "string", description: "Titre ou campagne de la demande." },
} };

describe("P1 bis — le champ que désigne une phrase de « manque »", () => {
  it("retrouve le champ par ses mots, avec ses choix et son type", () => {
    expect(champDuManque(schema, "l'institution ou l'association bénéficiaire")?.nom).toBe("institution");
    expect(champDuManque(schema, "le type d'événement : staff, webinaire, congrès, journée ou autre")).toMatchObject({ nom: "type", valeurs: ["staff", "webinaire", "congres", "journee", "autre"] });
    expect(champDuManque(schema, "la date de début du congrès, année comprise")).toMatchObject({ nom: "dateDebut", type: "date" });
    expect(champDuManque(schema, "le titre ou la campagne")?.nom).toBe("titre");
  });
  it("une phrase sans champ retrouvé : pas de carte à compléter (on ne devine pas)", () => {
    expect(champDuManque(schema, "zzzz")).toBeNull();
    expect(champsACompleter(schema, ["l'institution bénéficiaire", "zzzz"])).toBeNull();
  });
  it("AP-05 : les noms de champ courts (« fin », « nom ») se retrouvent — l'événement montre sa carte à compléter", () => {
    const ev = { type: "object", properties: {
      nom: { type: "string" }, portee: { type: "string", enum: ["national", "international"] },
      debut: { type: "string", description: "AAAA-MM-JJ" }, fin: { type: "string", description: "AAAA-MM-JJ" },
      medecins: { type: "string", description: "Médecins concernés (noms)." }, produits: { type: "string" },
    } };
    const c = champsACompleter(ev, ["le nom de l'événement", "la portée : nationale ou internationale", "la date de fin", "le ou les médecins concernés", "le ou les produits concernés"]);
    expect(c?.map((x) => x.nom)).toEqual(["nom", "portee", "fin", "medecins", "produits"]);
    expect(c?.find((x) => x.nom === "fin")?.type).toBe("date");
  });
});
