import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { MODULES, getAccess, userCan, type SessionUser } from "@/lib/rbac";
import { MODULE_LABELS, NAVIGATION, ANNUAIRES_TABS, MEDICAL_TABS, ADMIN_REQUEST_TYPE } from "@/lib/labels";
import { REQUEST_TYPES, fieldLabels } from "@/lib/admin-requests";
import { SERVICE_DU_MODULE } from "@/lib/assistant/context/modules-domaines";
import { visibleTabs } from "@/lib/nav-tabs";
import { prisma } from "@/lib/prisma";

/**
 * ═══════════════════════════════════════════════════════════
 * LE MODULE « ANNUAIRES » — une porte dans le pôle Administration, gardée onglet par onglet.
 *
 * Décision de la Direction (09/2026) : « un module à part dans Administration nommé Annuaires
 * qui contiendra tous les annuaires ». Ce banc tient ce que le code PROMET :
 *   - le module existe, se nomme, entre dans le pôle Administration ;
 *   - chaque onglet porte le module de SON référentiel — c'est lui qui décide de l'affichage ;
 *   - la porte est accordée à tout le monde, et n'ouvre rien de plus que les modules déjà tenus ;
 *   - les écrans d'origine et le concentrateur lisent les MÊMES chargeurs (point d'appel, §118.49).
 * ═══════════════════════════════════════════════════════════
 */

const lire = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

describe("Annuaires — le module et son entrée de menu", () => {
  it("DIRECTORIES est un module déclaré, nommé « Annuaires »", () => {
    expect(MODULES).toContain("DIRECTORIES");
    expect(MODULE_LABELS.DIRECTORIES).toBe("Annuaires");
    expect(SERVICE_DU_MODULE.DIRECTORIES.domaines).toContain("DIRECTORY");
  });

  it("l'entrée de menu vit dans le pôle ADMINISTRATION, avec ses onglets", () => {
    const entree = NAVIGATION.find((n) => n.module === "DIRECTORIES");
    expect(entree).toBeDefined();
    expect(entree?.group).toBe("Pôles");
    expect(entree?.pole).toBe("ADMINISTRATION");
    expect(entree?.href).toBe("/annuaires");
    expect(entree?.tabs).toBe(ANNUAIRES_TABS);
  });

  it("chaque onglet porte le module de SON référentiel — jamais la porte « Annuaires » seule", () => {
    const parLabel = Object.fromEntries(ANNUAIRES_TABS.map((t) => [t.label, t.module]));
    expect(parLabel["Médecins"]).toBe("MEDICAL");
    expect(parLabel["Pharmaciens"]).toBe("MEDICAL");
    expect(parLabel["Établissements"]).toBe("MEDICAL");
    expect(parLabel["Partenaires"]).toBe("WORKSPACE");
    expect(parLabel["Personnes"]).toBe("WORKSPACE");
    // Un onglet « Médecins » gardé par DIRECTORIES s'afficherait à qui n'a pas la Promotion
    // médicale : la fuite par le menu que ce test existe pour empêcher.
    for (const t of ANNUAIRES_TABS) if (/Médecins|Pharmaciens|Établissements/.test(t.label)) expect(t.module).not.toBe("DIRECTORIES");
    // Et chaque onglet a sa page.
    for (const t of ANNUAIRES_TABS) {
      expect(() => lire(`src/app/(app)${t.href}/page.tsx`), `page manquante pour ${t.href}`).not.toThrow();
    }
  });
});

/**
 * L'ONGLET ÉTABLISSEMENTS DE PROMOTION MÉDICALE A ÉTÉ RETIRÉ (décision de la Direction, 09/2026
 * — §118.138) : « on les crée et on les gère depuis les Annuaires ». Il n'y a donc plus DEUX
 * portes vers ce référentiel, mais UNE — et sa paire a quitté la liste ci-dessous. Le cas
 * dédié, plus bas, vérifie que l'ancienne adresse redirige au lieu de disparaître.
 */
describe("Annuaires — les deux portes lisent le même chargeur (point d'appel, §118.49)", () => {
  const cas: [string, string, string][] = [
    ["src/app/(app)/medical/annuaire/page.tsx", "src/app/(app)/annuaires/feuille-praticiens.tsx", "chargerFeuillePraticiens"],
    ["src/app/(app)/mon-espace/annuaire/page.tsx", "src/app/(app)/annuaires/partenaires/page.tsx", "chargerPartenaires"],
    ["src/app/(app)/mon-espace/annuaire/page.tsx", "src/app/(app)/annuaires/personnes/page.tsx", "chargerPersonnes"],
  ];
  for (const [origine, hub, chargeur] of cas) {
    it(`${chargeur} : importé par l'écran d'origine ET par le concentrateur, et aucun des deux ne relit Prisma`, () => {
      for (const f of [origine, hub]) {
        const src = lire(f);
        expect(src, `${f} doit importer ${chargeur} depuis lib/queries/annuaires`).toMatch(new RegExp(`\\b${chargeur}\\b[\\s\\S]*from "@/lib/queries/annuaires"`));
        // Un écran qui rechargerait lui-même l'annuaire ferait une seconde lecture qui diverge.
        expect(src.includes("prisma."), `${f} ne doit plus lire Prisma directement`).toBe(false);
      }
    });
  }

  it("le chargeur ne remonte pas vers l'application : ses types viennent du socle", () => {
    const src = lire("src/lib/queries/annuaires.ts");
    expect(src).not.toMatch(/from "@\/app\//);
  });
});

let dbOk = false;
try { await prisma.$queryRaw`SELECT 1`; dbOk = true; } catch { dbOk = false; }
const suite = dbOk ? describe : describe.skip;

suite("Annuaires — la porte est ouverte à tous, et n'ouvre rien de plus", () => {
  const acteur = async (role: string): Promise<SessionUser> =>
    ({ id: `__annuaires__${role}`, role, secondaryRole: null, access: await getAccess(`__annuaires__${role}`, role as never) } as unknown as SessionUser);

  it("un simple VIEWER passe la porte, voit Partenaires et Personnes, pas les onglets médicaux", async () => {
    const lecteur = await acteur("VIEWER");
    expect(userCan(lecteur, "DIRECTORIES", "VIEW")).toBe(true);
    expect(userCan(lecteur, "MEDICAL", "VIEW")).toBe(false);
    const tabs = await visibleTabs(lecteur, ANNUAIRES_TABS);
    const visibles = tabs.filter((t) => t.show).map((t) => t.label);
    expect(visibles).toContain("Partenaires");
    expect(visibles).toContain("Personnes");
    expect(visibles).not.toContain("Médecins");
    expect(visibles).not.toContain("Établissements");
  });

  it("un délégué médical voit les onglets médicaux — la porte suit le module, pas l'inverse", async () => {
    const kam = await acteur("MEDICAL_DELEGATE");
    const tabs = await visibleTabs(kam, ANNUAIRES_TABS);
    const visibles = tabs.filter((t) => t.show).map((t) => t.label);
    expect(visibles).toEqual(expect.arrayContaining(["Médecins", "Pharmaciens", "Établissements", "Partenaires", "Personnes"]));
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE RÉFÉRENTIEL DES ÉTABLISSEMENTS N'A PLUS QU'UN ÉCRAN (§118.138).
 *
 * « Dans Promotion médicale, enlève l'onglet des établissements, vu qu'on les crée et qu'on les
 * gère depuis les Annuaires. » Chaque cas nomme ce qui le ferait tomber (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("Établissements — un seul écran, et l'ancienne adresse REDIRIGE", () => {
  it("l'onglet a quitté Promotion médicale, et il reste dans les Annuaires", () => {
    // Ce qui le ferait tomber : le laisser dans `MEDICAL_TABS`. La Direction aurait demandé de
    // retirer une porte et on en aurait gardé deux.
    expect(MEDICAL_TABS.map((t) => t.label)).not.toContain("Établissements");
    expect(ANNUAIRES_TABS.map((t) => t.label), "l'écran qui RESTE").toContain("Établissements");
  });

  it("`/medical/etablissements` REDIRIGE — les liens déjà envoyés restent valides", () => {
    // Ce qui le ferait tomber : supprimer la page. Les notifications, favoris et liens collés
    // en conversation tomberaient sur un 404, pour un écran qui existe deux dossiers plus loin.
    const src = lire("src/app/(app)/medical/etablissements/page.tsx");
    expect(src).toMatch(/redirect\("\/annuaires\/etablissements"\)/);
    // LA GARDE RESTE POSÉE AVANT la redirection : sans elle, cette route serait un
    // contournement de la porte qu'elle remplace.
    expect(src, "la porte MEDICAL est vérifiée avant de rediriger").toMatch(/requireModule\("MEDICAL"\)[\s\S]*redirect\(/);
  });

  it("les liens d'Adam pointent vers l'écran QUI EXISTE, pas vers la redirection", () => {
    // Un lien vers une redirection marche, mais il fait payer un aller-retour à chaque clic et
    // il devient faux le jour où la redirection disparaît.
    // La vague 4b vit dans `ops/impl/vague4b/` ; `impl-wave4b.ts` n'en est plus que la porte.
    const vague4b = ["commun", "erp", "medical", "medical-fiches", "medical-annuaires", "gammes", "etudes-presentations"]
      .map((m) => `src/lib/assistant/ops/impl/vague4b/${m}.ts`);
    for (const f of ["src/lib/assistant/ops/impl-wave4b.ts", ...vague4b, "src/lib/assistant/executive-read-tools.ts"]) {
      const src = lire(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src, `${f} ne doit plus lier /medical/etablissements`).not.toContain('"/medical/etablissements"');
    }
  });
});

/**
 * LES DEMANDES RH ONT QUITTÉ LE BUREAU DU SECRÉTARIAT (§118.138) — la porte d'ENTRÉE, pas
 * l'historique.
 */
describe("Bureau du secrétariat — plus de « Demande RH »", () => {
  it("le catalogue de création ne la propose plus", () => {
    // Une absence, un justificatif, une information RH se demandent dans le module RH, qui a
    // ses circuits, ses pièces et ses droits.
    expect(REQUEST_TYPES.map((t) => t.value)).not.toContain("HR_SIMPLE");
  });

  it("les chemins d'ÉCRITURE la refusent — écran ET conversation", () => {
    // §118.71 : retirer la carte sans fermer l'action laisserait une porte ouverte à côté de la
    // porte fermée, et Adam continuerait d'en créer.
    // `assistant.ts` est découpé (lot V4) : sa porte ET chacun de ses morceaux sont relus.
    const assistant = ["src/lib/assistant.ts", ...["coeur", "outils", "propositions", "actions-confirmees", "boucle"].flatMap((d) =>
      readdirSync(join(process.cwd(), "src/lib/assistant", d)).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")).map((n) => `src/lib/assistant/${d}/${n}`))];
    for (const f of ["src/lib/actions/admin-request-actions.ts", ...assistant]) {
      const src = lire(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
      expect(src, `${f} ne doit plus accepter HR_SIMPLE en création`).not.toContain('"HR_SIMPLE"');
    }
  });

  it("MAIS le LIBELLÉ survit — les demandes déjà posées la portent", () => {
    // Ce qui le ferait tomber : retirer l'entrée de `ADMIN_REQUEST_TYPE`. La fiche d'une
    // demande d'archive afficherait « HR_SIMPLE » en clair. On ferme une porte, on ne réécrit
    // pas l'histoire.
    expect(ADMIN_REQUEST_TYPE.HR_SIMPLE).toBe("Demande RH");
    expect(Object.keys(fieldLabels("HR_SIMPLE")).length, "et ses champs restent lisibles").toBeGreaterThan(0);
  });
});
