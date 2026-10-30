import { describe, it, expect } from "vitest";
import { DIRECT_INTENTS, directIntent, intentArgs, intentFor, intentPhrase } from "@/platform/ia/workspace/direct-intents";
import { RESOLVER_WRITE_NAMES } from "@/lib/assistant";
import { composeWorkspace } from "./compose";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RACCOURCI QUI SAUTE LE MODÈLE — et les trois choses qu'il ne saute PAS.
 *
 * Ce fichier tient la promesse de §23 par des assertions, pas par une intention : le registre
 * est fermé, il ne contient aucune mutation, et un `intent` inconnu ne devient jamais un bouton.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

describe("le registre des gestes directs — fermé, et en LECTURE seule", () => {
  it("ne contient AUCUNE mutation", () => {
    // C'est l'invariant de sûreté du chantier : un clic ne doit jamais contourner la
    // proposition, la carte de confirmation, l'action canonique et l'audit.
    for (const [nom, def] of Object.entries(DIRECT_INTENTS)) {
      expect(RESOLVER_WRITE_NAMES.has(def.tool), `${nom} → ${def.tool}`).toBe(false);
    }
  });

  it("déclare au moins un argument par geste — sinon le bouton ne désigne rien", () => {
    for (const [nom, def] of Object.entries(DIRECT_INTENTS)) {
      expect(def.args.length, nom).toBeGreaterThan(0);
      expect(def.phrase, nom).toContain("%s");
    }
  });

  it("refuse une capacité inconnue", () => {
    expect(directIntent("delete_record")).toBeNull();
    expect(directIntent("story.open")).not.toBeNull();
    // Et surtout : pas de traversée par le prototype. `toString` n'est pas une capacité.
    expect(directIntent("toString")).toBeNull();
    expect(directIntent("constructor")).toBeNull();
  });
});

describe("les arguments — filtrés à ce qui est déclaré", () => {
  const def = directIntent("product.economics")!;

  it("écarte un argument que la capacité n'attend pas", () => {
    const args = intentArgs(def, { produit: "PRD-014", sql: "DROP TABLE", limit: "9999" });
    expect(args).toEqual({ produit: "PRD-014" });
  });

  it("écarte le vide et borne la longueur", () => {
    expect(intentArgs(def, { produit: "   " })).toEqual({});
    expect(intentArgs(def, { produit: "x".repeat(500) }).produit).toHaveLength(200);
  });

  it("la phrase vient du REGISTRE, pas du client", () => {
    expect(intentPhrase(def, { produit: "PRD-014" })).toBe("Économie du produit PRD-014");
  });
});

describe("le constructeur — une faute de frappe ne produit pas un bouton mort", () => {
  it("une capacité inexistante ne COMPILE pas — la garde est dans le type", () => {
    // @ts-expect-error — c'est exactement ce qu'on vérifie : le nom n'existe pas au registre,
    // et TypeScript le refuse ici, à l'écriture, plutôt qu'au clic six écrans plus loin.
    const ko = intentFor("produit.economie", { produit: "PRD-014" });
    // Et si quelqu'un force le passage, la construction rend `null` plutôt qu'un bouton mort.
    expect(ko).toBeNull();
  });

  it("rend null quand aucun argument déclaré n'est fourni", () => {
    expect(intentFor("product.economics", { marche: "AO-2025-014" })).toBeNull();
  });

  it("construit l'intention quand tout est là", () => {
    expect(intentFor("pch.status", { marche: "AO-2025-014" })).toEqual({
      capability: "pch.status",
      args: { marche: "AO-2025-014" },
    });
  });
});

describe("la relecture d'un bloc — l'intention traverse, ou disparaît proprement", () => {
  const bloc = (action: unknown) => {
    const c = composeWorkspace("inspect_record", JSON.stringify({
      _blocs: [{
        kind: "table", title: "T",
        columns: [{ key: "a", label: "A" }],
        rows: [{ a: "1", actions: [action] }],
      }],
      id: "x",
    }));
    const b = c?.blocks[0];
    return b?.kind === "table" ? b.rows[0].actions?.[0] : undefined;
  };

  it("garde l'intention déclarée", () => {
    const a = bloc({
      libelle: "Économie", phrase: "Économie du produit PRD-014",
      intent: { capability: "product.economics", args: { produit: "PRD-014" } },
    });
    expect(a?.intent).toEqual({ capability: "product.economics", args: { produit: "PRD-014" } });
  });

  it("retire une intention inconnue MAIS garde le bouton — le repli est la conversation", () => {
    const a = bloc({
      libelle: "Supprimer", phrase: "Supprime le dossier REG-1",
      intent: { capability: "delete_record", args: { id: "REG-1" } },
    });
    expect(a?.libelle).toBe("Supprimer");
    expect(a?.phrase).toBe("Supprime le dossier REG-1");
    expect(a?.intent).toBeUndefined();
  });

  it("retire une intention sans argument utilisable", () => {
    const a = bloc({
      libelle: "Voir", phrase: "Voir",
      intent: { capability: "product.economics", args: { produit: "" } },
    });
    expect(a?.intent).toBeUndefined();
  });
});
