import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS } from "@/lib/ad-pro/unified";
import { DELETE_REGISTRY, DELETABLE_KINDS } from "@/lib/admin-delete-registry";

/** Un cliquet juge le CODE, pas la prose qui le décrit (§118.79d, §118.88, §118.112b). */
function code(p: string): string {
  return readFileSync(p, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

const FENETRE = "src/components/shared/super-admin-delete.tsx";

/**
 * L'ÉCRAN DE LA SUPPRESSION (§118.162) — ce qui part avec la demande se lit AVANT le clic, et la
 * suppression existe sur TOUTES les fiches du pôle. Le banc en base prouve le lot ; celui-ci prouve
 * que l'écran y MÈNE : une suppression parfaite que rien n'affiche est du code mort (§118.50).
 */
describe("Écran — la fenêtre de confirmation lit l'aperçu", () => {
  it("elle appelle l'aperçu à l'ouverture, et le bouton ne s'arme ni pendant la lecture ni sur un refus", () => {
    const src = code(FENETRE);
    // L'aperçu est injectable (le banc d'écran le remplace) ; son défaut EST l'action canonique.
    expect(src).toMatch(/apercuer = apercuDeSuppression/);
    expect(src).toContain("apercuer(fd)");
    const arme = src.match(/const armable = ([^;]+);/)?.[1] ?? "";
    expect(arme, "le bouton doit attendre la lecture").toContain("!enLecture");
    expect(arme, "un refus doit désarmer le bouton — pas un geste offert puis retiré (§118.83)").toContain("!refus");
    expect(arme).toContain("!introuvable");
    expect(src).toMatch(/disabled=\{!armable\}/);
  });

  it("elle ne promet la perte des lignes en cascade QUE hors d'un lot", () => {
    const src = code(FENETRE);
    const i = src.indexOf("Les lignes liées supprimées en cascade, elles, ne reviennent pas.");
    expect(i, "la phrase existe pour les éléments hors lot").toBeGreaterThan(-1);
    expect(src.slice(Math.max(0, i - 60), i), "elle est conditionnée à l'absence de lot").toMatch(/!lu\.lot/);
  });

  it("elle dit ce qui part AVEC l'élément, et que tout cela revient avec lui", () => {
    const src = code(FENETRE);
    expect(src).toContain("apercu.emporte.map");
    expect(src).toContain("Tout cela revient avec lui");
  });

  it("elle dit aussi ce qui RESTE mais perd son lien — un projet supprimé déclasse ses dossiers (§118.163)", () => {
    const src = code(FENETRE);
    expect(src).toContain("apercu.detache.map");
    // « Rien d'autre n'en dépend » ne doit pas mentir quand seul un lien se vide.
    expect(src).toMatch(/apercu\.emporte\.length === 0 && apercu\.detache\.length === 0/);
  });
});

describe("Écran — un projet se supprime depuis « Projets », par la même fenêtre et la corbeille (§118.163)", () => {
  it("le bouton monte la fenêtre commune avec l'action du module, et seulement pour qui a le droit", () => {
    const bouton = code("src/app/(app)/business-development/projets/supprimer-projet.tsx");
    expect(bouton).toMatch(/<ConfirmationSuppression[\s\S]{0,300}kind="BD_PROJECT"[\s\S]{0,200}executer=\{deleteBdProject\}/);
    const page = code("src/app/(app)/business-development/projets/page.tsx");
    expect(page).toMatch(/\{canDelete && <SupprimerProjet /);
    expect(page).toContain('userCan(user, "BD_PROJECTS", "DELETE")');
  });

  it("l'action passe par le cœur réversible — plus de `delete` sec qui perd gammes et classement", () => {
    const src = code("src/lib/actions/bd-project-actions.ts");
    const i = src.indexOf("export async function deleteBdProject");
    const corps = src.slice(i, i + 900);
    expect(corps).toContain('supprimerReversible("BD_PROJECT"');
    expect(corps).not.toMatch(/prisma\.bdProject\.delete\(/);
  });
});

describe("Écran — un événement se supprime par la même fenêtre, plus par un window.confirm", () => {
  it("la fiche d'un événement monte la fenêtre commune avec l'action du module", () => {
    const src = code("src/app/(app)/events/event-form.tsx");
    expect(src).not.toContain("window.confirm(");
    expect(src).toMatch(/<ConfirmationSuppression[\s\S]{0,300}kind="EVENT"[\s\S]{0,200}executer=\{deleteEvent\}/);
  });

  it("l'action du module passe par le cœur réversible — plus de suppression sèche", () => {
    const src = code("src/lib/actions/event-actions.ts");
    const corps = src.slice(src.indexOf("export async function deleteEvent"), src.indexOf("export async function deleteEvent") + 900);
    expect(corps).toContain('supprimerReversible("EVENT"');
    expect(corps).not.toMatch(/prisma\.event\.delete\(/);
  });
});

describe("Écran — toute fiche du pôle Ad & Pro offre la suppression (Super Admin, directeur des opérations, directrice marketing)", () => {
  it("les sept fiches montent le bouton, avec LEUR type au registre ET la porte de l'action (§118.175)", () => {
    for (const nature of AD_PRO_KINDS) {
      const type = AD_PRO_ENTITY_TYPE[nature.kind];
      const kind = DELETABLE_KINDS.find((k) => DELETE_REGISTRY[k].entityType === type);
      expect(kind, `${nature.kind} doit être au registre`).toBeDefined();
      const src = code(`src/app/(app)${nature.href}/[id]/page.tsx`);
      // Le bouton s'arme sur la MÊME règle que l'action qui supprime : armé sur le seul rôle Super
      // Admin, il resterait caché au directeur des opérations que l'action accepte (§118.83).
      // La porte se lit en ligne, ou une fois dans une constante que le bouton reçoit (la fiche du matériel promotionnel
      // la relit pour décider d'afficher son menu « ⋯ », 07/10) — la règle reste celle de l'action.
      const enLigne = new RegExp(`<SupprimerDemandeAdPro[^>]*kind="${kind}"[^>]*enabled=\\{await peutSupprimerUneDemandeAdPro\\(user, "${kind}"`);
      const parConstante = new RegExp(`const (\\w+) = await peutSupprimerUneDemandeAdPro\\(user, "${kind}"[\\s\\S]*<SupprimerDemandeAdPro[^>]*kind="${kind}"[^>]*enabled=\\{\\1\\}`);
      expect(enLigne.test(src) || parConstante.test(src), `${nature.href}/[id] doit monter le bouton de suppression`).toBe(true);
    }
  });
});

describe("Adam — la carte ne promet plus une perte que le lot n'inflige pas", () => {
  it("delete_record et restore_record lisent le lot avant de parler de cascade", () => {
    const src = code("src/lib/assistant.ts");
    expect(src).toContain("apercuSuppression(rawKind, target.id)");
    const i = src.indexOf("Les lignes liées supprimées en cascade (enfants du schéma) ne sont PAS restaurables.");
    expect(src.slice(Math.max(0, i - 200), i), "la réserve de cascade n'est dite que hors lot").toMatch(/apercu\.lot/);
    const j = src.indexOf("Les éléments liés qui avaient été supprimés en cascade ne reviennent pas.");
    expect(src.slice(Math.max(0, j - 200), j), "à la restauration aussi").toMatch(/lot\s*\?/);
  });

  it("la carte dit, comme la fenêtre, ce qui perd son lien", () => {
    const src = code("src/lib/assistant.ts");
    expect(src).toMatch(/label: "Perd son lien", value: apercu\.detache\.join/);
  });

  it("la carte de suppression d'un événement ne dit plus « aucun retour possible »", () => {
    // Les ops de la vague 5 vivent dans `ops/impl/vague5/` ; la carte d'un événement, dans `evenements.ts`.
    const src = code("src/lib/assistant/ops/impl/vague5/evenements.ts");
    const vague = ["evenements", "ad-pro", "consulting", "commun"].map((f) => code(`src/lib/assistant/ops/impl/vague5/${f}.ts`)).join("\n");
    expect(vague).not.toContain("aucun retour possible");
    expect(src).toContain('apercuSuppression("EVENT", hit.id)');
  });
});
