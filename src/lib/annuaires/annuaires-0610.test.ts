import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ANNUAIRES_TABS } from "@/lib/labels";
import { peutAnnuaire, ANNUAIRES_ACCORDABLES, LECTURE_POUR_TOUS, type FaitsAnnuaire } from "./acces";

/**
 * ANNUAIRES (Direction, 06/10) — Spécialités : une seule porte (les Annuaires depuis le 07/10) ; « Autres annuaires » retiré ;
 * Fournisseurs Regulatory et Partenaires publics deviennent des annuaires à part entière ; l'annuaire des personnes
 * permet d'ajouter, modifier et retirer ; un message supprimé ne s'aperçoit plus dans la liste des conversations.
 */

const code = (rel: string) => readFileSync(rel, "utf8");
const faits = (modules: Record<string, string[]>): FaitsAnnuaire => ({
  peut: (m, g) => (modules[m] ?? []).includes(g), sections: new Set(), tientPersonnesParRole: false,
});

describe("onglets des Annuaires", () => {
  it("Spécialités revenues (07/10, porte unique), plus d'Autres annuaires ; Partenaires publics et Fournisseurs Regulatory présents", () => {
    const hrefs = ANNUAIRES_TABS.map((t) => t.href);
    expect(hrefs).toContain("/annuaires/specialites");
    expect(ANNUAIRES_TABS.find((t) => t.href === "/annuaires/specialites")?.regle).toBe("specialites");
    expect(hrefs).not.toContain("/annuaires/autres");
    expect(hrefs).toContain("/annuaires/partenaires-publics");
    expect(hrefs).toContain("/annuaires/fournisseurs");
    expect(code("src/app/(app)/annuaires/autres/page.tsx")).toContain('redirect("/annuaires/fournisseurs")');
  });
});

describe("droits des nouveaux annuaires", () => {
  it("Partenaires publics : lus par tous, écrits par les Moyens généraux — comme les partenaires", () => {
    expect(ANNUAIRES_ACCORDABLES).toContain("PARTENAIRES_PUBLICS");
    expect(LECTURE_POUR_TOUS.has("PARTENAIRES_PUBLICS")).toBe(true);
    expect(peutAnnuaire(faits({ WORKSPACE: ["VIEW"] }), "PARTENAIRES_PUBLICS", "VIEW")).toBe(true);
    expect(peutAnnuaire(faits({ WORKSPACE: ["VIEW"] }), "PARTENAIRES_PUBLICS", "CREATE")).toBe(false);
    expect(peutAnnuaire(faits({ GENERAL_MEANS: ["CREATE"] }), "PARTENAIRES_PUBLICS", "CREATE")).toBe(true);
  });
  it("Fournisseurs Regulatory : le module Regulatory les lit et les tient", () => {
    expect(peutAnnuaire(faits({ REGULATORY: ["VIEW"] }), "FOURNISSEURS", "VIEW")).toBe(true);
    expect(peutAnnuaire(faits({ REGULATORY: ["VIEW"] }), "FOURNISSEURS", "UPDATE")).toBe(false);
    expect(peutAnnuaire(faits({ WORKSPACE: ["VIEW"] }), "FOURNISSEURS", "VIEW")).toBe(false);
  });
  it("un contact public se crée, se corrige et se retire sous le droit de SON annuaire", () => {
    const a = code("src/lib/actions/company-contact-actions.ts");
    expect(a.match(/peutAnnuaire\(user, annuaireDe\(/g)?.length).toBe(3);
    expect(a).toContain('"/annuaires/partenaires-publics"');
  });
  it("un fournisseur qui porte des dossiers se désactive, il ne se supprime pas", () => {
    const a = code("src/lib/actions/fournisseurs-annuaire-actions.ts");
    expect(a).toContain("s._count.products + s._count.users > 0");
    expect(a).toContain('fdCase(fd, "active")');
  });
});

describe("annuaire des personnes : ajouter, modifier, retirer", () => {
  it("les gestes existent, et revalident AUSSI l'onglet du module Annuaires", () => {
    const a = code("src/lib/actions/directory-actions.ts");
    expect(a).toContain("export async function updateDirectoryEndpoint");
    expect(a).toContain('"/annuaires/personnes"');
    expect(a).not.toContain("revalidatePath(PATH)");
    const ecran = code("src/app/(app)/mon-espace/annuaire/people-directory.tsx");
    for (const geste of ["addDirectoryEndpoint", "updateDirectoryEndpoint", "deactivateDirectoryEndpoint", "updateDirectoryEntry", "rafraichir()"]) expect(ecran).toContain(geste);
  });
});

describe("messagerie : un message supprimé ne s'aperçoit plus", () => {
  it("l'aperçu de la liste des conversations ignore les messages supprimés, et se relit après une suppression", () => {
    // Lu en SQL depuis l'audit performance (PERF-01) : les N derniers par conversation (N = 1 pour l'aperçu,
    // PERF-08), jamais un supprimé.
    const messagerie = code("src/lib/queries/messaging.ts");
    expect(messagerie).toMatch(/m\."deletedAt" IS NULL\s*ORDER BY m\."createdAt" DESC\s*LIMIT \$\{Math\.floor\(n\)\}/);
    expect(messagerie).toMatch(/derniersMessagesParConversation\(conversationIds, 1\)/);
    expect(code("src/app/(app)/messages/messenger.tsx")).toContain("deleteMessage(f).then(() => { pollThread(); refreshSync(); });");
  });
});
