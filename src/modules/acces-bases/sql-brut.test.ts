import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * D3 (décision 0057) — LE CLIQUET DU SQL ÉCRIT À LA MAIN. La garde de l'accès par base vit dans le relais `prisma` et
 * juge les requêtes PAR MODÈLE ; un `$queryRaw` / `$executeRaw` passe à côté. Mesuré au 02/11/2026 : 81 fichiers de
 * production en contiennent, dont 47 qui nomment une table d'une base MÉTIER (liste ci-dessous, avec ses bases).
 *
 * La liste ne fait que RÉTRÉCIR :
 *   • un fichier NEUF qui touche une base métier en SQL brut fait échouer la suite — passer par le modèle Prisma
 *     (la garde le voit) ; si le SQL est indispensable (recherche plein texte, agrégat lourd), l'ajouter ICI, avec ses
 *     bases, dans le même commit, et le dire dans la revue ;
 *   • un fichier qui touche une base de PLUS qu'à la mesure fait échouer la suite (même remède) ;
 *   • un fichier qui ne touche plus aucune base métier SORT de la liste (permission morte).
 * Une table est « nommée » quand son nom apparaît entre guillemets doubles (`"PayrollEntry"`), forme obligée du SQL
 * PostgreSQL pour un nom en casse mixte.
 */
const DETTE_SQL_BRUT: Record<string, readonly string[]> = {
  "src/lib/actions/department-budget-actions.ts": ["societes"],
  "src/lib/actions/petty-cash-actions.ts": ["societes"],
  "src/lib/actions/promo-circuit-actions.ts": ["materiel-promo"],
  "src/lib/actions/promo-devis-actions.ts": ["materiel-promo"],
  "src/lib/actions/validation-actions.ts": ["travail"],
  "src/lib/adoption.ts": ["communication", "pilotage", "travail"],
  "src/lib/adventum/risks.ts": ["stocks"],
  "src/lib/budget-marketing/integration-serveur.ts": ["ad-pro", "info-medicale", "materiel-promo", "personnel"],
  "src/lib/budget-marketing/rapprochement-serveur.ts": ["communication", "documents"],
  "src/lib/budget/suppression-garde.ts": ["budgets"],
  "src/lib/drive-storage.ts": ["documents"],
  "src/lib/drive/usage.ts": ["documents"],
  "src/lib/effets/annulation.ts": ["communication", "documents", "site-web"],
  "src/lib/effets/capture.ts": ["documents"],
  "src/lib/fabric/entites.ts": ["annuaires", "personnel", "reglementaire", "terrain"],
  "src/lib/fabric/registry.ts": ["documents", "finances", "juridique", "personnel", "reglementaire", "travail"],
  "src/lib/fabric/text-search.ts": ["documents"],
  "src/lib/pch/lecture-ao.ts": ["ventes"],
  "src/lib/pieces-lues/devis-poste-lecture.ts": ["annuaires"],
  "src/lib/pieces-lues/lecture-fichier.ts": ["documents"],
  "src/lib/pieces-lues/service.ts": ["documents"],
  "src/lib/promo-material/retrait-devis.ts": ["materiel-promo"],
  "src/lib/promo-stock-comptages.ts": ["materiel-promo"],
  "src/lib/promo/stock-ecriture.ts": ["materiel-promo"],
  "src/lib/queries/messaging.ts": ["communication"],
  "src/lib/queries/search-everything.ts": ["finances", "juridique", "terrain"],
  "src/lib/references/registre-serveur.ts": ["documents"],
  "src/lib/refs.ts": ["documents"],
  "src/lib/regulatory/intelligence/corpus/rag.ts": ["reglementaire"],
  "src/lib/regulatory/intelligence/knowledge/dossier-knowledge.ts": ["reglementaire"],
  "src/lib/regulatory/intelligence/reserves/library.ts": ["reglementaire"],
  "src/lib/sandbox/sql.ts": ["ad-pro", "annuaires", "budgets", "communication", "developpement", "documents", "finances", "juridique", "personnel", "pilotage", "produits", "reglementaire", "societes", "terrain", "travail", "ventes"],
  "src/lib/secretariat/devis-natif-serveur.ts": ["juridique"],
  "src/lib/site-web/audience.ts": ["site-web"],
  "src/modules/ad-pro/actions-postes-voyageurs.ts": ["ad-pro"],
  "src/modules/ad-pro/infra/prise-en-charge/engagement.ts": ["ad-pro"],
  "src/modules/assistant-ia/infra/depot-dossier.ts": ["documents"],
  "src/modules/assistant-ia/infra/testing/audit/taches/dossiers-mg-adpro.ts": ["travail"],
  "src/modules/bibliotheque/infra/ingestion.ts": ["documents"],
  "src/modules/bibliotheque/infra/inscription.ts": ["documents"],
  "src/modules/bibliotheque/infra/rattrapage.ts": ["communication", "documents", "personnel", "pilotage", "terrain", "travail"],
  "src/modules/bibliotheque/infra/recherche.ts": ["documents"],
  "src/modules/referentiels/infra/personnes/fusion.ts": ["documents"],
  "src/platform/ia/artifact/factory/demande.ts": ["documents"],
  "src/platform/ia/artifact/factory/emission.ts": ["juridique"],
  "src/platform/ia/artifact/factory/numerotation.ts": ["documents"],
  "src/platform/in-process/intelligence/index.ts": ["finances", "juridique", "reglementaire"],
};

const RACINE = process.cwd();
const catalogue = JSON.parse(fs.readFileSync(path.join(RACINE, "docs/architecture/bases-de-donnees.json"), "utf8")) as {
  bases: { cle: string; nature: string; tables: { modele: string }[] }[];
};
const VERS_BASE = new Map(catalogue.bases.filter((b) => b.nature === "metier").flatMap((b) => b.tables.map((t) => [t.modele, b.cle] as const)));

function fichiers(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) fichiers(p, out);
    else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) out.push(path.relative(RACINE, p).split(path.sep).join("/"));
  }
  return out;
}

const mesure = new Map<string, string[]>();
for (const f of fichiers(path.join(RACINE, "src"))) {
  const s = fs.readFileSync(f, "utf8");
  if (!/\$(queryRaw|executeRaw)(Unsafe)?/.test(s)) continue;
  const bases = [...new Set([...s.matchAll(/"([A-Z]\w+)"/g)].map((m) => VERS_BASE.get(m[1])).filter((b): b is string => !!b))].sort();
  if (bases.length) mesure.set(f, bases);
}

describe("le SQL brut qui touche une base métier — la liste ne fait que rétrécir", () => {
  it("aucun fichier neuf, aucune base de plus", () => {
    const fautes: string[] = [];
    for (const [f, bases] of mesure) {
      const permis = DETTE_SQL_BRUT[f];
      if (!permis) fautes.push(`${f} : SQL brut sur ${bases.join(", ")} — passer par le modèle Prisma (la garde le voit), ou le déclarer ici`);
      else for (const b of bases) if (!permis.includes(b)) fautes.push(`${f} : touche aussi « ${b} » en SQL brut`);
    }
    expect(fautes).toEqual([]);
  });

  it("un fichier sorti du SQL brut sort de la liste (et une base qui n'est plus touchée aussi)", () => {
    const mortes: string[] = [];
    for (const [f, bases] of Object.entries(DETTE_SQL_BRUT)) {
      const vues = mesure.get(f);
      if (!vues) mortes.push(f);
      else for (const b of bases) if (!vues.includes(b)) mortes.push(`${f} → ${b}`);
    }
    expect(mortes, "retirer ces entrées de DETTE_SQL_BRUT").toEqual([]);
  });
});
